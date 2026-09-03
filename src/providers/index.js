'use strict';

const { GobizProvider } = require('./gobiz');
const { MayarProvider } = require('./mayar');
const { GopayProvider } = require('./gopay');

/**
 * Registry provider.
 *
 * Provider dipilih per invoice. Bila klien tidak menyebut provider, yang
 * pertama pada urutan preferensi dipakai: GoBiz resmi lebih dulu karena
 * korelasi pembayarannya eksak; gopay hasil rekayasa balik paling akhir karena
 * paling rapuh.
 */
const PREFERENCE = ['gobiz', 'mayar', 'gopay'];

function buildRegistry(cfg, { http, sessionStore, log } = {}) {
  const registry = new Map();

  if (cfg.providers.gobiz.enabled) {
    registry.set('gobiz', new GobizProvider({ http, ...cfg.providers.gobiz }));
  }
  if (cfg.providers.mayar.enabled) {
    registry.set('mayar', new MayarProvider({ http, ...cfg.providers.mayar }));
  }
  if (cfg.providers.gopay.enabled) {
    registry.set('gopay', new GopayProvider({
      http,
      sessionStore,
      deviceId: cfg.providers.gopay.deviceId,
      qrisStatic: cfg.providers.gopay.qrisStatic,
      amountScale: cfg.providers.gopay.amountScale,
      unique: cfg.invoice,
      log,
    }));
  }

  return {
    get(id) {
      const provider = registry.get(id);
      if (!provider) {
        // 503, bukan 500: ini keadaan konfigurasi yang bisa diperbaiki operator,
        // dan pesannya harus sampai ke pemanggil agar tahu apa yang kurang.
        throw Object.assign(
          new Error(`Provider "${id}" tidak aktif. Aktifkan lewat ${id.toUpperCase()}_ENABLED=true beserta kredensialnya.`),
          { statusCode: 503 }
        );
      }
      return provider;
    },
    has(id) { return registry.has(id); },
    ids() { return [...registry.keys()]; },
    default() {
      const id = PREFERENCE.find((p) => registry.has(p));
      if (!id) {
        throw Object.assign(
          new Error('Belum ada provider pembayaran yang dikonfigurasi. Isi kredensial GOBIZ, MAYAR, atau GOPAY.'),
          { statusCode: 503 }
        );
      }
      return registry.get(id);
    },
    isEmpty() { return registry.size === 0; },
  };
}

module.exports = { buildRegistry, PREFERENCE };
