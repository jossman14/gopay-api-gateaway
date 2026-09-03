'use strict';

const { load } = require('./config');
const { getPool, closePool } = require('./db/pool');
const { migrate } = require('./db/migrate');
const { httpClient } = require('./http/client');
const { buildApp } = require('./http/app');
const { buildRegistry } = require('./providers');
const { SessionStore } = require('./providers/gopay/session');
const { startReconciler } = require('./domain/reconcile');
const { processDue } = require('./webhooks/deliver');

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

async function main() {
  const config = load();
  const pool = getPool(config.databaseUrl);

  log('menjalankan migrasi...');
  await migrate(pool, log);

  const registry = buildRegistry(config, { http: httpClient, sessionStore: new SessionStore(pool) });
  if (registry.isEmpty()) {
    log('PERINGATAN: belum ada provider pembayaran. Laporan dan konsol tetap jalan, ' +
        'pembuatan invoice akan menolak sampai kredensial diisi.');
  } else {
    log(`provider aktif: ${registry.ids().join(', ')} (default: ${registry.default().constructor.id})`);
  }

  const app = buildApp({ pool, registry, config, log });
  const server = app.listen(config.port, () => log(`gateway mendengarkan di :${config.port}`));

  const stoppers = [];

  // Rekonsiliasi hanya untuk provider tanpa webhook. Yang mendukung webhook
  // tidak dipoll sama sekali — itu beda pokok jalur resmi dan cadangan.
  for (const id of registry.ids()) {
    const provider = registry.get(id);
    if (provider.supportsWebhook || !config.reconcile.enabled) continue;
    log(`rekonsiliasi aktif untuk ${id} tiap ${config.reconcile.intervalMs / 1000}s`);
    stoppers.push(startReconciler(pool, provider, {
      intervalMs: config.reconcile.intervalMs,
      log: (m) => log(`[reconcile:${id}]`, m),
    }));
  }

  // Worker pengirim webhook keluar, terpisah dari jalur permintaan agar klien
  // yang lambat tidak menahan respons API.
  const webhookTimer = setInterval(() => {
    processDue(pool, { http: httpClient, config, log: (m) => log('[webhook]', m) })
      .catch((err) => log('[webhook] gagal:', err.message));
  }, 15_000);

  const shutdown = async (signal) => {
    log(`${signal} diterima, menutup...`);
    clearInterval(webhookTimer);
    stoppers.forEach((stop) => stop());
    server.close(async () => { await closePool(); process.exit(0); });
    // Bila koneksi menggantung, jangan tertahan selamanya.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => { console.error('Gagal start:', err.message); process.exit(1); });
}

module.exports = { main };
