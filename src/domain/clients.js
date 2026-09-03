'use strict';

const crypto = require('crypto');

/**
 * Klien API — satu baris per aplikasi yang memakai gateway (soal, review, ...).
 *
 * Kunci disimpan sebagai hash, bukan teks terang. Bila database bocor, kunci
 * yang ada di sana tidak bisa langsung dipakai memanggil API.
 */

const PREFIX_LEN = 12;

/** Membuat kunci baru. Teks terangnya HANYA dikembalikan sekali, di sini. */
function generateApiKey(clientId) {
  const secret = crypto.randomBytes(24).toString('base64url');
  const prefix = `pk_${crypto.randomBytes(6).toString('hex')}`.slice(0, PREFIX_LEN);
  const key = `${prefix}.${secret}`;
  return { key, prefix, hash: hashKey(key) };
}

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function createClient(pool, { id, name, callbackUrl = null }) {
  const { key, prefix, hash } = generateApiKey(id);
  const webhookSecret = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO clients (id, name, api_key_hash, api_key_prefix, callback_url, webhook_secret)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, name, hash, prefix, callbackUrl, webhookSecret]
  );
  // apiKey dikembalikan sekali saja; sesudah ini hanya hash-nya yang tersimpan.
  return { id, name, apiKey: key, webhookSecret };
}

/**
 * Mencari klien dari kunci API.
 *
 * Prefix dipakai untuk menemukan baris (terindeks), lalu hash dibandingkan
 * dengan timingSafeEqual. Memindai seluruh tabel dan membandingkan satu per
 * satu akan membocorkan informasi lewat waktu respons.
 */
async function authenticate(pool, apiKey) {
  if (typeof apiKey !== 'string' || !apiKey.includes('.')) return null;
  const prefix = apiKey.split('.')[0].slice(0, PREFIX_LEN);

  const { rows } = await pool.query(
    'SELECT * FROM clients WHERE api_key_prefix = $1 AND active = TRUE', [prefix]
  );
  if (rows.length === 0) return null;

  const client = rows[0];
  const given = Buffer.from(hashKey(apiKey), 'hex');
  const stored = Buffer.from(client.api_key_hash, 'hex');
  if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) return null;
  return client;
}

async function listClients(pool) {
  const { rows } = await pool.query(
    `SELECT id, name, api_key_prefix, callback_url, active, created_at
     FROM clients ORDER BY created_at`
  );
  return rows;
}

/** Memutar kunci. Kunci lama langsung tidak berlaku. */
async function rotateApiKey(pool, clientId) {
  const { key, prefix, hash } = generateApiKey(clientId);
  const { rowCount } = await pool.query(
    'UPDATE clients SET api_key_hash = $1, api_key_prefix = $2 WHERE id = $3',
    [hash, prefix, clientId]
  );
  if (rowCount === 0) return null;
  return { id: clientId, apiKey: key };
}

module.exports = { generateApiKey, hashKey, createClient, authenticate, listClients, rotateApiKey };
