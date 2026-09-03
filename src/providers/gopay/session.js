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
  constructor({ store, http, deviceId, provider = 'gopay', log = null }) {
    this.store = store;
    this.provider = provider;
    this.deviceId = deviceId;
    this.log = log;
    this.goid = new GoIdClient({ http, deviceId });
    this._refreshing = null;
    this.lastProfileError = null;
    this._merchantId = null;
  }

  async getAccessToken(now = Date.now()) {
    const session = await this.store.load(this.provider);
    if (!session || !session.access_token) {
      throw new Error('Sesi GoPay belum tersedia. Jalankan login OTP lewat konsol di /hehehe (menu Provider).');
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
    try {
      merchant = await this.goid.fetchMerchantConfig(tokens.accessToken);
    } catch (err) {
      // Sesi tetap sah tanpa profil, tapi kegagalannya dicatat. Menelannya diam-diam
      // membuat "Outlet: —" tampak seperti apa adanya, padahal ada panggilan gagal.
      this.lastProfileError = err.message;
      this.log?.(`profil merchant gagal diambil: ${err.message}`);
    }
    await this.store.save(this.provider, {
      phoneNumber: phone, merchantId: merchant.merchantId, outletName: merchant.outletName,
      accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
      deviceId: this.deviceId, expiresAt: tokens.expiresAt,
    });
    return { merchantId: merchant.merchantId, outletName: merchant.outletName, expiresAt: tokens.expiresAt };
  }

  /**
   * Memperbarui token bila mendekati kedaluwarsa, terlepas dari ada tidaknya
   * trafik.
   *
   * Tanpa ini sesi bisa mati sendiri: getAccessToken hanya terpanggil ketika ada
   * invoice PENDING yang perlu dicocokkan, sehingga masa tenang beberapa hari
   * membuat access token kedaluwarsa dan rantai refresh terputus — dan
   * pemulihannya menuntut OTP ulang.
   */
  async keepAlive(now = Date.now()) {
    const session = await this.store.load(this.provider);
    if (!session?.refresh_token) return { refreshed: false, reason: 'belum ada sesi' };

    const expiresAt = session.expires_at ? Date.parse(session.expires_at) : 0;
    // Diperbarui saat tersisa kurang dari sepertiga umur token, jadi ada banyak
    // kesempatan mencoba lagi sebelum benar-benar kedaluwarsa.
    if (expiresAt - now > 8 * 3600_000) return { refreshed: false, reason: 'masih lama' };

    await this.getAccessToken(now);
    return { refreshed: true };
  }

  /** Mengambil ulang profil merchant memakai sesi yang ada. */
  async refreshProfile() {
    const token = await this.getAccessToken();
    const merchant = await this.goid.fetchMerchantConfig(token);
    const session = await this.store.load(this.provider);
    await this.store.save(this.provider, {
      ...camel(session),
      merchantId: merchant.merchantId,
      outletName: merchant.outletName,
      deviceId: this.deviceId,
    });
    this.lastProfileError = null;
    this._merchantId = merchant.merchantId;
    return merchant;
  }

  /** merchant_id dari sesi; diambil sekali lalu di-cache. */
  async merchantId() {
    if (this._merchantId) return this._merchantId;
    const s = await this.store.load(this.provider);
    if (s?.merchant_id) return (this._merchantId = s.merchant_id);
    // Belum tersimpan: coba ambil profilnya sekarang agar rekonsiliasi tidak
    // menunggu operator menekan tombol.
    try {
      const m = await this.refreshProfile();
      return (this._merchantId = m.merchantId);
    } catch { return null; }
  }

  /** Ringkasan sesi untuk konsol. Token tidak pernah ikut. */
  async status() {
    const s = await this.store.load(this.provider);
    if (!s) return { connected: false };
    return {
      connected: Boolean(s.access_token),
      phone_number: s.phone_number,
      merchant_id: s.merchant_id,
      outlet_name: s.outlet_name,
      has_refresh_token: Boolean(s.refresh_token),
      expires_at: s.expires_at,
      updated_at: s.updated_at,
      last_profile_error: this.lastProfileError,
    };
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
