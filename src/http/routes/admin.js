'use strict';

const express = require('express');
const clients = require('../../domain/clients');
const reports = require('../../domain/reports');
const { reconcileOnce } = require('../../domain/reconcile');
const { present } = require('./v1');
const settings = require('../../domain/settings');
const qrisInspect = require('../../domain/qrisInspect');
const { renderSvg } = require('../../lib/qrImage');
const QRCodeLib = require('qrcode');
const invoicesDomain = require('../../domain/invoices');

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
        ...present(r), client_id: r.client_id, client_name: r.client_name, is_test: r.is_test,
      })) } });
    } catch (err) { next(err); }
  });

  /** Membuat invoice atas nama sebuah aplikasi, dari konsol. */
  router.post('/invoices', async (req, res, next) => {
    try {
      const { client_id: clientId, order_id: orderId, amount, provider: providerId, callback_url: callbackUrl } = req.body || {};
      if (!clientId || !orderId) {
        return res.status(400).json({ success: false, errors: [{ message: 'client_id dan order_id wajib diisi' }] });
      }
      const { rows } = await pool.query('SELECT * FROM clients WHERE id = $1 AND active = TRUE', [clientId]);
      if (!rows[0]) return res.status(404).json({ success: false, errors: [{ message: 'Aplikasi tidak ditemukan atau nonaktif' }] });

      const provider = providerId ? registry().get(providerId) : registry().default();
      const { invoice, created } = await invoicesDomain.createInvoice(pool, {
        client: rows[0], orderId, amount: Number(amount), provider, callbackUrl,
        metadata: { created_via: 'konsol' },
        expiryMs: config().invoice.expiryMs, unique: config().invoice,
      });
      res.status(created ? 201 : 200).json({ success: true, data: { invoice: present(invoice), created } });
    } catch (err) { next(err); }
  });

  router.post('/invoices/:id/cancel', async (req, res, next) => {
    try {
      const out = await invoicesDomain.cancelInvoice(pool, req.params.id);
      if (!out) return res.status(404).json({ success: false, errors: [{ message: 'Invoice tidak ditemukan' }] });
      res.json({ success: true, data: { invoice: present(out) } });
    } catch (err) { next(err); }
  });

  router.delete('/invoices/:id', async (req, res, next) => {
    try {
      const ok = await invoicesDomain.deleteInvoice(pool, req.params.id);
      if (!ok) return res.status(404).json({ success: false, errors: [{ message: 'Invoice tidak ditemukan' }] });
      res.json({ success: true, data: {} });
    } catch (err) { next(err); }
  });

  /** Memaksa pemeriksaan status satu invoice ke provider — tanpa menunggu polling. */
  router.post('/invoices/:id/sync', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT i.*, pt.provider_transaction_id
         FROM invoices i
         LEFT JOIN provider_transactions pt ON pt.invoice_id = i.id
         WHERE i.id = $1`, [req.params.id]
      );
      const inv = rows[0];
      if (!inv) return res.status(404).json({ success: false, errors: [{ message: 'Invoice tidak ditemukan' }] });
      const provider = registry().get(inv.provider);
      if (typeof provider.getCharge !== 'function' || !inv.provider_transaction_id) {
        return res.status(400).json({ success: false, errors: [{ message: `Provider ${inv.provider} tidak mendukung pemeriksaan langsung; pakai rekonsiliasi.` }] });
      }
      const charge = await provider.getCharge(inv.provider_transaction_id);
      let paid = null;
      if (charge.status === 'PAID') {
        paid = await invoicesDomain.markPaid(pool, {
          invoiceId: inv.id, provider: inv.provider,
          transaction: { providerTransactionId: inv.provider_transaction_id, amount: charge.amount, raw: charge.raw },
        });
      }
      res.json({ success: true, data: { provider_status: charge.status, updated: Boolean(paid) } });
    } catch (err) { next(err); }
  });

  router.patch('/clients/:id', async (req, res, next) => {
    try {
      const out = await clients.updateClient(pool, req.params.id, {
        name: req.body?.name, callbackUrl: req.body?.callback_url, active: req.body?.active,
      });
      if (!out) return res.status(404).json({ success: false, errors: [{ message: 'Aplikasi tidak ditemukan' }] });
      res.json({ success: true, data: { client: out } });
    } catch (err) { next(err); }
  });

  router.delete('/clients/:id', async (req, res, next) => {
    try {
      const ok = await clients.deleteClient(pool, req.params.id);
      if (!ok) return res.status(404).json({ success: false, errors: [{ message: 'Aplikasi tidak ditemukan' }] });
      res.json({ success: true, data: {} });
    } catch (err) { next(err); }
  });

  /** Menguji kredensial provider tanpa membuat transaksi. */
  router.post('/providers/:id/test', async (req, res, next) => {
    try {
      const provider = registry().get(req.params.id);
      if (req.params.id === 'gopay') {
        const list = await provider.listTransactions({ limit: 1 });
        return res.json({ success: true, data: { ok: true, detail: `sesi sah, ${list.length} mutasi terbaca` } });
      }
      if (typeof provider.oauth?.getAccessToken === 'function') {
        await provider.oauth.getAccessToken();
        return res.json({ success: true, data: { ok: true, detail: 'token OAuth berhasil diperoleh' } });
      }
      const probe = await provider.getCharge('probe-nonexistent').then(() => 'terjangkau').catch((e) => e.message);
      res.json({ success: true, data: { ok: true, detail: String(probe).slice(0, 160) } });
    } catch (err) {
      res.status(200).json({ success: true, data: { ok: false, detail: err.message } });
    }
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

  /** Status sesi provider — token tidak pernah ikut. */
  router.get('/gopay/session', async (req, res, next) => {
    try {
      if (!registry().has('gopay')) return res.json({ success: true, data: { connected: false, reason: 'provider gopay tidak aktif' } });
      res.json({ success: true, data: await registry().get('gopay').session.status() });
    } catch (err) { next(err); }
  });

  /** Memperbarui token sekarang, tanpa menunggu jadwal keep-alive. */
  router.post('/gopay/session/refresh', async (req, res, next) => {
    try {
      const sm = registry().get('gopay').session;
      await sm.getAccessToken(Date.now() + 24 * 3600_000); // paksa: anggap sudah lewat
      res.json({ success: true, data: await sm.status() });
    } catch (err) { next(err); }
  });

  /** Mengambil ulang profil merchant dari sesi yang ada. */
  router.post('/gopay/session/profile', async (req, res, next) => {
    try {
      const sm = registry().get('gopay').session;
      const merchant = await sm.refreshProfile();
      res.json({ success: true, data: { merchant, session: await sm.status() } });
    } catch (err) { next(err); }
  });

  /** Mutasi mentah dari GoPay — memperlihatkan data asli yang terbaca sesi. */
  router.get('/gopay/transactions', async (req, res, next) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
      const list = await registry().get('gopay').listTransactions({ limit });
      res.json({ success: true, data: { count: list.length, transactions: list.map((t) => ({
        id: t.providerTransactionId,
        amount: t.amount,
        amount_raw: t.amountRaw,
        amount_scale: t.amountScale,
        transaction_time: t.transactionTime,
        reference: t.reference,
      })) } });
    } catch (err) { next(err); }
  });

  /** Menandai atau membuang penanda data uji. */
  router.post('/invoices/:id/mark-test', async (req, res, next) => {
    try {
      const isTest = req.body?.is_test !== false;
      const { rows } = await pool.query(
        'UPDATE invoices SET is_test = $2 WHERE id = $1 RETURNING id, is_test', [req.params.id, isTest]
      );
      if (!rows[0]) return res.status(404).json({ success: false, errors: [{ message: 'Invoice tidak ditemukan' }] });
      res.json({ success: true, data: rows[0] });
    } catch (err) { next(err); }
  });

  /** Membuang seluruh invoice uji. Yang PAID tetap dilindungi. */
  router.delete('/invoices/test-data', async (req, res, next) => {
    try {
      const { rowCount } = await pool.query(
        "DELETE FROM invoices WHERE is_test = TRUE AND status <> 'PAID'"
      );
      res.json({ success: true, data: { deleted: rowCount } });
    } catch (err) { next(err); }
  });

  /**
   * Memeriksa payload QRIS tanpa menyimpannya.
   *
   * Salah menempelkan QRIS statis adalah kesalahan mahal: QR-nya tetap tercetak
   * dan tetap bisa dipindai, tapi uangnya mengalir ke merchant lain. Memeriksa
   * lebih dulu jauh lebih murah daripada menemukannya dari pembeli.
   */
  router.post('/qris/inspect', (req, res, next) => {
    try {
      const payload = req.body?.payload || config().providers.gopay.qrisStatic;
      res.json({ success: true, data: qrisInspect.inspect(payload) });
    } catch (err) { next(err); }
  });

  /** Membuat QRIS dinamis percobaan dari payload statis. */
  router.post('/qris/preview', (req, res, next) => {
    try {
      const payload = req.body?.payload || config().providers.gopay.qrisStatic;
      const amount = Number(req.body?.amount) || 1000;
      const out = qrisInspect.preview(payload, amount, req.body?.reference || 'UJI-QRIS');
      res.json({ success: true, data: out });
    } catch (err) { next(err); }
  });

  /**
   * Gambar QR.
   *
   * `plain=1` memakai perenderan bawaan pustaka sebagai PNG. Itu jalur yang
   * paling konservatif dan berguna sebagai pembanding bila ada pemindai yang
   * kesulitan membaca versi bergaya.
   */
  router.get('/qris/image', async (req, res, next) => {
    try {
      const payload = req.query.payload || config().providers.gopay.qrisStatic;
      if (!payload) return res.status(400).json({ success: false, errors: [{ message: 'Tidak ada payload QRIS' }] });

      if (req.query.plain === '1') {
        const png = await QRCodeLib.toBuffer(String(payload), {
          errorCorrectionLevel: 'H', width: 720, margin: 4,
        });
        return res.type('png').set('cache-control', 'no-store').send(png);
      }
      const svg = renderSvg(String(payload), {
        size: 480,
        shape: req.query.shape === 'dot' ? 'dot' : 'square',
        logo: req.query.logo !== '0',
        caption: req.query.caption || null,
        subcaption: req.query.subcaption || null,
      });
      res.type('image/svg+xml').set('cache-control', 'no-store').send(svg);
    } catch (err) { next(err); }
  });

  /**
   * Membuat invoice UJI dari payload QRIS yang sedang diperiksa.
   *
   * Sengaja memakai jalur pencocokan yang sesungguhnya — bukan pratinjau —
   * supaya yang diuji benar-benar rantai lengkapnya: bayar, rekonsiliasi
   * menemukan mutasinya, invoice jadi PAID. Ditandai is_test agar tidak
   * mencemari laporan pemasukan.
   */
  router.post('/qris/test-invoice', async (req, res, next) => {
    try {
      const payload = req.body?.payload || config().providers.gopay.qrisStatic;
      const amount = Number(req.body?.amount);
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        return res.status(400).json({ success: false, errors: [{ message: 'amount harus bilangan bulat positif' }] });
      }
      const source = qrisInspect.inspect(payload);
      if (!source.is_static) {
        return res.status(400).json({ success: false, errors: [{ message: 'Payload harus QRIS statis merchant.' }] });
      }

      const { rows: cl } = await pool.query('SELECT id FROM clients WHERE active = TRUE ORDER BY created_at LIMIT 1');
      if (!cl[0]) return res.status(400).json({ success: false, errors: [{ message: 'Belum ada aplikasi aktif' }] });

      const id = `inv_uji_${Date.now().toString(36)}`;
      const reference = `UJI-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const { dynamic } = qrisInspect.preview(payload, amount, reference);

      const { rows } = await pool.query(
        `INSERT INTO invoices (id, client_id, order_id, provider, merchant_reference,
           base_amount, unique_code, payable_amount, status, qris_payload, expires_at, is_test, metadata)
         VALUES ($1,$2,$3,'gopay',$4,$5,0,$5,'PENDING',$6, now() + interval '20 minutes', TRUE, '{"created_via":"uji-qris"}')
         RETURNING *`,
        [id, cl[0].id, `UJI-QRIS-${id}`, reference, amount, dynamic]
      );
      res.status(201).json({ success: true, data: { invoice: present(rows[0]), qris: dynamic } });
    } catch (err) {
      // Nominal yang sama dengan invoice PENDING lain ditolak database; itu
      // invarian yang sama yang melindungi transaksi sungguhan.
      if (err.code === '23505') {
        return res.status(409).json({ success: false, errors: [{ message: 'Sudah ada invoice PENDING dengan nominal itu. Pakai nominal lain.' }] });
      }
      next(err);
    }
  });

  /** Status satu invoice uji — dipoll konsol sambil menunggu pembayaran. */
  router.get('/qris/test-invoice/:id', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT i.*, pt.provider_transaction_id, pt.amount AS matched_amount, pt.amount_source
         FROM invoices i LEFT JOIN provider_transactions pt ON pt.invoice_id = i.id
         WHERE i.id = $1`, [req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ success: false, errors: [{ message: 'Invoice uji tidak ditemukan' }] });
      const r = rows[0];
      res.json({ success: true, data: {
        ...present(r),
        provider_transaction_id: r.provider_transaction_id ?? null,
        matched_amount: r.matched_amount ? Number(r.matched_amount) : null,
        amount_source: r.amount_source ?? null,
      } });
    } catch (err) { next(err); }
  });

  /**
   * Mutasi provider yang tercatat gateway, digabung dengan invoice yang
   * mengklaimnya. Berbeda dari /gopay/transactions yang menarik langsung dari
   * GoPay, di sini terlihat mana yang sudah terpakai dan mana yang menganggur.
   */
  router.get('/transactions', async (req, res, next) => {
    try {
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const { rows } = await pool.query(
        `SELECT pt.*, i.order_id, i.client_id, i.status AS invoice_status, i.is_test, c.name AS client_name
         FROM provider_transactions pt
         LEFT JOIN invoices i ON i.id = pt.invoice_id
         LEFT JOIN clients  c ON c.id = i.client_id
         ORDER BY pt.claimed_at DESC LIMIT $1`, [limit]
      );
      res.json({ success: true, data: { transactions: rows.map((r) => ({
        provider: r.provider,
        provider_transaction_id: r.provider_transaction_id,
        amount: Number(r.amount),
        amount_source: r.amount_source,
        transaction_time: r.transaction_time,
        claimed_at: r.claimed_at,
        invoice_id: r.invoice_id,
        order_id: r.order_id,
        client_name: r.client_name,
        invoice_status: r.invoice_status,
        is_test: r.is_test,
      })) } });
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
