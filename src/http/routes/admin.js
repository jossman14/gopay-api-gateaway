'use strict';

const express = require('express');
const clients = require('../../domain/clients');
const reports = require('../../domain/reports');
const { reconcileOnce } = require('../../domain/reconcile');
const { present } = require('./v1');
const settings = require('../../domain/settings');

/**
 * Rute admin — pandangan master lintas seluruh aplikasi.
 *
 * Berbeda dari /v1 yang selalu dibatasi satu klien, di sini justru
 * gabungannya: siapa menghasilkan berapa, lewat provider apa.
 */
function buildAdminRoutes({ pool, runtime }) {
  const registry = () => runtime.registry;
  const config = () => runtime.config;
  const router = express.Router();

  /** Siapa yang sedang login — dipakai konsol untuk memutuskan tampilan. */
  router.get('/session', (req, res) => {
    res.json({ success: true, data: { via: req.admin?.via, email: req.admin?.email ?? null } });
  });

  router.get('/clients', async (req, res, next) => {
    try { res.json({ success: true, data: { clients: await clients.listClients(pool) } }); }
    catch (err) { next(err); }
  });

  /** Mendaftarkan aplikasi baru. apiKey hanya muncul sekali, di respons ini. */
  router.post('/clients', async (req, res, next) => {
    try {
      const { id, name, callback_url: callbackUrl } = req.body || {};
      if (!id || !name) {
        return res.status(400).json({ success: false, errors: [{ message: 'id dan name wajib diisi' }] });
      }
      const created = await clients.createClient(pool, { id, name, callbackUrl });
      res.status(201).json({
        success: true,
        data: created,
        note: 'api_key dan webhook_secret hanya ditampilkan sekali. Simpan sekarang.',
      });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ success: false, errors: [{ message: 'Klien dengan id itu sudah ada' }] });
      }
      next(err);
    }
  });

  router.post('/clients/:id/rotate-key', async (req, res, next) => {
    try {
      const out = await clients.rotateApiKey(pool, req.params.id);
      if (!out) return res.status(404).json({ success: false, errors: [{ message: 'Klien tidak ditemukan' }] });
      res.json({ success: true, data: out, note: 'Kunci lama langsung tidak berlaku.' });
    } catch (err) { next(err); }
  });

  /**
   * Seluruh invoice lintas aplikasi.
   *
   * Berbeda dari /v1/invoices yang selalu dibatasi satu klien, di sini justru
   * gabungannya — itulah gunanya pandangan master. Nama aplikasi ikut di-join
   * agar konsol tidak perlu memanggil dua kali.
   */
  router.get('/invoices', async (req, res, next) => {
    try {
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
      const status = req.query.status || null;
      const { rows } = await pool.query(
        `SELECT i.*, c.name AS client_name
         FROM invoices i JOIN clients c ON c.id = i.client_id
         WHERE ($1::text IS NULL OR i.status = $1)
         ORDER BY i.created_at DESC LIMIT $2`,
        [status, limit]
      );
      res.json({ success: true, data: { invoices: rows.map((r) => ({
        ...present(r), client_id: r.client_id, client_name: r.client_name,
      })) } });
    } catch (err) { next(err); }
  });

  /** Pandangan pemasukan gabungan — inti dari "master". */
  router.get('/reports/revenue', async (req, res, next) => {
    try {
      const { from, to } = req.query;
      const [byClient, byProvider, daily, status] = await Promise.all([
        reports.revenueByClient(pool, { from, to }),
        reports.revenueByProvider(pool, { from, to }),
        reports.revenueDaily(pool, { from, to }),
        reports.statusBreakdown(pool),
      ]);
      const total = byClient.reduce((sum, r) => sum + r.gross_amount, 0);
      res.json({ success: true, data: { total_gross_amount: total, by_client: byClient, by_provider: byProvider, daily, status } });
    } catch (err) { next(err); }
  });

  /** Memicu rekonsiliasi manual untuk provider tanpa webhook. */
  router.post('/reconcile', async (req, res, next) => {
    try {
      const id = req.body?.provider || 'gopay';
      if (!registry().has(id)) {
        return res.status(400).json({ success: false, errors: [{ message: `Provider ${id} tidak aktif` }] });
      }
      const provider = registry().get(id);
      if (provider.supportsWebhook) {
        return res.status(400).json({ success: false, errors: [{ message: `Provider ${id} memakai webhook; rekonsiliasi tidak diperlukan` }] });
      }
      res.json({ success: true, data: await reconcileOnce(pool, provider) });
    } catch (err) { next(err); }
  });

  /** Login OTP GoPay, langkah 1 — menggantikan `node login.js` yang interaktif. */
  router.post('/gopay/login/request', async (req, res, next) => {
    try {
      const provider = registry().get('gopay');
      const out = await provider.session.startLogin(req.body?.phone_number);
      res.json({ success: true, data: { otp_token: out.otpToken, otp_length: out.otpLength } });
    } catch (err) { next(err); }
  });

  /** Login OTP GoPay, langkah 2. */
  router.post('/gopay/login/verify', async (req, res, next) => {
    try {
      const { phone_number: phone, otp_token: otpToken, otp } = req.body || {};
      const provider = registry().get('gopay');
      res.json({ success: true, data: await provider.session.completeLogin(phone, otpToken, otp) });
    } catch (err) { next(err); }
  });

  /** Seluruh pengaturan, dikelompokkan. Rahasia tidak pernah ikut nilainya. */
  router.get('/settings', async (req, res, next) => {
    try {
      res.json({ success: true, data: { groups: await settings.describe(pool, runtime.effectiveEnv) } });
    } catch (err) { next(err); }
  });

  /**
   * Menyimpan pengaturan lalu memuat ulang konfigurasi.
   *
   * Reload dilakukan di sini agar perubahan kredensial langsung berlaku tanpa
   * redeploy. Bila konfigurasi baru tidak sah, reload melempar dan perubahan
   * tetap tersimpan — pesannya dikembalikan supaya operator bisa memperbaiki.
   */
  router.put('/settings', async (req, res, next) => {
    try {
      const changed = await settings.save(pool, req.body || {}, req.admin?.email || req.admin?.via);
      let reload = null;
      let warning = null;
      try { reload = await runtime.reload(); }
      catch (err) { warning = `Pengaturan tersimpan, tapi konfigurasi ditolak: ${err.message}`; }
      res.json({ success: true, data: { changed, providers: reload?.providers ?? null, warning } });
    } catch (err) { next(err); }
  });

  router.get('/providers', (req, res) => {
    res.json({
      success: true,
      data: {
        active: registry().ids(),
        default: registry().default().constructor.id,
        detail: registry().ids().map((id) => {
          const p = registry().get(id);
          return { id, supports_webhook: p.supportsWebhook, needs_unique_amount: p.needsUniqueAmount };
        }),
      },
    });
  });

  return router;
}

module.exports = { buildAdminRoutes };
