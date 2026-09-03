'use strict';

const { markPaid, expireOverdue, listPending } = require('./invoices');

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
    stats.errors.push(err.message);
    return stats;
  }
  stats.seen = transactions.length;

  // Indeks nominal -> invoice. Constraint database sudah menjamin tidak ada dua
  // invoice PENDING bernominal sama untuk satu provider, jadi pemetaan ini
  // tidak mungkin ambigu.
  const byAmount = new Map();
  for (const inv of pending) byAmount.set(Number(inv.payable_amount), inv);

  for (const tx of transactions) {
    // Nominal mentah dicoba lebih dulu; fallback satuan minor dicatat sumbernya
    // agar hasil pencocokan tetap bisa diaudit belakangan.
    for (let i = 0; i < tx.amountCandidates.length; i++) {
      const invoice = byAmount.get(tx.amountCandidates[i]);
      if (!invoice) continue;

      const paid = await markPaid(pool, {
        invoiceId: invoice.id,
        provider: providerId,
        transaction: { ...tx, amount: tx.amountCandidates[i] },
        amountSource: i === 0 ? 'RAW' : 'MINOR_UNIT',
      });
      if (paid) {
        stats.matched++;
        byAmount.delete(tx.amountCandidates[i]);
        log(`invoice ${invoice.id} lunas oleh mutasi ${tx.providerTransactionId}` +
            (i > 0 ? ' (nominal dibaca sebagai satuan minor)' : ''));
      }
      break;
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
