'use strict';

const { SessionManager } = require('./session');
const { buildHeaders } = require('./goid');
const { generateDynamicQRIS } = require('../../lib/qris');
const { rawProviderAmount, providerAmount } = require('../../lib/providerAmount');

const TRANSACTIONS_URL =
  'https://api.gojekapi.com/merchant-analytics/v2/merchants/transactions';

/**
 * Adapter GoPay hasil rekayasa balik — jalur cadangan.
 *
 * Dipakai bila kredensial GoBiz Open API belum tersedia. Keterbatasannya nyata
 * dan disengaja untuk didokumentasikan, bukan disembunyikan:
 *
 *   - Tidak ada webhook. Pelunasan hanya diketahui dengan memoll mutasi.
 *   - Tidak ada korelasi order_id. Pembayaran dicocokkan lewat nominal unik,
 *     karena itulah satu-satunya pembeda yang tersedia. Maka dua invoice
 *     PENDING bernominal sama dilarang di tingkat database.
 *   - Bergantung pada API internal GoJek yang bisa berubah tanpa pemberitahuan.
 *
 * Pindah ke provider gobiz begitu kredensial resmi ada.
 */
class GopayProvider {
  static id = 'gopay';

  constructor({ http, sessionStore, deviceId, qrisStatic, unique, amountScale = 100, log = null }) {
    this.amountScale = amountScale;
    this.http = http;
    this.qrisStatic = qrisStatic;
    this.unique = unique;
    this.session = new SessionManager({ store: sessionStore, http, deviceId, log });
  }

  /** Nominal unik adalah satu-satunya cara mencocokkan pembayaran di jalur ini. */
  get needsUniqueAmount() { return true; }
  get supportsWebhook() { return false; }

  /**
   * Membuat QRIS dinamis secara lokal dari QRIS statis merchant.
   *
   * Tidak ada panggilan ke GoPay di sini: QRIS dinamis murni penyuntingan
   * payload EMVCo, jadi nominal dan reference ditanamkan sendiri.
   */
  async createCharge({ orderId, amount, reference }) {
    if (!this.qrisStatic) {
      throw Object.assign(
        new Error('QRIS_STATIC belum diisi; adapter gopay tidak bisa membuat QRIS'),
        { statusCode: 503 }
      );
    }
    const qris = generateDynamicQRIS(this.qrisStatic, amount, reference);
    return {
      providerTransactionId: null, // baru diketahui setelah mutasi cocok
      qrisPayload: qris,
      status: 'PENDING',
      raw: { order_id: orderId, reference },
    };
  }

  /**
   * Mutasi merchant terbaru, dipakai worker rekonsiliasi.
   *
   * Merchant Analytics menolak permintaan tanpa merchant_ids dan rentang waktu
   * (HTTP 400). merchant_id diambil dari sesi hasil login, bukan dari
   * environment, supaya tidak ada yang perlu diisi manual sesudah OTP.
   */
  async listTransactions({ limit = 50, windowHours = 24 } = {}) {
    const token = await this.session.getAccessToken();
    const merchantId = await this.session.merchantId();
    if (!merchantId) {
      throw Object.assign(
        new Error('merchant_id belum diketahui. Ambil profil merchant dulu di konsol (menu Provider).'),
        { statusCode: 409 }
      );
    }

    const now = new Date();
    const params = new URLSearchParams({
      from: '0',
      size: String(limit),
      statuses: 'SETTLEMENT,CAPTURE',
      payment_types: 'QRIS,GOPAY',
      start_time: new Date(now.getTime() - windowHours * 3600_000).toISOString(),
      end_time: now.toISOString(),
      merchant_ids: merchantId,
    });

    const res = await this.http(`${TRANSACTIONS_URL}?${params}`, {
      method: 'GET',
      headers: buildHeaders(this.session.deviceId, { Authorization: `Bearer ${token}` }),
    });
    if (res.status < 200 || res.status >= 300) {
      const detail = res.data?.message || res.data?.error || '';
      throw new Error(`GoPay merchant-analytics gagal (HTTP ${res.status})${detail ? ': ' + detail : ''}`);
    }
    const list = res.data?.data?.transactions ?? res.data?.transactions ?? res.data?.data ?? [];
    return (Array.isArray(list) ? list : [])
      .map((t) => normalizeTransaction(t, this.amountScale))
      .filter(Boolean);
  }
}

/**
 * Menyeragamkan bentuk mutasi.
 *
 * Nominal ditafsirkan sekali dengan skala yang ditetapkan, bukan ditawarkan
 * sebagai beberapa kemungkinan. Mutasi yang nominalnya tidak masuk akal pada
 * skala itu dibuang daripada dicocokkan dengan tafsir lain.
 */
function normalizeTransaction(tx, scale = 100) {
  if (!tx) return null;
  const id = tx.id ?? tx.transaction_id ?? tx.reference_id ?? null;
  if (!id) return null;
  const amount = providerAmount(tx, scale);
  if (amount === null) return null;
  return {
    providerTransactionId: String(id),
    amount,
    amountRaw: rawProviderAmount(tx),
    amountScale: scale,
    transactionTime: tx.transaction_time ?? tx.created_at ?? tx.time ?? null,
    reference: tx.reference ?? tx.merchant_reference ?? null,
    raw: tx,
  };
}

module.exports = { GopayProvider, normalizeTransaction, TRANSACTIONS_URL };
