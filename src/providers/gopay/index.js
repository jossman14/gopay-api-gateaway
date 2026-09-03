'use strict';

const { SessionManager } = require('./session');
const { buildHeaders } = require('./goid');
const { generateDynamicQRIS } = require('../../lib/qris');
const { rawProviderAmount, providerAmountCandidates } = require('../../lib/providerAmount');

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

  constructor({ http, sessionStore, deviceId, qrisStatic, unique }) {
    this.http = http;
    this.qrisStatic = qrisStatic;
    this.unique = unique;
    this.session = new SessionManager({ store: sessionStore, http, deviceId });
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
    if (!this.qrisStatic) throw new Error('QRIS_STATIC belum diisi; adapter gopay tidak bisa membuat QRIS');
    const qris = generateDynamicQRIS(this.qrisStatic, amount, reference);
    return {
      providerTransactionId: null, // baru diketahui setelah mutasi cocok
      qrisPayload: qris,
      status: 'PENDING',
      raw: { order_id: orderId, reference },
    };
  }

  /** Mutasi merchant terbaru, dipakai worker rekonsiliasi. */
  async listTransactions({ limit = 50 } = {}) {
    const token = await this.session.getAccessToken();
    const res = await this.http(`${TRANSACTIONS_URL}?limit=${limit}`, {
      method: 'GET',
      headers: buildHeaders(this.session.deviceId, { Authorization: `Bearer ${token}` }),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GoPay merchant-analytics gagal (HTTP ${res.status})`);
    }
    const list = res.data?.data?.transactions ?? res.data?.transactions ?? res.data?.data ?? [];
    return (Array.isArray(list) ? list : []).map(normalizeTransaction).filter(Boolean);
  }
}

/**
 * Menyeragamkan bentuk mutasi.
 *
 * Merchant Analytics kadang mengembalikan IDR dalam satuan minor (Rp11 terbaca
 * 1100). Kedua tafsir dibawa serta agar pencocokan bisa mencoba nominal mentah
 * lebih dulu lalu fallback, dan hasilnya tetap bisa diaudit.
 */
function normalizeTransaction(tx) {
  if (!tx) return null;
  const id = tx.id ?? tx.transaction_id ?? tx.reference_id ?? null;
  if (!id) return null;
  return {
    providerTransactionId: String(id),
    amountCandidates: providerAmountCandidates(tx),
    amountRaw: rawProviderAmount(tx),
    transactionTime: tx.transaction_time ?? tx.created_at ?? tx.time ?? null,
    reference: tx.reference ?? tx.merchant_reference ?? null,
    raw: tx,
  };
}

module.exports = { GopayProvider, normalizeTransaction, TRANSACTIONS_URL };
