'use strict';

/**
 * Protokol autentikasi GoID (GoBiz).
 *
 * Menggantikan login.js dan sessionManager.js yang terobfuskasi. Kontraknya
 * dipulihkan dengan memuat modul lama sementara seluruh soket dimatikan, lalu
 * mencatat permintaan yang hendak dikirim. Semua endpoint di bawah ini adalah
 * API yang sama dengan yang dipanggil dashboard GoBiz web.
 *
 * Alurnya tiga langkah:
 *   1. requestOtp(phone)            -> otp_token, OTP dikirim via SMS/WA
 *   2. verifyOtp(otpToken, otp)     -> access_token + refresh_token
 *   3. refresh(refreshToken, phone) -> pasangan token baru
 *
 * Tidak ada state di modul ini: pemanggil yang menyimpan token. Itu membuatnya
 * bisa diuji tanpa jaringan dan tanpa berkas.
 */

const BASE_URL = 'https://api.gobiz.co.id';
const CLIENT_ID = 'go-biz-web-new';
const PORTAL_ORIGIN = 'https://portal.gofoodmerchant.co.id';

/**
 * Header identitas dashboard GoBiz web. GoID menolak permintaan yang tidak
 * menyerupai klien resmi, jadi nilai-nilai ini bukan hiasan.
 *
 * `deviceId` sebaiknya stabil per instalasi — GoID memperlakukan perangkat baru
 * sebagai sinyal risiko dan dapat memaksa OTP ulang bila terus berubah.
 */
function buildHeaders(deviceId, extra = {}) {
  if (!deviceId) throw new Error('deviceId wajib diisi; pakai UUID tetap per instalasi');
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'id',
    'authentication-type': 'go-id',
    'content-type': 'application/json',
    'gojek-country-code': 'ID',
    'gojek-timezone': 'Asia/Jakarta',
    origin: PORTAL_ORIGIN,
    referer: `${PORTAL_ORIGIN}/`,
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    'x-appid': 'go-biz-web-dashboard',
    'x-appversion': 'platform-v3.111.0-1708bc9a',
    'x-deviceos': 'Web',
    'x-phonemake': 'Windows 10 64-bit',
    'x-phonemodel': 'Chrome 150.0.0.0 on Windows 10 64-bit',
    'x-platform': 'Web',
    'x-uniqueid': deviceId,
    'x-user-locale': 'en-GB',
    'x-user-type': 'merchant',
    ...extra,
  };
}

/**
 * GoID memisahkan kode negara dari nomor dan menolak angka nol di depan.
 * Menerima "081234567890", "81234567890", "+6281234567890", "6281234567890".
 */
function normalizePhone(input) {
  const digits = String(input ?? '').replace(/[^\d]/g, '');
  if (!digits) throw new Error('Nomor HP kosong');

  let national = digits;
  if (national.startsWith('62')) national = national.slice(2);
  else if (national.startsWith('0')) national = national.replace(/^0+/, '');

  // Nomor seluler Indonesia: 9-13 digit sesudah kode negara, selalu diawali 8.
  if (!/^8\d{8,12}$/.test(national)) {
    throw new Error(`Nomor HP tidak valid: ${input}`);
  }
  return { countryCode: '62', phoneNumber: national, e164: `+62${national}` };
}

class GoIdClient {
  /**
   * @param {object} opts
   * @param {function} opts.http  fungsi (url, {method, headers, body}) -> {status, data}
   * @param {string}   opts.deviceId UUID tetap per instalasi
   */
  constructor({ http, deviceId }) {
    if (typeof http !== 'function') throw new Error('http client wajib diinjeksi');
    this.http = http;
    this.deviceId = deviceId;
  }

  async #post(path, body, extraHeaders) {
    const res = await this.http(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: buildHeaders(this.deviceId, extraHeaders),
      body,
    });
    if (res.status < 200 || res.status >= 300) {
      const detail = res.data && (res.data.message || res.data.error_description || res.data.error);
      throw new Error(`GoID ${path} gagal (HTTP ${res.status})${detail ? ': ' + detail : ''}`);
    }
    return res.data;
  }

  /** Langkah 1 — meminta OTP dikirim ke nomor merchant. */
  async requestOtp(phone) {
    const { countryCode, phoneNumber } = normalizePhone(phone);
    const data = await this.#post('/goid/login/request', {
      client_id: CLIENT_ID,
      phone_number: phoneNumber,
      country_code: countryCode,
    });
    const payload = data?.data ?? data;
    const otpToken = payload?.otp_token;
    if (!otpToken) throw new Error('GoID tidak mengembalikan otp_token');
    return {
      otpToken,
      otpLength: payload?.otp_length ?? 4,
      expiresInSeconds: payload?.otp_expires_in ?? null,
    };
  }

  /** Langkah 2 — menukar OTP dengan sepasang token. */
  async verifyOtp(otpToken, otp) {
    const data = await this.#post('/goid/token', {
      client_id: CLIENT_ID,
      grant_type: 'otp',
      data: { otp: String(otp), otp_token: otpToken },
    });
    return toTokens(data);
  }

  /**
   * Langkah 3 — menukar refresh token dengan pasangan baru.
   *
   * GoID menuntut nomor HP ikut dikirim di sini, tidak cukup refresh token saja.
   */
  async refresh(refreshToken, phone) {
    const { countryCode, phoneNumber } = normalizePhone(phone);
    const data = await this.#post('/goid/token', {
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      data: { refresh_token: refreshToken, phone_number: phoneNumber, country_code: countryCode },
    });
    return toTokens(data);
  }

  /** Profil merchant/outlet, dipakai untuk melabeli sesi agar mudah dikenali. */
  async fetchMerchantConfig(accessToken) {
    const res = await this.http(`${BASE_URL}/goresto/v5/public/users/config`, {
      method: 'GET',
      headers: buildHeaders(this.deviceId, { Authorization: `Bearer ${accessToken}` }),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GoID users/config gagal (HTTP ${res.status})`);
    }
    // Bentuknya bersarang: { data: { merchant: {...}, user: {...}, features: [...] } }.
    // Versi awal membaca dari akar sehingga selalu mengembalikan null tanpa galat.
    const payload = res.data?.data ?? res.data ?? {};
    const m = payload.merchant ?? {};
    return {
      merchantId: m.id ?? m.tags?.merchant_id?.[0] ?? null,
      outletName: m.outlet_name ?? null,
      outletAddress: m.outlet_address ?? null,
      timezone: m.timezone ?? null,
      kycStatus: m.kyc_status ?? null,
      // features menyebut produk yang aktif, mis. "GO-PAY STATIC QR".
      features: (payload.features ?? []).map((f) => f.product_type).filter(Boolean),
      raw: payload,
    };
  }
}

/**
 * GoID membungkus token dalam `data` pada sebagian respons dan tidak pada
 * sebagian lain, jadi kedua bentuk diterima.
 */
function toTokens(body) {
  const payload = body?.data ?? body;
  const accessToken = payload?.access_token;
  const refreshToken = payload?.refresh_token;
  if (!accessToken) throw new Error('GoID tidak mengembalikan access_token');

  // expires_in dalam detik. Tanpa itu, anggap 24 jam seperti perilaku klien lama.
  const ttlSeconds = Number(payload?.expires_in) > 0 ? Number(payload.expires_in) : 24 * 3600;
  return {
    accessToken,
    refreshToken: refreshToken ?? null,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  };
}

module.exports = { GoIdClient, buildHeaders, normalizePhone, toTokens, BASE_URL, CLIENT_ID };
