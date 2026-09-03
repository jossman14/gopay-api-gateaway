'use strict';

const crypto = require('crypto');

/**
 * Autentikasi admin dengan email dan kata sandi.
 *
 * Kata sandi disimpan sebagai hash scrypt bergaram, tidak pernah teks terang —
 * termasuk di environment. scrypt dipilih karena mahal secara memori, sehingga
 * menebak secara massal jauh lebih lambat daripada dengan hash cepat.
 *
 * Sesi berupa token bertanda tangan, bukan baris di database: tidak ada state
 * yang perlu dibersihkan, dan token kedaluwarsa dengan sendirinya.
 */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 jam

/** Format: scrypt$<salt-hex>$<hash-hex> */
function hashPassword(password, salt = crypto.randomBytes(16)) {
  const derived = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  let derived;
  try {
    derived = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), SCRYPT.keylen, SCRYPT);
  } catch { return false; }
  const expected = Buffer.from(hashHex, 'hex');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

/**
 * Token sesi: `<payload-b64url>.<hmac>`.
 *
 * Kedaluwarsa ikut ditandatangani, jadi memperpanjangnya sendiri akan
 * membatalkan tanda tangan.
 */
function issueSession(secret, email, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ e: email, x: now + SESSION_TTL_MS })).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

function verifySession(secret, token, now = Date.now()) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(mac || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!data || typeof data.x !== 'number' || data.x < now) return null;
  return { email: data.e, expiresAt: data.x };
}

/**
 * Mencocokkan kredensial login.
 *
 * Email dibandingkan dengan timingSafeEqual juga: membandingkan dengan === akan
 * membocorkan email yang benar lewat selisih waktu respons.
 */
function checkCredentials({ email, password }, config) {
  const okEmail = safeEqual(String(email || '').toLowerCase(), String(config.admin.email || '').toLowerCase());
  const okPass = verifyPassword(String(password || ''), config.admin.passwordHash);
  return okEmail && okPass;
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) {
    // Tetap lakukan satu perbandingan agar waktunya tidak bergantung panjang.
    crypto.timingSafeEqual(x, x);
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

module.exports = { hashPassword, verifyPassword, issueSession, verifySession, checkCredentials, SESSION_TTL_MS };
