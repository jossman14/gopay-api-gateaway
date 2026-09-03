'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'migrations');

/**
 * Migrasi berurutan yang dicatat, sehingga menjalankan ulang aman dan
 * deployment berikutnya tidak menerapkan berkas yang sama dua kali.
 */
async function migrate(pool, log = console.log) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const applied = new Set(
    (await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name)
  );
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log(`  migrasi diterapkan: ${file}`);
      count++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Migrasi ${file} gagal: ${err.message}`);
    } finally {
      client.release();
    }
  }
  if (!count) log('  tidak ada migrasi baru');
  return count;
}

module.exports = { migrate };
