'use strict';

/**
 * OAuth 2.0 client_credentials untuk GoBiz Open API.
 *
 * Ini jalur resmi, berbeda dari src/providers/gopay/goid.js yang memakai OTP
 * merchant. Token berumur 3600 detik dan di-cache di memori: memintanya ulang
 * pada tiap panggilan akan membuat GoBiz membatasi laju kita.
 */

const HOSTS = {
  production: { oauth: 'https://accounts.go-jek.com', api: 'https://api.gobiz.co.id' },
  sandbox: { oauth: 'https://integration-goauth.gojekapi.com', api: 'https://api.partner-sandbox.gobiz.co.id' },
};

// Scope minimum untuk membuat dan membaca transaksi QRIS serta memasang webhook.
const DEFAULT_SCOPES = ['payment:transaction:write', 'payment:transaction:read', 'partner:outlet:read'];

class GobizOAuth {
  constructor({ http, clientId, clientSecret, sandbox = false, scopes = DEFAULT_SCOPES }) {
    if (typeof http !== 'function') throw new Error('http client wajib diinjeksi');
    if (!clientId || !clientSecret) throw new Error('clientId dan clientSecret wajib diisi');
    this.http = http;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.hosts = sandbox ? HOSTS.sandbox : HOSTS.production;
    this.scopes = scopes;
    this._token = null;
    this._expiresAt = 0;
    this._inflight = null;
  }

  get apiBase() { return this.hosts.api; }

  /**
   * Token yang masih berlaku, diambil dari cache bila memungkinkan.
   *
   * Permintaan yang tumpang tindih berbagi satu panggilan (_inflight) supaya
   * lonjakan trafik tidak memicu puluhan permintaan token sekaligus.
   */
  async getAccessToken(now = Date.now()) {
    // Diperbarui 60 detik lebih awal agar token tidak kedaluwarsa di tengah jalan.
    if (this._token && now < this._expiresAt - 60_000) return this._token;
    if (this._inflight) return this._inflight;

    this._inflight = (async () => {
      try {
        const res = await this.http(`${this.hosts.oauth}/oauth2/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          form: {
            client_id: this.clientId,
            client_secret: this.clientSecret,
            grant_type: 'client_credentials',
            scope: this.scopes.join(' '),
          },
        });
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`GoBiz OAuth gagal (HTTP ${res.status})`);
        }
        const token = res.data?.access_token;
        if (!token) throw new Error('GoBiz OAuth tidak mengembalikan access_token');
        const ttl = Number(res.data.expires_in) > 0 ? Number(res.data.expires_in) : 3600;
        this._token = token;
        this._expiresAt = Date.now() + ttl * 1000;
        return token;
      } finally {
        this._inflight = null;
      }
    })();
    return this._inflight;
  }

  /** Membuang cache token; dipanggil saat API menjawab 401. */
  invalidate() { this._token = null; this._expiresAt = 0; }
}

module.exports = { GobizOAuth, HOSTS, DEFAULT_SCOPES };
