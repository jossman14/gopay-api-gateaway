'use strict';

const { parseTLV, calculateCRC16, generateDynamicQRIS } = require('../lib/qris');

/**
 * Membedah payload QRIS untuk keperluan pemeriksaan.
 *
 * Salah menempelkan QRIS statis adalah kesalahan yang mahal: QR-nya tetap
 * tercetak dan tetap bisa dipindai, tapi uangnya mengalir ke merchant lain atau
 * gagal sama sekali. Memeriksanya lebih dulu jauh lebih murah daripada
 * menemukannya dari pembeli yang komplain.
 */

/** Label tag EMVCo yang relevan untuk QRIS Indonesia. */
const TAG_LABELS = {
  '00': 'Versi format payload',
  '01': 'Metode inisiasi (11 statis, 12 dinamis)',
  '51': 'Merchant account (QRIS domestik)',
  '52': 'Kode kategori merchant (MCC)',
  '53': 'Kode mata uang (360 = IDR)',
  '54': 'Nominal transaksi',
  '55': 'Indikator tip',
  '58': 'Kode negara',
  '59': 'Nama merchant',
  '60': 'Kota merchant',
  '61': 'Kode pos',
  '62': 'Data tambahan (referensi ada di 62.05)',
  '63': 'CRC',
};

function inspect(payload) {
  const raw = String(payload || '').trim();
  if (!raw) throw Object.assign(new Error('Payload QRIS kosong'), { statusCode: 400 });

  const problems = [];

  // CRC: 4 hex terakhir, dihitung atas seluruh isi termasuk penanda "6304".
  let crcOk = null;
  const crcPos = raw.lastIndexOf('6304');
  if (crcPos === -1 || crcPos !== raw.length - 8) {
    problems.push('Tidak ditemukan tag CRC "6304" di akhir payload.');
  } else {
    const expected = calculateCRC16(raw.slice(0, crcPos + 4));
    const actual = raw.slice(crcPos + 4).toUpperCase();
    crcOk = expected === actual;
    if (!crcOk) problems.push(`CRC tidak cocok: tertulis ${actual}, seharusnya ${expected}. Payload kemungkinan terpotong atau salah salin.`);
  }

  let tags = [];
  try {
    tags = parseTLV(crcPos === raw.length - 8 ? raw.slice(0, crcPos) : raw);
  } catch (err) {
    throw Object.assign(new Error(`Struktur TLV tidak sah: ${err.message}`), { statusCode: 400 });
  }

  const byTag = Object.fromEntries(tags.map((t) => [t.tag, t.val]));
  const method = byTag['01'];
  const currency = byTag['53'];

  if (!byTag['59']) problems.push('Nama merchant (tag 59) tidak ada.');
  if (currency && currency !== '360') problems.push(`Mata uang ${currency} bukan IDR (360).`);
  if (method === '12') problems.push('Ini QRIS DINAMIS (tag 01 = 12), sudah memuat nominal. Yang dibutuhkan gateway adalah QRIS STATIS (01 = 11).');
  if (byTag['54']) problems.push(`Payload sudah memuat nominal Rp${byTag['54']} — ciri QR dinamis sekali pakai, bukan QRIS statis merchant.`);

  return {
    valid: problems.length === 0,
    crc_ok: crcOk,
    is_static: method === '11',
    merchant_name: byTag['59'] ?? null,
    merchant_city: byTag['60'] ?? null,
    currency: currency ?? null,
    country: byTag['58'] ?? null,
    length: raw.length,
    tags: tags.map((t) => ({
      tag: t.tag,
      label: TAG_LABELS[t.tag] ?? null,
      // Tag 51 memuat identitas merchant; dipotong agar tidak seluruhnya
      // tercetak di layar yang bisa terlihat orang lain.
      value: t.tag === '51' && t.val.length > 16 ? `${t.val.slice(0, 12)}…(${t.val.length} karakter)` : t.val,
    })),
    problems,
  };
}

/** Membuat QRIS dinamis percobaan dari sebuah payload statis. */
function preview(staticPayload, amount, reference) {
  const source = inspect(staticPayload);
  if (source.crc_ok === false) {
    throw Object.assign(new Error('CRC payload sumber tidak sah; perbaiki dulu sebelum diuji.'), { statusCode: 400 });
  }
  const dynamic = generateDynamicQRIS(staticPayload, Number(amount), reference || null);
  return { source, dynamic, dynamicInspect: inspect(dynamic) };
}

module.exports = { inspect, preview, TAG_LABELS };
