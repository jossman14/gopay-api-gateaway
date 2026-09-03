'use strict';
/**
 * Konsol adalah satu berkas HTML tanpa build step, jadi tidak ada yang
 * menangkap galat sintaks sebelum ia sampai ke browser — halaman akan mati
 * diam-diam. Pemeriksaan ini menggantikan peran itu.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function scriptBody() {
  const m = HTML.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(m, 'blok <script> harus ada');
  return m[1];
}

test('JavaScript konsol bebas galat sintaks', () => {
  assert.doesNotThrow(() => new vm.Script(scriptBody()), 'sintaks JS konsol harus valid');
});

test('tidak ada JSON.stringify di dalam atribut onclick', () => {
  // Nama yang mengandung tanda kutip akan menutup atribut lebih awal sehingga
  // tombol tampak normal tapi tidak melakukan apa pun — kegagalan senyap yang
  // pernah membuat tombol Panduan dan Ubah mati.
  const bad = [...HTML.matchAll(/onclick="[^"]*JSON\.stringify/g)];
  assert.equal(bad.length, 0, 'pakai data-attribute + delegasi, bukan menyisipkan JSON ke onclick');
});

test('nilai dinamis pada atribut value di-escape', () => {
  const raw = [...HTML.matchAll(/value="\$\{(?!esc\()[^}]*\}"/g)].map((m) => m[0]);
  assert.equal(raw.length, 0, `value="\${...}" harus lewat esc(): ${raw.join(', ')}`);
});

test('setiap tombol beraksi punya penanganan', () => {
  const ids = [...HTML.matchAll(/<button[^>]*\sid="([a-zA-Z0-9_]+)"/g)].map((m) => m[1]);
  const js = scriptBody();
  // Tombol type="submit" ditangani lewat onsubmit form-nya, bukan onclick
  // sendiri, jadi bukan berarti tanpa penanganan.
  const submit = new Set(
    [...HTML.matchAll(/<button[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => tag.includes('type="submit"'))
      .map((tag) => (tag.match(/\sid="([a-zA-Z0-9_]+)"/) || [])[1])
      .filter(Boolean)
  );
  const tanpaHandler = ids.filter((id) =>
    !submit.has(id) && !js.includes(`$('${id}').onclick`) && !js.includes(`getElementById('${id}')`));
  assert.equal(tanpaHandler.length, 0, `tombol tanpa handler: ${tanpaHandler.join(', ')}`);
});

test('setiap menu sidebar punya section-nya', () => {
  const views = [...HTML.matchAll(/data-v="([a-z]+)"/g)].map((m) => m[1]);
  const sections = [...HTML.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
  for (const v of views) {
    assert.ok(sections.includes(v), `menu "${v}" tidak punya section data-view`);
  }
});

test('modal dapat digulir dan tidak memotong isi panjang', () => {
  // Tanpa max-height + overflow, panduan panjang terpotong di luar layar tanpa
  // jalan keluar — persis keluhan yang memicu perbaikan ini.
  const css = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
  assert.match(css, /\.modal \.box\{[^}]*max-height/, 'kotak modal harus punya max-height');
  for (const bagian of ['.mbody', '.pad']) {
    const re = new RegExp('\\.modal \\.box>\\' + bagian + '\\{[^}]*overflow-y:\\s*auto');
    assert.match(css, re, `${bagian} harus bisa digulir`);
  }
  assert.match(css, /@media\(max-width:560px\)/, 'harus ada penyesuaian layar kecil');
});

test('blok kode digulir mendatar, tidak memaksa halaman melebar', () => {
  const css = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
  assert.match(css, /\.code pre\{[^}]*overflow-x:\s*auto/);
});

test('tombol ber-data-act punya delegasi kliknya', () => {
  // Baris tabel klien dirender dengan data-act="guide|edit|del". Tanpa
  // delegasi klik yang membaca atribut itu, ketiga tombolnya mati —
  // persis bug yang pernah membuat Panduan/Ubah/Hapus tidak bisa diklik.
  const acts = [...HTML.matchAll(/data-act="([a-z]+)"/g)].map((m) => m[1]);
  const unik = [...new Set(acts)];
  if (!unik.length) return;
  const js = scriptBody();
  assert.match(js, /document\.addEventListener\('click'[^)]*\[data-act\]/,
    'harus ada delegasi klik yang membaca [data-act]');
  for (const a of unik) {
    assert.ok(js.includes(`'${a}'`), `aksi "${a}" harus ditangani delegasi`);
  }
  // Delegasi menangkap tombol lewat closest(), jadi klik ikon di dalam
  // tombol pun sampai.
});
