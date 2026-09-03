'use strict';

const crypto = require('crypto');
const { GobizOAuth } = require('./oauth');

/**
 * Adapter provider GoBiz — jalur pembayaran QRIS resmi.
 *
 * Dibandingkan adapter gopay hasil rekayasa balik, adapter ini tidak perlu
 * nominal unik maupun polling mutasi: GoBiz mengembalikan transaction_id dan
 * mengirim webhook, sehingga korelasi pembayaran bersifat eksak, bukan tebakan
 * berdasarkan nominal.
 */
class GobizProvider {
  static id = 'gobiz';

  constructor({ http, clientId, clientSecret, outletId, sandbox = false }) {
    this.http = http;
    this.outletId = outletId;
    this.oauth = new GobizOAuth({ http, clientId, clientSecret, sandbox });
  }

  /** Nominal unik tidak diperlukan: korelasi memakai order_id resmi. */
  get needsUniqueAmount() { return false; }
  /** Pelunasan datang lewat webhook, bukan polling. */
  get supportsWebhook() { return true; }

  async #call(path, { method = 'GET', body, headers = {} } = {}, retryOn401 = true) {
    const token = await this.oauth.getAccessToken();
    const res = await this.http(`${this.oauth.apiBase}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body,
    });
    if (res.status === 401 && retryOn401) {
      this.oauth.invalidate();
      return this.#call(path, { method, body, headers }, false);
    }
    if (res.status < 200 || res.status >= 300) {
      const first = res.data?.errors?.[0];
      const detail = first ? `${first.message_title ?? ''} ${first.message ?? ''}`.trim() : '';
      throw new Error(`GoBiz ${method} ${path} gagal (HTTP ${res.status})${detail ? ': ' + detail : ''}`);
    }
    return res.data?.data ?? res.data;
  }

  /**
   * Membuat transaksi QRIS.
   *
   * Idempotency-Key diturunkan dari order_id sehingga percobaan ulang akibat
   * timeout jaringan tidak menghasilkan dua tagihan untuk satu pesanan.
   */
  async createCharge({ orderId, amount, currency = 'IDR', customer, metadata }) {
    const idempotencyKey = crypto.createHash('sha256').update(`${this.outletId}:${orderId}`)
      .digest('hex').slice(0, 32);

    const data = await this.#call(
      `/integrations/payment/outlets/${encodeURIComponent(this.outletId)}/v2/transactions`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: {
          payment_type: 'qris',
          transaction_details: { order_id: orderId, gross_amount: amount, currency },
          ...(customer ? { customer_details: customer } : {}),
          ...(metadata ? { metadata } : {}),
        },
      }
    );

    const trx = data?.transaction ?? {};
    return {
      providerTransactionId: trx.id ?? null,
      qrisPayload: trx.qris_string ?? null,
      status: mapStatus(trx.status),
      raw: data,
    };
  }

  async getCharge(providerTransactionId) {
    const data = await this.#call(
      `/integrations/payment/outlets/${encodeURIComponent(this.outletId)}/v1/transactions/${encodeURIComponent(providerTransactionId)}`
    );
    const trx = data?.transaction ?? {};
    return {
      providerTransactionId: trx.id ?? providerTransactionId,
      status: mapStatus(trx.status),
      amount: Number(trx.gross_amount) || null,
      settledAt: trx.settlement_at ?? null,
      raw: data,
    };
  }

  /** Mendaftarkan URL webhook kita ke GoBiz agar pelunasan dipush, bukan dipoll. */
  async subscribeWebhook(event, url) {
    return this.#call('/integrations/partner/v1/notification-subscriptions', {
      method: 'POST',
      body: { event, url, active: true },
    });
  }

  async listWebhookSubscriptions() {
    return this.#call('/integrations/partner/v1/notification-subscriptions');
  }
}

/** Status GoBiz dipetakan ke kosakata ledger kita. */
function mapStatus(status) {
  switch (String(status || '').toLowerCase()) {
    case 'settlement': case 'success': case 'capture': case 'paid': return 'PAID';
    case 'pending': return 'PENDING';
    case 'expire': case 'expired': return 'EXPIRED';
    case 'cancel': case 'cancelled': return 'CANCELLED';
    case 'deny': case 'failure': case 'failed': return 'FAILED';
    default: return 'PENDING';
  }
}

module.exports = { GobizProvider, mapStatus };
