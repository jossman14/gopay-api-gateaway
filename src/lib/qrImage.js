'use strict';

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

/**
 * Perenderan QR sebagai SVG dengan logo di tengah.
 *
 * Dirender sendiri, bukan memakai keluaran bawaan qrcode, karena dua alasan:
 * modul membulat dan mata pencari bergaya membuat hasilnya layak dipakai di
 * halaman pembayaran, dan menempatkan logo menuntut kontrol atas geometri.
 *
 * Koreksi galat dipatok level H. Menutup bagian tengah QR berarti membuang
 * sebagian data; level H mentoleransi kerusakan sampai ~30%, dan plat logo di
 * sini menutup jauh di bawah itu. Menurunkan level akan membuat QR gagal
 * dipindai — kegagalan yang baru ketahuan dari pembeli.
 */

const LOGO_PATH = path.join(__dirname, '..', '..', 'public', 'brand', 'nusawangsa.png');
let logoDataUri = null;

function loadLogo() {
  if (logoDataUri !== null) return logoDataUri;
  try {
    logoDataUri = `data:image/png;base64,${fs.readFileSync(LOGO_PATH).toString('base64')}`;
  } catch {
    logoDataUri = ''; // tanpa logo tetap menghasilkan QR yang sah
  }
  return logoDataUri;
}

function esc(s) {
  return String(s).replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * @param {string} payload teks yang dikodekan
 * @param {object} opts  { size, logo, caption, subcaption, dark, light }
 */
function renderSvg(payload, opts = {}) {
  const {
    size = 420,
    logo = true,
    caption = null,      // mis. "Rp50.001"
    subcaption = null,   // mis. nama merchant
    dark = '#1e1b33',
    light = '#ffffff',
    // 'square' memberi margin pindai terbesar karena modul bersentuhan penuh;
    // 'dot' lebih enak dilihat tapi memangkas area gelap ~21%. Default square
    // untuk QR pembayaran: yang dipindai orang di lapangan, bukan dipajang.
    shape = 'square',
  } = opts;

  const qr = QRCode.create(payload, { errorCorrectionLevel: 'H' });
  const count = qr.modules.size;
  const data = qr.modules.data;

  const quiet = 4;                    // zona tenang wajib EMVCo/ISO: 4 modul
  const total = count + quiet * 2;
  const cell = size / total;

  // Mata pencari digambar terpisah agar bisa membulat; modulnya dilewati.
  const finders = [[0, 0], [count - 7, 0], [0, count - 7]];
  const inFinder = (r, c) =>
    finders.some(([fr, fc]) => r >= fr && r < fr + 7 && c >= fc && c < fc + 7);

  let dots = '';
  const rad = cell * 0.5;
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (!data[r * count + c] || inFinder(r, c)) continue;
      const x = (c + quiet) * cell;
      const y = (r + quiet) * cell;
      dots += shape === 'dot'
        ? `<circle cx="${(x + cell / 2).toFixed(2)}" cy="${(y + cell / 2).toFixed(2)}" r="${rad.toFixed(2)}"/>`
        : `<rect x="${x.toFixed(3)}" y="${y.toFixed(3)}" width="${(cell + 0.02).toFixed(3)}" height="${(cell + 0.02).toFixed(3)}"/>`;
    }
  }

  // Mata pencari HARUS mempertahankan rasio 1:1:3:1:1 — 7 modul gelap, cincin
  // terang 5x5, inti gelap 3x3. Versi pertama menggambarnya sebagai rounded-rect
  // ber-stroke; rasionya melenceng dan seluruh QR gagal dipindai meski tampak
  // benar. Di sini digambar sebagai tiga kotak sepusat, dengan pembulatan kecil
  // saja agar tetap rapi tanpa mengubah geometri.
  let eyes = '';
  for (const [fr, fc] of finders) {
    const x = (fc + quiet) * cell;
    const y = (fr + quiet) * cell;
    const r = cell * 0.55;
    eyes +=
      `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(7 * cell).toFixed(2)}" height="${(7 * cell).toFixed(2)}" rx="${r.toFixed(2)}" fill="${dark}"/>` +
      `<rect x="${(x + cell).toFixed(2)}" y="${(y + cell).toFixed(2)}" width="${(5 * cell).toFixed(2)}" height="${(5 * cell).toFixed(2)}" rx="${(r * 0.7).toFixed(2)}" fill="${light}"/>` +
      `<rect x="${(x + 2 * cell).toFixed(2)}" y="${(y + 2 * cell).toFixed(2)}" width="${(3 * cell).toFixed(2)}" height="${(3 * cell).toFixed(2)}" rx="${(r * 0.45).toFixed(2)}" fill="${dark}"/>`;
  }

  // Plat logo ~19% lebar QR — nyaman di bawah batas toleransi level H.
  let center = '';
  const uri = logo ? loadLogo() : '';
  if (uri) {
    const plate = size * 0.19;
    const pos = (size - plate) / 2;
    const inner = plate * 0.7;
    center =
      `<rect x="${pos.toFixed(2)}" y="${pos.toFixed(2)}" width="${plate.toFixed(2)}" height="${plate.toFixed(2)}" rx="${(plate * 0.24).toFixed(2)}" fill="${light}"/>` +
      `<image href="${uri}" x="${(pos + (plate - inner) / 2).toFixed(2)}" y="${(pos + (plate - inner) / 2).toFixed(2)}" width="${inner.toFixed(2)}" height="${inner.toFixed(2)}"/>`;
  }

  const capH = caption ? 58 : 0;
  const h = size + capH;
  const capBlock = caption
    ? `<text x="${size / 2}" y="${size + 26}" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="21" font-weight="700" fill="${dark}">${esc(caption)}</text>` +
      (subcaption
        ? `<text x="${size / 2}" y="${size + 46}" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12" fill="#8b88a3">${esc(subcaption)}</text>`
        : '')
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${h}" viewBox="0 0 ${size} ${h}">` +
    `<rect width="${size}" height="${h}" fill="${light}"/>` +
    `<g fill="${dark}">${dots}</g>${eyes}${center}${capBlock}</svg>`;
}

module.exports = { renderSvg, LOGO_PATH };
