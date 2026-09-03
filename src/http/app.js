'use strict';

const express = require('express');
const path = require('path');
const { apiKeyAuth, adminAuth } = require('./middleware/auth');
const { checkCredentials, issueSession, SESSION_TTL_MS } = require('../domain/adminAuth');
const { notFound, errorHandler } = require('./middleware/errors');
const { buildV1Routes } = require('./routes/v1');
const { buildAdminRoutes } = require('./routes/admin');
const { buildWebhookRoutes } = require('./routes/webhooks');

/**
 * Pembatas laju login.
 *
 * Kata sandi tunggal tanpa pembatas adalah undangan untuk menebak. Jendela
 * geser sederhana per alamat IP sudah cukup; tidak perlu penyimpanan eksternal
 * untuk satu akun admin.
 */
function loginLimiter({ windowMs = 60_000, max = 8 } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || 'unknown';
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      return res.status(429).json({ success: false, errors: [{ message: 'Terlalu banyak percobaan. Coba lagi sebentar.' }] });
    }
    list.push(now);
    hits.set(key, list);
    // Cegah Map tumbuh tanpa batas bila banyak IP berbeda mencoba.
    if (hits.size > 1000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    next();
  };
}

function buildApp({ pool, registry, config, log = console.log }) {
  const app = express();
  app.disable('x-powered-by');

  // Batas ukuran body: gateway ini hanya menerima JSON kecil, dan tanpa batas
  // satu permintaan besar bisa menghabiskan memori proses.
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ success: true, data: { status: 'ok', providers: registry.ids() } });
    } catch (err) {
      res.status(503).json({ success: false, errors: [{ message: 'Database tidak dapat dijangkau' }] });
    }
  });

  // Webhook provider TIDAK memakai API key: pengirimnya provider, bukan klien.
  // Keasliannya dibuktikan dengan menanyakan ulang status ke provider.
  app.use('/webhooks', buildWebhookRoutes({ pool, registry, log }));

  app.use('/v1', apiKeyAuth(pool), buildV1Routes({ pool, registry, config }));

  // Login TIDAK boleh berada di balik adminAuth — kalau tidak, tidak ada cara
  // memperoleh sesi untuk pertama kali.
  app.post('/hehehe/api/login', loginLimiter(), (req, res) => {
    if (!config.admin.sessionSecret || !config.admin.email || !config.admin.passwordHash) {
      return res.status(503).json({ success: false, errors: [{ message: 'Login admin belum dikonfigurasi' }] });
    }
    if (!checkCredentials(req.body || {}, config)) {
      // Pesan sengaja tidak membedakan email salah dan kata sandi salah, agar
      // tidak bisa dipakai menebak email mana yang terdaftar.
      log(`login admin gagal dari ${req.ip}`);
      return res.status(401).json({ success: false, errors: [{ message: 'Email atau kata sandi salah' }] });
    }
    const token = issueSession(config.admin.sessionSecret, config.admin.email);
    res.cookie?.('pg_session', token, {
      httpOnly: true, sameSite: 'strict', secure: true,
      maxAge: SESSION_TTL_MS, path: '/',
    });
    res.setHeader('set-cookie',
      `pg_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
    res.json({ success: true, data: { email: config.admin.email, expires_in: SESSION_TTL_MS / 1000 } });
  });

  app.post('/hehehe/api/logout', (req, res) => {
    res.setHeader('set-cookie', 'pg_session=; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=0');
    res.json({ success: true, data: {} });
  });

  app.use('/hehehe/api', adminAuth(config), buildAdminRoutes({ pool, registry, config }));

  // Konsol admin. Halamannya statis dan tidak memuat rahasia: kredensial
  // dimasukkan pengguna dan ditukar dengan cookie sesi HttpOnly, sehingga token
  // tidak bisa dibaca skrip pihak ketiga di halaman.
  app.use('/hehehe', express.static(path.join(__dirname, '..', '..', 'public'), {
    index: 'index.html', maxAge: '5m',
  }));

  app.use(notFound);
  app.use(errorHandler(log));
  return app;
}

module.exports = { buildApp };
