'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rawProviderAmount, providerAmount } = require('../src/lib/providerAmount');

test('membaca nominal dari beberapa nama field', () => {
  assert.equal(rawProviderAmount({ gross_amount: '1100' }), 1100);
  assert.equal(rawProviderAmount({ real_gross_amount: 1300 }), 1300);
  assert.equal(rawProviderAmount({ amount: { value: '500' } }), 500);
  assert.equal(rawProviderAmount({ amount: 700 }), 700);
});

test('satuan minor: 1100 dari GoPay berarti Rp11', () => {
  // Terverifikasi dari transaksi sungguhan: pembayaran Rp11 dilaporkan 1100.
  assert.equal(providerAmount({ gross_amount: 1100 }, 100), 11);
  assert.equal(providerAmount({ gross_amount: 1300 }, 100), 13);
  assert.equal(providerAmount({ gross_amount: 5000100 }, 100), 50001);
});

test('skala 1 memakai nominal apa adanya', () => {
  assert.equal(providerAmount({ gross_amount: 50001 }, 1), 50001);
});

test('nominal yang tidak habis dibagi skala DITOLAK, bukan dibulatkan', () => {
  // Membulatkan akan menghasilkan angka uang yang salah. Menolak membuat
  // pembayaran tidak cocok sampai skalanya dibetulkan — gagal terlihat.
  assert.equal(providerAmount({ gross_amount: 1105 }, 100), null);
  assert.equal(providerAmount({ gross_amount: 7 }, 100), null);
});

test('nominal nol atau negatif ditolak', () => {
  for (const v of [0, -100, 'abc', null, undefined]) {
    assert.equal(providerAmount({ gross_amount: v }, 100), null);
  }
});

test('KEAMANAN: bayar seperseratus tidak lagi bisa melunasi invoice penuh', () => {
  // Invoice Rp100.000. Pembeli membayar Rp1.000; GoPay melaporkan 100000.
  // Penafsiran tunggal menghasilkan Rp1.000 — TIDAK sama dengan 100000,
  // sehingga tidak cocok. Versi lama menawarkan [100000, 1000] dan menerima
  // 100000, sehingga pembayaran seperseratus dianggap lunas.
  const dilaporkan = 1000 * 100;
  assert.equal(providerAmount({ gross_amount: dilaporkan }, 100), 1000);
  assert.notEqual(providerAmount({ gross_amount: dilaporkan }, 100), 100000);
});
