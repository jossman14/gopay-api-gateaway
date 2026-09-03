'use strict';

const { GoIdClient } = require('./goid');

/**
 * Sesi GoPay yang disimpan di database.
 *
 * Versi lama menaruhnya di berkas JSON di samping kode, sehingga hilang setiap
 * container diganti dan memaksa login OTP ulang. Di sini ia bertahan dan
 * menjadi satu-satunya sumber kebenaran.
 */
class SessionStore {
  constructor(pool) { this.pool = pool; }

  async load(provider = 'gopay') {
    const { rows } = await this.pool.query(
      'SELECT * FROM provider_sessions WHERE provider = $1', [provider]
    );
    return rows[0] || null;
  }

  async save(provider, session) {
    await this.pool.query(
      `INSERT INTO provider_sessions
         (provider, phone_number, merchant_id, outlet_name, access_token, refresh_token, device_id, expires_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (provider) DO UPDATE SET
         phone_number = EXCLUDED.phone_number,
         merchant_id  = EXCLUDED.merchant_id,
         outlet_name  = EXCLUDED.outlet_name,
         access_token = EXCLUDED.access_token,
         refresh_token= EXCLUDED.refresh_token,
         device_id    = EXCLUDED.device_id,
         expires_at   = EXCLUDED.expires_at,
         updated_at   = now()`,
      [provider, session.phoneNumber ?? null, session.merchantId ?? null, session.outletName ?? null,
       session.accessToken ?? null, session.refreshToken ?? null, session.deviceId ?? null,
       session.expiresAt ?? null]
    );
  }
}

/**
 * Menjaga access token GoPay tetap berlaku.
 *
 * Diperbarui 5 menit sebelum kedaluwarsa: memperbaruinya tepat saat kedaluwarsa
 * membuat permintaan yang sedang berjalan gagal dengan 401.
 */
class SessionManager {
  constructor({ store, http, deviceId, provider = 'gopay' }) {
    this.store = store;
    this.provider = provider;
    this.deviceId = deviceId;
    this.goid = new GoIdClient({ http, deviceId });
    this._refreshing = null;
  }

  async getAccessToken(now = Date.now()) {
    const session = await this.store.load(this.provider);
    if (!session || !session.access_token) {
      throw new Error('Sesi GoPay belum tersedia. Jalankan login OTP lewat POST /admin/api/gopay/login.');
    }
    const expiresAt = session.expires_at ? Date.parse(session.expires_at) : 0;
    if (expiresAt - now > 5 * 60_000) return session.access_token;

    if (!session.refresh_token) {
      throw new Error('Sesi GoPay kedaluwarsa dan tidak ada refresh token; perlu login OTP ulang.');
    }
    // Permintaan yang tumpang tindih berbagi satu refresh; dua refresh paralel
    // membuat GoID membatalkan salah satu token.
    if (!this._refreshing) {
      this._refreshing = (async () => {
        try {
          const tokens = await this.goid.refresh(session.refresh_token, session.phone_number);
          await this.store.save(this.provider, {
            ...camel(session),
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? session.refresh_token,
            expiresAt: tokens.expiresAt,
            deviceId: this.deviceId,
          });
          return tokens.accessToken;
        } finally { this._refreshing = null; }
      })();
    }
    return this._refreshing;
  }

  /** Langkah 1 login: kirim OTP ke nomor merchant. */
  async startLogin(phone) { return this.goid.requestOtp(phone); }

  /** Langkah 2 login: tukar OTP dengan token lalu simpan sesinya. */
  async completeLogin(phone, otpToken, otp) {
    const tokens = await this.goid.verifyOtp(otpToken, otp);
    let merchant = { merchantId: null, outletName: null };
    try { merchant = await this.goid.fetchMerchantConfig(tokens.accessToken); }
    catch { /* profil bersifat kosmetik; sesi tetap sah tanpanya */ }
    await this.store.save(this.provider, {
      phoneNumber: phone, merchantId: merchant.merchantId, outletName: merchant.outletName,
      accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
      deviceId: this.deviceId, expiresAt: tokens.expiresAt,
    });
    return { merchantId: merchant.merchantId, outletName: merchant.outletName, expiresAt: tokens.expiresAt };
  }
}

function camel(row) {
  return {
    phoneNumber: row.phone_number, merchantId: row.merchant_id, outletName: row.outlet_name,
    accessToken: row.access_token, refreshToken: row.refresh_token,
    deviceId: row.device_id, expiresAt: row.expires_at,
  };
}

module.exports = { SessionStore, SessionManager };
