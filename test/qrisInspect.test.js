'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspect, preview } = require('../src/domain/qrisInspect');
const { calculateCRC16 } = require('../src/lib/qris');

/** TLV yang benar: tag + panjang 2 digit + nilai. */
function tlv(tag, val) {
  return `${tag}${String(val.length).padStart(2, '0')}${val}`;
}

/** Membangun QRIS statis sederhana yang CRC-nya benar. */
function buildStatic({ method = '11', extra = '' } = {}) {
  const body =
    tlv('00', '01') +
    tlv('01', method) +
    tlv('51', 'ID.CO.QRIS.WWW') +
    tlv('52', '5812') +
    tlv('53', '360') +
    tlv('58', 'ID') +
    tlv('59', 'TOKO PERCOBAAN') +
    tlv('60', 'JAKARTA') +
    extra;
  const withMarker = body + '6304';
  return withMarker + calculateCRC16(withMarker);
}

test('QRIS statis yang sah dinyatakan valid', () => {
  const r = inspect(buildStatic());
  assert.equal(r.valid, true, r.problems.join('; '));
  assert.equal(r.crc_ok, true);
  assert.equal(r.is_static, true);
  assert.equal(r.merchant_name, 'TOKO PERCOBAAN');
  assert.equal(r.merchant_city, 'JAKARTA');
  assert.equal(r.currency, '360');
});

test('CRC salah terdeteksi, bukan diam-diam diterima', () => {
  const q = buildStatic();
  const rusak = q.slice(0, -4) + '0000';
  const r = inspect(rusak);
  assert.equal(r.crc_ok, false);
  assert.match(r.problems.join(' '), /CRC tidak cocok/);
});

test('QRIS dinamis ditolak sebagai sumber — gateway butuh yang statis', () => {
  const r = inspect(buildStatic({ method: '12' }));
  assert.equal(r.is_static, false);
  assert.match(r.problems.join(' '), /DINAMIS/);
});

test('payload yang sudah memuat nominal ditandai', () => {
  const r = inspect(buildStatic({ extra: tlv('54', '1000') }));
  assert.match(r.problems.join(' '), /sudah memuat nominal/);
});

test('payload kosong dan sampah ditolak dengan status 400', () => {
  assert.throws(() => inspect(''), (e) => e.statusCode === 400);
  assert.throws(() => inspect('bukan-qris'), (e) => e.statusCode === 400);
});

test('preview menghasilkan QRIS dinamis dengan nominal dan CRC benar', () => {
  const out = preview(buildStatic(), 50001, 'PAY-ABC123');
  assert.equal(out.dynamicInspect.crc_ok, true, 'CRC hasil harus sah');
  assert.equal(out.dynamicInspect.is_static, false, 'hasilnya harus dinamis');
  const nominal = out.dynamicInspect.tags.find((t) => t.tag === '54');
  assert.equal(nominal.value, '50001');
});

test('referensi tertanam di tag 62', () => {
  const out = preview(buildStatic(), 1000, 'PAY-XYZ');
  const t62 = out.dynamicInspect.tags.find((t) => t.tag === '62');
  assert.ok(t62 && t62.value.includes('PAY-XYZ'), 'tag 62 harus memuat referensi');
});

test('identitas merchant pada tag 51 dipotong agar tidak tampil utuh', () => {
  const long = '0'.repeat(40);
  const body = tlv('00', '01') + tlv('01', '11') + tlv('51', long) +
    tlv('53', '360') + tlv('58', 'ID') + tlv('59', 'TOKO') + tlv('60', 'JAKARTA');
  const q = body + '6304' + calculateCRC16(body + '6304');
  const t51 = inspect(q).tags.find((t) => t.tag === '51');
  assert.ok(t51.value.includes('…'), 'nilai panjang harus dipotong');
  assert.ok(!t51.value.includes(long), 'nilai utuh tidak boleh tampil');
});
