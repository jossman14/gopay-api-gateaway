'use strict';

const { authenticate } = require('../../domain/clients');

/**
 * Autentikasi klien lewat header X-API-Key.
 *
 * Setiap klien hanya bisa melihat invoice miliknya sendiri; pembatasan itu
 * dilakukan di query (WHERE client_id = ...), bukan dengan menyaring hasil
 * sesudahnya, agar kebocoran lintas-tenant tidak mungkin terjadi karena lupa.
 */
function apiKeyAuth(pool) {
  return async (req, res, next) => {
    const key = req.headers['x-api-key'];
    if (!key) {
      return res.status(401).json({ success: false, errors: [{ message: 'Header X-API-Key wajib diisi' }] });
    }
    try {
      const client = await authenticate(pool, key);
      if (!client) {
        return res.status(401).json({ success: false, errors: [{ message: 'API key tidak valid' }] });
      }
      req.client = client;
      next();
    } catch (err) { next(err); }
  };
}

/** Admin dashboard. Dimatikan bila kredensial belum diatur — bukan diberi default. */
function adminAuth(config) {
  return (req, res, next) => {
    if (!config.admin.sessionSecret) {
      return res.status(503).json({ success: false, errors: [{ message: 'Dashboard admin tidak dikonfigurasi' }] });
    }
    const token = req.headers['x-admin-token'];
    if (!token || token !== config.admin.sessionSecret) {
      return res.status(401).json({ success: false, errors: [{ message: 'Token admin tidak valid' }] });
    }
    next();
  };
}

module.exports = { apiKeyAuth, adminAuth };
