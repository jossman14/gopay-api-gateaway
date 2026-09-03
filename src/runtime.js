'use strict';

const { load } = require('./config');
const { buildRegistry } = require('./providers');
const { SessionStore } = require('./providers/gopay/session');
const { loadOverrides, mergeEnv } = require('./domain/settings');
const { startReconciler } = require('./domain/reconcile');

/**
 * Konfigurasi dan registry yang bisa dimuat ulang saat berjalan.
 *
 * Tanpa ini, mengganti kredensial provider menuntut redeploy. Runtime memegang
 * satu sumber kebenaran yang di-swap secara atomik, sehingga permintaan yang
 * sedang berjalan tetap memakai registry lama sampai selesai.
 */
class Runtime {
  constructor({ pool, http, baseEnv = process.env, log = console.log }) {
    this.pool = pool;
    this.http = http;
    this.baseEnv = { ...baseEnv };
    this.log = log;
    this.config = null;
    this.registry = null;
    this._stopReconcilers = [];
  }

  /** Membaca penimpaan dari database lalu membangun ulang config + registry. */
  async reload() {
    const overrides = await loadOverrides(this.pool);
    const env = mergeEnv(this.baseEnv, overrides);
    const config = load(env);
    const registry = buildRegistry(config, {
      http: this.http,
      sessionStore: new SessionStore(this.pool),
    });

    this.config = config;
    this.registry = registry;
    this.effectiveEnv = env;

    this._restartReconcilers();
    this.log(registry.isEmpty()
      ? 'konfigurasi dimuat: belum ada provider aktif'
      : `konfigurasi dimuat: provider ${registry.ids().join(', ')} (default: ${registry.default().constructor.id})`);
    return { providers: registry.ids() };
  }

  /**
   * Rekonsiliasi dimulai ulang setiap reload.
   *
   * Selang waktu dan daftar provider bisa berubah; membiarkan worker lama
   * berjalan akan membuat dua worker memoll provider yang sama.
   */
  _restartReconcilers() {
    this._stopReconcilers.forEach((stop) => stop());
    this._stopReconcilers = [];
    if (!this.config.reconcile.enabled) return;

    for (const id of this.registry.ids()) {
      const provider = this.registry.get(id);
      if (provider.supportsWebhook) continue;
      this.log(`rekonsiliasi aktif untuk ${id} tiap ${this.config.reconcile.intervalMs / 1000}s`);
      this._stopReconcilers.push(startReconciler(this.pool, provider, {
        intervalMs: this.config.reconcile.intervalMs,
        log: (m) => this.log(`[reconcile:${id}] ${m}`),
      }));
    }
  }

  stop() {
    this._stopReconcilers.forEach((s) => s());
    this._stopReconcilers = [];
  }
}

module.exports = { Runtime };
