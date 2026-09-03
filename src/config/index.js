'use strict';

/**
 * Konfigurasi terpusat dengan validasi di titik start.
 *
 * Gateway ini memegang uang. Konfigurasi yang salah sebaiknya membuat proses
 * gagal terbit, bukan diam-diam berjalan dengan default yang tidak aman —
 * itulah kenapa beberapa nilai wajib dan tidak punya fallback.
 */

const REQUIRED = ['DATABASE_URL'];

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function load(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Konfigurasi wajib belum diisi: ${missing.join(', ')}`);
  }

  const cfg = {
    port: int(env.PORT, 3000),
    nodeEnv: env.NODE_ENV || 'development',
    databaseUrl: env.DATABASE_URL,

    // Kunci admin dashboard. Tanpa nilai, dashboard dimatikan — lebih baik
    // fitur hilang daripada terbuka dengan kredensial default.
    admin: {
      email: env.ADMIN_EMAIL || null,
      // Hanya hash yang disimpan. ADMIN_PASSWORD diterima sebagai kemudahan
      // saat pertama menyiapkan, tapi di-hash saat dimuat sehingga kata sandi
      // terang tidak pernah tersimpan di memori proses lebih lama dari perlu.
      passwordHash: env.ADMIN_PASSWORD_HASH
        || (env.ADMIN_PASSWORD ? require('../domain/adminAuth').hashPassword(env.ADMIN_PASSWORD) : null),
      sessionSecret: env.ADMIN_SESSION_SECRET || null,
    },

    invoice: {
      expiryMs: Math.max(60, int(env.PAYMENT_EXPIRY_MINUTES, 15) * 60) * 1000,
      useUniqueAmount: bool(env.USE_UNIQUE_AMOUNT, true),
      uniqueMin: int(env.UNIQUE_AMOUNT_MIN, 1),
      uniqueMax: int(env.UNIQUE_AMOUNT_MAX, 999),
    },

    reconcile: {
      intervalMs: Math.max(10, int(env.RECONCILE_INTERVAL_SECONDS, 20)) * 1000,
      enabled: bool(env.RECONCILE_ENABLED, true),
    },

    webhook: {
      // Hostname callback dibatasi agar gateway tidak bisa dipakai sebagai
      // batu loncatan SSRF ke jaringan internal oleh klien yang dikompromikan.
      allowedHosts: (env.WEBHOOK_ALLOWED_HOSTS || '')
        .split(',').map((s) => s.trim()).filter(Boolean),
      maxAttempts: int(env.WEBHOOK_MAX_ATTEMPTS, 6),
      timeoutMs: int(env.WEBHOOK_TIMEOUT_MS, 10000),
    },

    providers: {
      // Jalur resmi — dipakai bila kredensial tersedia.
      gobiz: {
        enabled: bool(env.GOBIZ_ENABLED, false),
        clientId: env.GOBIZ_CLIENT_ID || null,
        clientSecret: env.GOBIZ_CLIENT_SECRET || null,
        outletId: env.GOBIZ_OUTLET_ID || null,
        sandbox: bool(env.GOBIZ_SANDBOX, false),
      },
      // Jalur rekayasa balik — jalan tanpa registrasi, tapi rapuh.
      gopay: {
        enabled: bool(env.GOPAY_ENABLED, false),
        deviceId: env.GOPAY_DEVICE_ID || null,
        qrisStatic: env.QRIS_STATIC || null,
      },
      mayar: {
        enabled: bool(env.MAYAR_ENABLED, false),
        apiKey: env.MAYAR_API_KEY || null,
        webhookToken: env.MAYAR_WEBHOOK_TOKEN || null,
        sandbox: bool(env.MAYAR_SANDBOX, false),
      },
    },
  };

  // Provider yang diaktifkan tapi kredensialnya belum lengkap adalah kesalahan
  // konfigurasi yang paling mahal ditemukan saat transaksi pertama.
  if (cfg.providers.gobiz.enabled) {
    for (const k of ['clientId', 'clientSecret', 'outletId']) {
      if (!cfg.providers.gobiz[k]) throw new Error(`GOBIZ_ENABLED=true tapi GOBIZ_${k.replace(/([A-Z])/g, '_$1').toUpperCase()} kosong`);
    }
  }
  if (cfg.providers.gopay.enabled && !cfg.providers.gopay.deviceId) {
    throw new Error('GOPAY_ENABLED=true tapi GOPAY_DEVICE_ID kosong (pakai UUID tetap per instalasi)');
  }
  // QRIS_STATIC sengaja TIDAK diwajibkan di sini. Ia hanya dibutuhkan untuk
  // membuat QR, sedangkan login OTP dan penarikan mutasi tidak memerlukannya.
  // Mewajibkannya saat start membuat lingkaran: sesi tidak bisa dibuat sebelum
  // konfigurasi lengkap, padahal login itu justru langkah penyiapan pertama.
  // Ketiadaannya ditolak saat createCharge dengan 503 yang jelas.
  if (cfg.providers.mayar.enabled && !cfg.providers.mayar.apiKey) {
    throw new Error('MAYAR_ENABLED=true tapi MAYAR_API_KEY kosong');
  }
  // Nol provider BUKAN galat. Gateway ini ledger master lebih dulu: laporan,
  // pendaftaran klien, dan konsol admin tetap berguna sebelum provider mana pun
  // terpasang. Pembuatan invoice yang menolak dengan pesan jelas (503) lebih
  // baik daripada proses yang menolak terbit sama sekali.
  cfg.hasProvider = cfg.providers.gobiz.enabled
    || cfg.providers.gopay.enabled
    || cfg.providers.mayar.enabled;

  return cfg;
}

module.exports = { load, bool, int };
