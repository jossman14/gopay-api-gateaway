'use strict';

const { markPaid, expireOverdue, listPending } = require('./invoices');
const { enqueue } = require('../webhooks/deliver');

/**
 * Worker rekonsiliasi untuk provider tanpa webhook (jalur gopay).
 *
 * Satu worker menarik mutasi untuk SELURUH invoice, bukan satu polling per
 * pembeli. Provider yang mendukung webhook (gobiz, mayar) tidak melewati jalur
 * ini sama sekali — pelunasannya dipush, jadi tidak ada yang perlu dipoll.
 */
async function reconcileOnce(pool, provider, { log = () => {} } = {}) {
  const providerId = provider.constructor.id;
  const stats = { seen: 0, matched: 0, expired: 0, errors: [] };

  stats.expired = await expireOverdue(pool);

  const pending = await listPending(pool, providerId);
  if (pending.length === 0) return stats;

  let transactions;
  try {
    transactions = await provider.listTransactions({ limit: 100 });
  } catch (err) {
    // Dicatat, bukan sekadar ditampung. Versi sebelumnya menaruhnya di
    // stats.errors dan mengembalikannya diam-diam, sehingga rekonsiliasi bisa
    // gagal tiap 20 detik tanpa satu baris pun di log — kegagalan senyap pada
    // jalur yang justru menentukan invoice mana yang dianggap lunas.
    stats.errors.push(err.message);
    log(`gagal menarik mutasi (${pending.length} invoice PENDING menunggu): ${err.message}`);
    return stats;
  }
  stats.seen = transactions.length;

  // Indeks nominal -> invoice. Constraint database menjamin tidak ada dua
  // invoice PENDING bernominal sama untuk satu provider, jadi pemetaan ini
  // tidak mungkin ambigu. Nominal mutasi sudah ditafsirkan tunggal oleh
  // provider, sehingga satu pembayaran hanya punya satu kemungkinan pasangan.
  const byAmount = new Map();
  for (const inv of pending) byAmount.set(Number(inv.payable_amount), inv);

  for (const tx of transactions) {
    const invoice = byAmount.get(tx.amount);
    if (!invoice) continue;

    const paid = await markPaid(pool, {
      invoiceId: invoice.id,
      provider: providerId,
      transaction: tx,
      amountSource: tx.amountScale === 1 ? 'RAW' : 'MINOR_UNIT',
    });
    if (!paid) continue;

    stats.matched++;
    byAmount.delete(tx.amount);
    log(`invoice ${invoice.id} lunas oleh mutasi ${tx.providerTransactionId} (Rp${tx.amount})`);

    // Tanpa ini pelunasan berhenti di database dan aplikasi klien tidak pernah
    // tahu. Jalur webhook masuk sudah melakukannya; jalur polling terlewat.
    if (paid.callback_url) {
      try {
        await enqueue(pool, { invoiceId: paid.id, url: paid.callback_url, event: 'invoice.paid' });
      } catch (err) {
        stats.errors.push(`gagal mengantrikan webhook ${paid.id}: ${err.message}`);
        log(`gagal mengantrikan webhook untuk ${paid.id}: ${err.message}`);
      }
    }
  }
  return stats;
}

/** Menjalankan rekonsiliasi berkala; mengembalikan fungsi penghenti. */
function startReconciler(pool, provider, { intervalMs, log = () => {}, onStats = () => {} }) {
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const stats = await reconcileOnce(pool, provider, { log });
      onStats(stats);
    } catch (err) {
      log(`rekonsiliasi gagal: ${err.message}`);
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };

  timer = setTimeout(tick, intervalMs);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

module.exports = { reconcileOnce, startReconciler };
