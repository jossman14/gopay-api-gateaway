'use strict';

const { Pool } = require('pg');

let pool = null;

function getPool(databaseUrl) {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      // Gateway ini menunggu Postgres bersama di jaringan Docker; timeout
      // pendek membuat kegagalan jaringan terlihat cepat, bukan menggantung.
      connectionTimeoutMillis: 5_000,
    });
  }
  return pool;
}

/**
 * Menjalankan fn di dalam satu transaksi database.
 *
 * Dipakai untuk setiap perubahan yang menyentuh uang: pelunasan invoice harus
 * atomik bersama klaim transaksi provider, kalau tidak satu mutasi bisa
 * melunasi dua invoice ketika dua worker berjalan bersamaan.
 */
async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function closePool() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { getPool, withTransaction, closePool };
