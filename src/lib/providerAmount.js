'use strict';

/**
 * Penafsiran nominal dari provider.
 *
 * GoPay Merchant Analytics melaporkan IDR dalam SATUAN MINOR: pembayaran Rp11
 * terbaca 1100. Terbukti dari transaksi sungguhan — gross_amount dan
 * real_gross_amount sama-sama 1100 untuk pembayaran Rp11.
 *
 * Versi sebelumnya menyiasatinya dengan mencoba dua tafsir sekaligus, mentah
 * lebih dulu lalu dibagi 100, dan menerima mana pun yang cocok. Itu lubang
 * keamanan, bukan mitigasi:
 *
 *   Invoice Rp100.000 -> payable_amount 100000
 *   Pembeli membayar Rp1.000 -> provider melaporkan 100000
 *   kandidat [100000, 1000] -> cocok pada 100000
 *   Hasilnya pembeli membayar seperseratus dan tetap dianggap lunas.
 *
 * Karena itu penafsirannya kini tunggal dan eksplisit. Skala salah akan membuat
 * pembayaran tidak pernah cocok — gagal terlihat, bukan gagal diam-diam
 * memberikan barang gratis.
 */

function rawProviderAmount(transaction) {
  return Number.parseInt(
    transaction?.gross_amount
    ?? transaction?.real_gross_amount
    ?? transaction?.amount?.value
    ?? transaction?.amount
    ?? 0,
    10
  );
}

/**
 * Nominal sebenarnya dalam rupiah penuh.
 *
 * @param {object} transaction
 * @param {number} scale 100 bila provider memakai satuan minor, 1 bila tidak
 */
function providerAmount(transaction, scale = 100) {
  const raw = rawProviderAmount(transaction);
  if (!Number.isSafeInteger(raw) || raw <= 0) return null;
  if (scale === 1) return raw;

  // Nominal yang tidak habis dibagi skala berarti asumsinya keliru. Membulatkan
  // akan menghasilkan angka uang yang salah, jadi lebih baik menolak dan
  // membiarkannya tidak cocok sampai skalanya dibetulkan.
  if (raw % scale !== 0) return null;
  return raw / scale;
}

module.exports = { rawProviderAmount, providerAmount };
