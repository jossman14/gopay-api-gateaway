'use strict';

const express = require('express');
const invoices = require('../../domain/invoices');
const { enqueue } = require('../../webhooks/deliver');

/**
 * Webhook MASUK dari provider pembayaran.
 *
 * Ini yang membuat jalur resmi jauh lebih baik daripada polling: pelunasan
 * diberitahukan, bukan ditemukan. Setiap kiriman diverifikasi dulu — endpoint
 * ini publik, jadi tanpa verifikasi siapa pun bisa menandai invoice lunas.
 */
function buildWebhookRoutes({ pool, runtime, log = () => {} }) {
  const registry = () => runtime.registry;
  const router = express.Router();

  /** GoBiz: notifikasi transaksi pembayaran. */
  router.post('/gobiz', async (req, res, next) => {
    try {
      if (!registry().has('gobiz')) return res.status(404).json({ success: false });
      const provider = registry().get('gobiz');
      const body = req.body || {};
      const trxId = body?.body?.transaction?.id ?? body?.transaction?.id ?? null;
      if (!trxId) return res.status(400).json({ success: false, errors: [{ message: 'transaction id tidak ada' }] });

      // Status TIDAK diambil dari payload. Payload hanya dipakai sebagai sinyal;
      // kebenarannya ditanyakan langsung ke GoBiz agar pemalsuan tidak berguna.
      const charge = await provider.getCharge(trxId);
      if (charge.status !== 'PAID') return res.json({ success: true, data: { ignored: charge.status } });

      const { rows } = await pool.query(
        `SELECT i.* FROM invoices i
         JOIN provider_transactions pt ON pt.invoice_id = i.id
         WHERE pt.provider = 'gobiz' AND pt.provider_transaction_id = $1`, [trxId]
      );
      const invoice = rows[0];
      if (!invoice) return res.status(404).json({ success: false, errors: [{ message: 'Invoice tidak dikenal' }] });

      const paid = await invoices.markPaid(pool, {
        invoiceId: invoice.id, provider: 'gobiz',
        transaction: { providerTransactionId: trxId, amount: charge.amount,
                       transactionTime: charge.settledAt, raw: charge.raw },
      });
      if (paid) {
        log(`gobiz: invoice ${paid.id} lunas`);
        const url = paid.callback_url;
        if (url) await enqueue(pool, { invoiceId: paid.id, url, event: 'invoice.paid' });
      }
      res.json({ success: true, data: { invoice_id: invoice.id, paid: Boolean(paid) } });
    } catch (err) { next(err); }
  });

  /** Mayar: notifikasi invoice. Diverifikasi lewat X-Callback-Token. */
  router.post('/mayar', async (req, res, next) => {
    try {
      if (!registry().has('mayar')) return res.status(404).json({ success: false });
      const provider = registry().get('mayar');
      if (!provider.verifyWebhook(req.headers)) {
        return res.status(401).json({ success: false, errors: [{ message: 'Token callback tidak valid' }] });
      }
      const trxId = req.body?.data?.id ?? req.body?.id ?? null;
      if (!trxId) return res.status(400).json({ success: false, errors: [{ message: 'id transaksi tidak ada' }] });

      const charge = await provider.getCharge(trxId);
      if (charge.status !== 'PAID') return res.json({ success: true, data: { ignored: charge.status } });

      const { rows } = await pool.query(
        `SELECT i.* FROM invoices i
         JOIN provider_transactions pt ON pt.invoice_id = i.id
         WHERE pt.provider = 'mayar' AND pt.provider_transaction_id = $1`, [trxId]
      );
      const invoice = rows[0];
      if (!invoice) return res.status(404).json({ success: false, errors: [{ message: 'Invoice tidak dikenal' }] });

      const paid = await invoices.markPaid(pool, {
        invoiceId: invoice.id, provider: 'mayar',
        transaction: { providerTransactionId: trxId, amount: charge.amount, raw: charge.raw },
      });
      if (paid && paid.callback_url) {
        await enqueue(pool, { invoiceId: paid.id, url: paid.callback_url, event: 'invoice.paid' });
      }
      res.json({ success: true, data: { invoice_id: invoice.id, paid: Boolean(paid) } });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { buildWebhookRoutes };
