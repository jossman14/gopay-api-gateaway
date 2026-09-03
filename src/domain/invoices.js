'use strict';

const crypto = require('crypto');
const { withTransaction } = require('../db/pool');

const PENDING_AMOUNT_CONFLICT = 'invoices_pending_amount_key';
const CLIENT_ORDER_CONFLICT = 'invoices_client_order_key';

/**
 * Pembuatan dan pelunasan invoice.
 *
 * Semua invarian uang bersandar pada constraint database, bukan pemeriksaan di
 * kode. Memeriksa lebih dulu lalu menulis akan membuka jendela balapan antara
 * pemeriksaan dan penulisan — dengan uang, jendela itu berarti dobel kredit.
 */

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString('hex')}`;
}

/**
 * Membuat invoice, idempoten terhadap (client_id, order_id).
 *
 * Memanggil ulang dengan order_id yang sama mengembalikan invoice yang sudah
 * ada alih-alih membuat tagihan kedua — itu yang membuat percobaan ulang klien
 * akibat timeout jaringan tetap aman.
 */
async function createInvoice(pool, { client, orderId, amount, provider, callbackUrl, metadata = {}, expiryMs, unique }) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw Object.assign(new Error('amount harus bilangan bulat positif'), { statusCode: 400 });
  }

  const existing = await findByOrderId(pool, client.id, orderId);
  if (existing) return { invoice: existing, created: false };

  const needsUnique = provider.needsUniqueAmount && unique.useUniqueAmount;
  const expiresAt = new Date(Date.now() + expiryMs).toISOString();

  // Tanpa nominal unik, satu percobaan cukup. Dengan nominal unik, setiap
  // kandidat dicoba sampai database menerima salah satunya — itu menghindarkan
  // "baca daftar nominal aktif lalu pilih" yang rawan balapan.
  const candidates = needsUnique
    ? range(unique.uniqueMin, unique.uniqueMax)
    : [0];

  let lastConflict = null;
  for (const code of candidates) {
    const id = newId('inv');
    const reference = `PAY-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    try {
      const charge = await provider.createCharge({
        orderId, amount: amount + code, reference,
        metadata, customer: metadata.customer,
      });

      const { rows } = await pool.query(
        `INSERT INTO invoices
           (id, client_id, order_id, provider, merchant_reference, base_amount, unique_code,
            payable_amount, status, qris_payload, callback_url, metadata, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [id, client.id, orderId, provider.constructor.id, reference, amount, code,
         amount + code, charge.status || 'PENDING', charge.qrisPayload,
         callbackUrl || client.callback_url || null,
         JSON.stringify({ ...metadata, provider_raw_id: charge.providerTransactionId ?? null,
                          payment_url: charge.paymentUrl ?? null }),
         expiresAt]
      );

      const invoice = rows[0];
      if (charge.providerTransactionId) {
        await pool.query(
          `INSERT INTO provider_transactions (provider, provider_transaction_id, invoice_id, amount, raw)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (provider, provider_transaction_id) DO NOTHING`,
          [provider.constructor.id, charge.providerTransactionId, invoice.id, amount + code,
           JSON.stringify(charge.raw ?? {})]
        );
      }
      return { invoice, created: true };
    } catch (err) {
      if (err.code === '23505' && String(err.constraint) === PENDING_AMOUNT_CONFLICT) {
        lastConflict = err;
        continue; // nominal ini sedang dipakai invoice PENDING lain; coba berikutnya
      }
      if (err.code === '23505' && String(err.constraint) === CLIENT_ORDER_CONFLICT) {
        // Dua permintaan bersamaan untuk order yang sama; yang kalah membaca hasil pemenang.
        const winner = await findByOrderId(pool, client.id, orderId);
        if (winner) return { invoice: winner, created: false };
      }
      throw err;
    }
  }

  throw Object.assign(
    new Error('Semua kode nominal unik sedang dipakai; coba lagi setelah ada invoice yang kedaluwarsa'),
    { statusCode: 409, cause: lastConflict }
  );
}

function range(min, max) {
  const out = [];
  for (let i = min; i <= max; i++) out.push(i);
  return out;
}

async function findByOrderId(pool, clientId, orderId) {
  const { rows } = await pool.query(
    'SELECT * FROM invoices WHERE client_id = $1 AND order_id = $2', [clientId, orderId]
  );
  return rows[0] || null;
}

async function findById(pool, clientId, id) {
  const { rows } = await pool.query(
    'SELECT * FROM invoices WHERE id = $1 AND client_id = $2', [id, clientId]
  );
  return rows[0] || null;
}

/**
 * Menandai invoice lunas dan mengklaim mutasi provider — dalam satu transaksi.
 *
 * Klaim memakai INSERT dengan primary key (provider, provider_transaction_id).
 * Bila mutasi sudah pernah dipakai, INSERT gagal dan seluruh transaksi batal,
 * sehingga satu pembayaran tidak mungkin melunasi dua invoice sekalipun ada
 * dua worker berjalan bersamaan.
 */
async function markPaid(pool, { invoiceId, provider, transaction, amountSource = 'RAW' }) {
  return withTransaction(pool, async (client) => {
    const claim = await client.query(
      `INSERT INTO provider_transactions
         (provider, provider_transaction_id, invoice_id, amount, amount_source, transaction_time, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (provider, provider_transaction_id) DO NOTHING
       RETURNING provider_transaction_id`,
      [provider, transaction.providerTransactionId, invoiceId, transaction.amount ?? 0,
       amountSource, transaction.transactionTime || null, JSON.stringify(transaction.raw ?? {})]
    );
    if (claim.rowCount === 0) return null; // sudah diklaim invoice lain

    const { rows } = await client.query(
      `UPDATE invoices SET status = 'PAID', paid_at = now()
       WHERE id = $1 AND status = 'PENDING'
       RETURNING *`,
      [invoiceId]
    );
    if (rows.length === 0) {
      // Invoice sudah tidak PENDING (kedaluwarsa atau lunas duluan). Batalkan
      // klaim agar mutasi tetap tersedia untuk invoice yang benar.
      throw Object.assign(new Error('Invoice tidak lagi PENDING'), { rollbackClaim: true });
    }
    return rows[0];
  }).catch((err) => {
    if (err.rollbackClaim) return null;
    throw err;
  });
}

/** Menandai invoice PENDING yang lewat waktu sebagai EXPIRED. */
async function expireOverdue(pool) {
  const { rowCount } = await pool.query(
    `UPDATE invoices SET status = 'EXPIRED'
     WHERE status = 'PENDING' AND expires_at <= now()`
  );
  return rowCount;
}

async function listPending(pool, provider) {
  const { rows } = await pool.query(
    `SELECT * FROM invoices
     WHERE status = 'PENDING' AND provider = $1 AND expires_at > now()
     ORDER BY created_at`,
    [provider]
  );
  return rows;
}

module.exports = {
  createInvoice, findByOrderId, findById, markPaid, expireOverdue, listPending, newId,
};
