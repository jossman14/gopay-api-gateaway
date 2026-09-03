'use strict';
/**
 * Uji integrasi terhadap PostgreSQL asli.
 *
 * Invarian uang di sistem ini ditegakkan constraint database, jadi menguji
 * dengan store tiruan tidak membuktikan apa pun. Dilewati bila TEST_DATABASE_URL
 * tidak diisi, supaya `npm test` tetap jalan tanpa database.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');

const URL = process.env.TEST_DATABASE_URL;
if (!URL) {
  console.log('# TEST_DATABASE_URL kosong — uji integrasi dilewati');
} else {
  const { Pool } = require('pg');
  const { migrate } = require('../src/db/migrate');
  const invoices = require('../src/domain/invoices');
  const clients = require('../src/domain/clients');
  const reports = require('../src/domain/reports');

  const pool = new Pool({ connectionString: URL });
  const CFG = { useUniqueAmount: true, uniqueMin: 1, uniqueMax: 5 };

  /** Provider tiruan: tidak menyentuh jaringan, tapi bersikap seperti gopay. */
  const fakeGopay = {
    constructor: { id: 'gopay' },
    needsUniqueAmount: true,
    supportsWebhook: false,
    async createCharge({ amount, reference }) {
      return { providerTransactionId: null, qrisPayload: `QRIS:${amount}:${reference}`, status: 'PENDING', raw: {} };
    },
  };

  describe('ledger invoice', () => {
    let client;

    before(async () => {
      await migrate(pool, () => {});
      await pool.query('DELETE FROM provider_transactions');
      await pool.query('DELETE FROM webhook_deliveries');
      await pool.query('DELETE FROM invoices');
      await pool.query("DELETE FROM clients WHERE id LIKE 'test_%'");
      const created = await clients.createClient(pool, { id: 'test_soal', name: 'Soal (uji)' });
      const { rows } = await pool.query('SELECT * FROM clients WHERE id=$1', [created.id]);
      client = rows[0];
    });

    after(async () => {
      await pool.query('DELETE FROM provider_transactions');
      await pool.query('DELETE FROM invoices');
      await pool.query("DELETE FROM clients WHERE id LIKE 'test_%'");
      await pool.end();
    });

    test('membuat invoice memberi kode nominal unik', async () => {
      const { invoice, created } = await invoices.createInvoice(pool, {
        client, orderId: 'ORD-1', amount: 10000, provider: fakeGopay,
        expiryMs: 900_000, unique: CFG,
      });
      assert.ok(created);
      assert.equal(Number(invoice.base_amount), 10000);
      assert.ok(Number(invoice.unique_code) >= 1);
      assert.equal(Number(invoice.payable_amount), 10000 + Number(invoice.unique_code));
    });

    test('order_id yang sama bersifat idempoten, bukan tagihan kedua', async () => {
      const a = await invoices.createInvoice(pool, {
        client, orderId: 'ORD-1', amount: 10000, provider: fakeGopay, expiryMs: 900_000, unique: CFG,
      });
      assert.equal(a.created, false);
      const { rows } = await pool.query('SELECT count(*) n FROM invoices WHERE order_id=$1', ['ORD-1']);
      assert.equal(Number(rows[0].n), 1);
    });

    test('nominal yang bentrok dilewati sampai ada yang bebas', async () => {
      // Nominal dasar sama; kode unik harus berbeda dari invoice pertama.
      const { invoice } = await invoices.createInvoice(pool, {
        client, orderId: 'ORD-2', amount: 10000, provider: fakeGopay, expiryMs: 900_000, unique: CFG,
      });
      const { rows } = await pool.query(
        "SELECT payable_amount FROM invoices WHERE status='PENDING' ORDER BY payable_amount"
      );
      const amounts = rows.map((r) => Number(r.payable_amount));
      assert.equal(new Set(amounts).size, amounts.length, 'nominal PENDING harus unik');
      assert.ok(Number(invoice.payable_amount) !== 0);
    });

    test('kehabisan kode unik menghasilkan 409, bukan tagihan ambigu', async () => {
      // uniqueMax=5, dua sudah terpakai; isi sisanya lalu pastikan yang berikutnya gagal.
      for (const id of ['ORD-3', 'ORD-4', 'ORD-5']) {
        await invoices.createInvoice(pool, {
          client, orderId: id, amount: 10000, provider: fakeGopay, expiryMs: 900_000, unique: CFG,
        }).catch(() => {});
      }
      await assert.rejects(
        () => invoices.createInvoice(pool, {
          client, orderId: 'ORD-6', amount: 10000, provider: fakeGopay, expiryMs: 900_000, unique: CFG,
        }),
        (err) => err.statusCode === 409
      );
    });

    test('satu mutasi provider tidak bisa melunasi dua invoice', async () => {
      const { rows } = await pool.query("SELECT * FROM invoices WHERE status='PENDING' ORDER BY created_at LIMIT 2");
      assert.equal(rows.length, 2, 'butuh dua invoice PENDING');
      const tx = { providerTransactionId: 'TX-DOUBLE', amount: Number(rows[0].payable_amount), raw: {} };

      const first = await invoices.markPaid(pool, { invoiceId: rows[0].id, provider: 'gopay', transaction: tx });
      assert.ok(first, 'invoice pertama harus lunas');
      assert.equal(first.status, 'PAID');

      const second = await invoices.markPaid(pool, { invoiceId: rows[1].id, provider: 'gopay', transaction: tx });
      assert.equal(second, null, 'mutasi yang sama TIDAK boleh melunasi invoice kedua');

      const check = await pool.query('SELECT status FROM invoices WHERE id=$1', [rows[1].id]);
      assert.equal(check.rows[0].status, 'PENDING');
    });

    test('invoice yang sudah lunas tidak bisa dilunasi lagi', async () => {
      const { rows } = await pool.query("SELECT * FROM invoices WHERE status='PAID' LIMIT 1");
      const again = await invoices.markPaid(pool, {
        invoiceId: rows[0].id, provider: 'gopay',
        transaction: { providerTransactionId: 'TX-OTHER', amount: 1, raw: {} },
      });
      assert.equal(again, null);
    });

    test('klien lain boleh memakai order_id yang sama', async () => {
      await clients.createClient(pool, { id: 'test_review', name: 'Review (uji)' });
      const { rows } = await pool.query('SELECT * FROM clients WHERE id=$1', ['test_review']);
      const { created } = await invoices.createInvoice(pool, {
        client: rows[0], orderId: 'ORD-1', amount: 77000, provider: fakeGopay,
        expiryMs: 900_000, unique: CFG,
      });
      assert.ok(created, 'order_id hanya unik di dalam satu klien');
    });

    test('laporan pemasukan hanya menghitung yang PAID dan terpisah per klien', async () => {
      const soal = await reports.revenueForClient(pool, 'test_soal');
      assert.equal(soal.paid_count, 1);
      assert.ok(soal.gross_amount > 10000);

      const review = await reports.revenueForClient(pool, 'test_review');
      assert.equal(review.paid_count, 0, 'review belum punya pembayaran lunas');

      const byClient = await reports.revenueByClient(pool);
      const ids = byClient.map((r) => r.client_id);
      assert.ok(ids.includes('test_soal') && ids.includes('test_review'));
    });

    test('invoice kedaluwarsa ditandai EXPIRED dan membebaskan nominalnya', async () => {
      await pool.query("UPDATE invoices SET expires_at = now() - interval '1 minute' WHERE status='PENDING'");
      const n = await invoices.expireOverdue(pool);
      assert.ok(n > 0);
      const { rows } = await pool.query("SELECT count(*) c FROM invoices WHERE status='PENDING'");
      assert.equal(Number(rows[0].c), 0);
    });
  });
}
