'use strict';

const express = require('express');
const QRCode = require('qrcode');
const invoices = require('../../domain/invoices');
const reports = require('../../domain/reports');
const { enqueue } = require('../../webhooks/deliver');

/**
 * API v1 — permukaan yang dipakai aplikasi klien (soal, review, ...).
 *
 * Setiap rute dibatasi pada req.client: satu aplikasi tidak akan pernah melihat
 * invoice milik aplikasi lain sekalipun menebak ID-nya.
 */
function buildV1Routes({ pool, runtime }) {
  const registry = () => runtime.registry;
  const config = () => runtime.config;
  const router = express.Router();

  /** Membuat invoice. Idempoten terhadap order_id milik klien. */
  router.post('/invoices', async (req, res, next) => {
    try {
      const { order_id: orderId, amount, provider: providerId, callback_url: callbackUrl, metadata } = req.body || {};
      if (!orderId || typeof orderId !== 'string') {
        return res.status(400).json({ success: false, errors: [{ message: 'order_id wajib diisi' }] });
      }
      const provider = providerId ? registry().get(providerId) : registry().default();

      const { invoice, created } = await invoices.createInvoice(pool, {
        client: req.client, orderId, amount: Number(amount), provider,
        callbackUrl, metadata: metadata || {},
        expiryMs: config().invoice.expiryMs, unique: config().invoice,
      });

      res.status(created ? 201 : 200).json({ success: true, data: { invoice: present(invoice) } });
    } catch (err) { next(err); }
  });

  router.get('/invoices/:id', async (req, res, next) => {
    try {
      const invoice = await invoices.findById(pool, req.client.id, req.params.id);
      if (!invoice) return res.status(404).json({ success: false, errors: [{ message: 'Invoice tidak ditemukan' }] });
      res.json({ success: true, data: { invoice: present(invoice) } });
    } catch (err) { next(err); }
  });

  /** Pencarian dengan order_id sendiri — klien tidak perlu menyimpan ID kami. */
  router.get('/invoices/by-order/:orderId', async (req, res, next) => {
    try {
      const invoice = await invoices.findByOrderId(pool, req.client.id, req.params.orderId);
      if (!invoice) return res.status(404).json({ success: false, errors: [{ message: 'Invoice tidak ditemukan' }] });
      res.json({ success: true, data: { invoice: present(invoice) } });
    } catch (err) { next(err); }
  });

  router.get('/invoices', async (req, res, next) => {
    try {
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const status = req.query.status || null;
      const { rows } = await pool.query(
        `SELECT * FROM invoices
         WHERE client_id = $1 AND ($2::text IS NULL OR status = $2)
         ORDER BY created_at DESC LIMIT $3`,
        [req.client.id, status, limit]
      );
      res.json({ success: true, data: { invoices: rows.map(present) } });
    } catch (err) { next(err); }
  });

  /** QR sebagai PNG, agar klien tidak perlu me-render EMVCo sendiri. */
  router.get('/invoices/:id/qr.png', async (req, res, next) => {
    try {
      const invoice = await invoices.findById(pool, req.client.id, req.params.id);
      if (!invoice || !invoice.qris_payload) {
        return res.status(404).json({ success: false, errors: [{ message: 'QRIS tidak tersedia untuk invoice ini' }] });
      }
      const png = await QRCode.toBuffer(invoice.qris_payload, { width: 512, margin: 1 });
      res.type('png').set('cache-control', 'no-store').send(png);
    } catch (err) { next(err); }
  });

  /** Mengirim ulang webhook — untuk memulihkan endpoint klien yang sempat mati. */
  router.post('/invoices/:id/replay-webhook', async (req, res, next) => {
    try {
      const invoice = await invoices.findById(pool, req.client.id, req.params.id);
      if (!invoice) return res.status(404).json({ success: false, errors: [{ message: 'Invoice tidak ditemukan' }] });
      const url = invoice.callback_url || req.client.callback_url;
      if (!url) return res.status(400).json({ success: false, errors: [{ message: 'Tidak ada callback_url' }] });
      const delivery = await enqueue(pool, { invoiceId: invoice.id, url, event: `invoice.${invoice.status.toLowerCase()}` });
      res.status(202).json({ success: true, data: { delivery_id: delivery.id } });
    } catch (err) { next(err); }
  });

  /** Laporan pemasukan milik klien sendiri. */
  router.get('/reports/revenue', async (req, res, next) => {
    try {
      const { from, to } = req.query;
      const [summary, daily, status] = await Promise.all([
        reports.revenueForClient(pool, req.client.id, { from, to }),
        reports.revenueDaily(pool, { clientId: req.client.id, from, to }),
        reports.statusBreakdown(pool, req.client.id),
      ]);
      res.json({ success: true, data: { summary, daily, status } });
    } catch (err) { next(err); }
  });

  return router;
}

/**
 * Bentuk invoice yang dikirim keluar.
 *
 * Kolom internal seperti merchant_reference sengaja tidak diekspos, dan nominal
 * dikembalikan sebagai angka — bukan string bawaan driver Postgres untuk BIGINT.
 */
function present(row) {
  return {
    id: row.id,
    order_id: row.order_id,
    provider: row.provider,
    status: row.status,
    base_amount: Number(row.base_amount),
    unique_code: Number(row.unique_code),
    payable_amount: Number(row.payable_amount),
    currency: row.currency,
    qris_payload: row.qris_payload,
    payment_url: row.metadata?.payment_url ?? null,
    created_at: row.created_at,
    expires_at: row.expires_at,
    paid_at: row.paid_at,
  };
}

module.exports = { buildV1Routes, present };
