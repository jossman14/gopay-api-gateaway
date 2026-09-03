'use strict';

const crypto = require('crypto');
const { authenticate } = require('../../domain/clients');
const { verifySession } = require('../../domain/adminAuth');

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

/**
 * Admin. Menerima dua bentuk kredensial:
 *
 *   1. Cookie/header sesi hasil login email+kata sandi — untuk manusia.
 *   2. X-Admin-Token, secret mentah — untuk skrip dan otomasi.
 *
 * Keduanya dibandingkan dengan timingSafeEqual. Bila secret belum diatur,
 * seluruh permukaan admin dimatikan alih-alih diberi kredensial default.
 */
function adminAuth(config) {
  return (req, res, next) => {
    const secret = config.admin.sessionSecret;
    if (!secret) {
      return res.status(503).json({ success: false, errors: [{ message: 'Dashboard admin tidak dikonfigurasi' }] });
    }

    const raw = req.headers['x-admin-token'];
    if (raw && safeEqual(raw, secret)) { req.admin = { via: 'token' }; return next(); }

    const session = req.headers['x-admin-session'] || readCookie(req, 'pg_session');
    const claims = session ? verifySession(secret, session) : null;
    if (claims) { req.admin = { via: 'session', email: claims.email }; return next(); }

    res.status(401).json({ success: false, errors: [{ message: 'Perlu login admin' }] });
  };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

module.exports = { apiKeyAuth, adminAuth, readCookie };
