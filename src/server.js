'use strict';

const { getPool, closePool } = require('./db/pool');
const { migrate } = require('./db/migrate');
const { httpClient } = require('./http/client');
const { buildApp } = require('./http/app');
const { Runtime } = require('./runtime');
const { processDue } = require('./webhooks/deliver');

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

async function main() {
  // DATABASE_URL dibaca lebih dulu dan sendirian: seluruh konfigurasi lain
  // boleh berasal dari tabel settings, tapi tabel itu sendiri butuh koneksi.
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL wajib diisi');
  const pool = getPool(process.env.DATABASE_URL);

  log('menjalankan migrasi...');
  await migrate(pool, log);

  const runtime = new Runtime({ pool, http: httpClient, log });
  await runtime.reload();

  const app = buildApp({ pool, runtime, log });
  const server = app.listen(runtime.config.port, () =>
    log(`gateway mendengarkan di :${runtime.config.port}`));

  // Pengiriman webhook keluar dijalankan terpisah dari jalur permintaan agar
  // klien yang lambat tidak menahan respons API.
  const webhookTimer = setInterval(() => {
    processDue(pool, { http: httpClient, config: runtime.config, log: (m) => log('[webhook]', m) })
      .catch((err) => log('[webhook] gagal:', err.message));
  }, 15_000);

  const shutdown = async (signal) => {
    log(`${signal} diterima, menutup...`);
    clearInterval(webhookTimer);
    runtime.stop();
    server.close(async () => { await closePool(); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => { console.error('Gagal start:', err.message); process.exit(1); });
}

module.exports = { main };
