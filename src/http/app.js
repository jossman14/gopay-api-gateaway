'use strict';

const express = require('express');
const path = require('path');
const { apiKeyAuth, adminAuth } = require('./middleware/auth');
const { notFound, errorHandler } = require('./middleware/errors');
const { buildV1Routes } = require('./routes/v1');
const { buildAdminRoutes } = require('./routes/admin');
const { buildWebhookRoutes } = require('./routes/webhooks');

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
  app.use('/admin/api', adminAuth(config), buildAdminRoutes({ pool, registry, config }));

  // Konsol admin. Halamannya statis dan tidak memuat rahasia apa pun: token
  // dimasukkan pengguna dan disimpan di localStorage browser masing-masing,
  // lalu dikirim sebagai header X-Admin-Token pada tiap panggilan. Karena itu
  // aman disajikan tanpa autentikasi — yang dijaga adalah /admin/api di atas.
  app.use('/admin', express.static(path.join(__dirname, '..', '..', 'public'), {
    index: 'index.html', maxAge: '5m',
  }));

  app.use(notFound);
  app.use(errorHandler(log));
  return app;
}

module.exports = { buildApp };
