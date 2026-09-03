'use strict';

const crypto = require('crypto');

/**
 * Adapter Mayar.
 *
 * soal sudah memakai Mayar sebelum gateway ini ada. Adapter ini membuat
 * pemasukan dari sana tercatat di ledger yang sama dengan QRIS GoBiz, sehingga
 * laporan pemasukan utuh alih-alih terpecah di dua sistem.
 */

const HOSTS = {
  production: 'https://api.mayar.id/hl/v1',
  sandbox: 'https://api.mayar.club/hl/v1',
};

class MayarProvider {
  static id = 'mayar';

  constructor({ http, apiKey, webhookToken, sandbox = false }) {
    if (typeof http !== 'function') throw new Error('http client wajib diinjeksi');
    if (!apiKey) throw new Error('Mayar apiKey wajib diisi');
    this.http = http;
    this.apiKey = apiKey;
    this.webhookToken = webhookToken || null;
    this.base = sandbox ? HOSTS.sandbox : HOSTS.production;
  }

  get needsUniqueAmount() { return false; }
  get supportsWebhook() { return true; }

  async #call(path, { method = 'GET', body } = {}) {
    const res = await this.http(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body,
    });
    if (res.status < 200 || res.status >= 300) {
      const detail = res.data?.messages || res.data?.message;
      throw new Error(`Mayar ${method} ${path} gagal (HTTP ${res.status})${detail ? ': ' + detail : ''}`);
    }
    return res.data?.data ?? res.data;
  }

  async createCharge({ orderId, amount, customer, description }) {
    const data = await this.#call('/invoice/create', {
      method: 'POST',
      body: {
        name: customer?.first_name || 'Pelanggan',
        email: customer?.email || 'noreply@example.com',
        mobile: customer?.phone || undefined,
        description: description || `Order ${orderId}`,
        expiredAt: undefined,
        items: [{ quantity: 1, rate: amount, description: description || orderId }],
      },
    });
    return {
      providerTransactionId: data?.id ?? null,
      paymentUrl: data?.link ?? null,
      qrisPayload: null,
      status: 'PENDING',
      raw: data,
    };
  }

  async getCharge(providerTransactionId) {
    const data = await this.#call(`/invoice/${encodeURIComponent(providerTransactionId)}`);
    return {
      providerTransactionId,
      status: mapStatus(data?.status),
      amount: Number(data?.amount) || null,
      raw: data,
    };
  }

  /**
   * Memverifikasi webhook masuk.
   *
   * Tanpa ini siapa pun yang tahu URL callback bisa menandai invoice lunas.
   * Perbandingan memakai timingSafeEqual agar tidak bocor lewat waktu respons.
   */
  verifyWebhook(headers) {
    if (!this.webhookToken) return false;
    const raw = headers?.['x-callback-token'] || headers?.['X-Callback-Token'];
    if (!raw) return false;
    const a = Buffer.from(String(raw));
    const b = Buffer.from(this.webhookToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}

function mapStatus(status) {
  switch (String(status || '').toLowerCase()) {
    case 'paid': case 'settled': case 'success': return 'PAID';
    case 'expired': return 'EXPIRED';
    case 'closed': case 'cancelled': return 'CANCELLED';
    case 'failed': return 'FAILED';
    default: return 'PENDING';
  }
}

module.exports = { MayarProvider, mapStatus, HOSTS };
