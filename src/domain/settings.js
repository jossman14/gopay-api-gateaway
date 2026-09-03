'use strict';

/**
 * Pengaturan runtime.
 *
 * Nilai di database menimpa environment. Rahasia tidak pernah dikembalikan —
 * konsol hanya diberi tahu apakah sudah terisi. Perubahan memicu pembangunan
 * ulang registry provider, jadi mengganti kredensial tidak perlu redeploy.
 */

/** Kunci yang boleh diatur dari konsol, beserta sifatnya. */
const SCHEMA = {
  // Invoice
  PAYMENT_EXPIRY_MINUTES: { group: 'invoice', type: 'int', label: 'Masa berlaku invoice (menit)' },
  USE_UNIQUE_AMOUNT:      { group: 'invoice', type: 'bool', label: 'Pakai nominal unik' },
  UNIQUE_AMOUNT_MIN:      { group: 'invoice', type: 'int', label: 'Kode unik minimum' },
  UNIQUE_AMOUNT_MAX:      { group: 'invoice', type: 'int', label: 'Kode unik maksimum' },

  // Webhook
  WEBHOOK_ALLOWED_HOSTS:  { group: 'webhook', type: 'text', label: 'Host callback diizinkan (pisahkan koma)' },
  WEBHOOK_MAX_ATTEMPTS:   { group: 'webhook', type: 'int', label: 'Maksimum percobaan kirim' },
  WEBHOOK_TIMEOUT_MS:     { group: 'webhook', type: 'int', label: 'Batas waktu kirim (ms)' },

  // Rekonsiliasi
  RECONCILE_ENABLED:          { group: 'reconcile', type: 'bool', label: 'Aktifkan rekonsiliasi' },
  RECONCILE_INTERVAL_SECONDS: { group: 'reconcile', type: 'int', label: 'Selang polling (detik)' },

  // Provider — GoBiz resmi
  GOBIZ_ENABLED:       { group: 'gobiz', type: 'bool', label: 'Aktifkan GoBiz (resmi)' },
  GOBIZ_CLIENT_ID:     { group: 'gobiz', type: 'text', label: 'Client ID' },
  GOBIZ_CLIENT_SECRET: { group: 'gobiz', type: 'secret', label: 'Client Secret' },
  GOBIZ_OUTLET_ID:     { group: 'gobiz', type: 'text', label: 'Outlet ID' },
  GOBIZ_SANDBOX:       { group: 'gobiz', type: 'bool', label: 'Mode sandbox' },

  // Provider — Mayar
  MAYAR_ENABLED:       { group: 'mayar', type: 'bool', label: 'Aktifkan Mayar' },
  MAYAR_API_KEY:       { group: 'mayar', type: 'secret', label: 'API Key' },
  MAYAR_WEBHOOK_TOKEN: { group: 'mayar', type: 'secret', label: 'Webhook Token' },
  MAYAR_SANDBOX:       { group: 'mayar', type: 'bool', label: 'Mode sandbox' },

  // Provider — GoPay cadangan
  GOPAY_ENABLED:   { group: 'gopay', type: 'bool', label: 'Aktifkan GoPay (cadangan)' },
  GOPAY_DEVICE_ID: { group: 'gopay', type: 'text', label: 'Device ID (UUID tetap)' },
  QRIS_STATIC:     { group: 'gopay', type: 'secret', label: 'Payload QRIS statis merchant' },
};

const GROUPS = {
  invoice:   'Invoice',
  webhook:   'Webhook keluar',
  reconcile: 'Rekonsiliasi',
  gobiz:     'GoBiz — API resmi',
  mayar:     'Mayar',
  gopay:     'GoPay — cadangan',
};

async function loadOverrides(pool) {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  return Object.fromEntries(rows.filter((r) => r.value !== null).map((r) => [r.key, r.value]));
}

/**
 * Menyusun env efektif: environment sebagai dasar, database menimpanya.
 *
 * Nilai kosong dari database diperlakukan sebagai "tidak diatur" agar operator
 * bisa mengembalikan sebuah kunci ke nilai environment dengan mengosongkannya.
 */
function mergeEnv(baseEnv, overrides) {
  const out = { ...baseEnv };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === '' || v === null || v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

async function save(pool, changes, updatedBy) {
  const entries = Object.entries(changes).filter(([k]) => k in SCHEMA);
  if (!entries.length) return 0;
  for (const [key, raw] of entries) {
    const isSecret = SCHEMA[key].type === 'secret';
    // Nilai kosong berarti "hapus penimpaan", bukan "simpan string kosong".
    const value = raw === '' || raw === null ? null : String(raw);
    await pool.query(
      `INSERT INTO settings (key, value, is_secret, updated_by, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value, is_secret = EXCLUDED.is_secret,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, value, isSecret, updatedBy || null]
    );
  }
  return entries.length;
}

/**
 * Bentuk yang aman dikirim ke konsol.
 *
 * Rahasia dikembalikan sebagai `{ set: true }` saja. Mengirim nilainya akan
 * membuat kredensial provider bisa dibaca siapa pun yang membuka konsol,
 * termasuk lewat riwayat browser atau tangkapan layar.
 */
async function describe(pool, effectiveEnv) {
  const { rows } = await pool.query('SELECT key, value, updated_at, updated_by FROM settings');
  const stored = Object.fromEntries(rows.map((r) => [r.key, r]));

  const groups = {};
  for (const [key, meta] of Object.entries(SCHEMA)) {
    const g = (groups[meta.group] ||= { id: meta.group, label: GROUPS[meta.group], items: [] });
    const effective = effectiveEnv[key];
    const overridden = Boolean(stored[key] && stored[key].value !== null);
    g.items.push({
      key, label: meta.label, type: meta.type,
      value: meta.type === 'secret' ? null : (effective ?? ''),
      set: meta.type === 'secret' ? Boolean(effective) : undefined,
      source: overridden ? 'konsol' : (effective !== undefined ? 'environment' : 'kosong'),
      updated_at: stored[key]?.updated_at ?? null,
    });
  }
  return Object.values(groups);
}

module.exports = { SCHEMA, GROUPS, loadOverrides, mergeEnv, save, describe };
