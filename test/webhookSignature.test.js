'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { signPayload, verifySignature, isAllowedUrl, backoffMs } = require('../src/webhooks/deliver');

const SECRET = 'a'.repeat(64);
const BODY = { event: 'invoice.paid', invoice: { id: 'inv_1', payable_amount: 10007 } };

test('tanda tangan yang dibuat gateway diterima penerima', () => {
  const { header } = signPayload(SECRET, BODY);
  assert.ok(verifySignature(SECRET, BODY, header));
});

test('secret berbeda ditolak', () => {
  const { header } = signPayload(SECRET, BODY);
  assert.equal(verifySignature('b'.repeat(64), BODY, header), false);
});

test('body yang diubah ditolak — inilah gunanya tanda tangan', () => {
  const { header } = signPayload(SECRET, BODY);
  const tampered = { ...BODY, invoice: { ...BODY.invoice, payable_amount: 1 } };
  assert.equal(verifySignature(SECRET, tampered, header), false);
});

test('kiriman lama ditolak sehingga serangan putar-ulang tidak berguna', () => {
  const oldTs = Math.floor(Date.now() / 1000) - 3600;
  const { header } = signPayload(SECRET, BODY, oldTs);
  assert.equal(verifySignature(SECRET, BODY, header), false);
  // Masih diterima bila toleransinya memang diperlebar.
  assert.ok(verifySignature(SECRET, BODY, header, { toleranceSeconds: 7200 }));
});

test('header rusak ditolak, tidak melempar', () => {
  for (const bad of [undefined, '', 'garbage', 't=abc,v1=zz', 't=1']) {
    assert.equal(verifySignature(SECRET, BODY, bad), false);
  }
});

test('URL callback ke jaringan internal selalu ditolak (proteksi SSRF)', () => {
  for (const url of [
    'http://localhost/hook', 'http://127.0.0.1:8080/x', 'http://10.0.0.5/x',
    'http://192.168.1.10/x', 'http://172.16.0.1/x', 'http://169.254.169.254/latest/meta-data',
  ]) {
    assert.equal(isAllowedUrl(url, []), false, `harus ditolak: ${url}`);
  }
});

test('allowlist membatasi host, subdomain tetap diizinkan', () => {
  assert.ok(isAllowedUrl('https://soal.nusawangsa.com/hook', ['nusawangsa.com']));
  assert.ok(isAllowedUrl('https://nusawangsa.com/hook', ['nusawangsa.com']));
  assert.equal(isAllowedUrl('https://jahat.com/hook', ['nusawangsa.com']), false);
  // Nama yang hanya menempel di akhir tanpa titik bukan subdomain.
  assert.equal(isAllowedUrl('https://evilnusawangsa.com/hook', ['nusawangsa.com']), false);
});

test('skema selain http/https ditolak', () => {
  assert.equal(isAllowedUrl('file:///etc/passwd', []), false);
  assert.equal(isAllowedUrl('gopher://x/', []), false);
  assert.equal(isAllowedUrl('bukan-url', []), false);
});

test('backoff naik eksponensial lalu dibatasi 1 jam', () => {
  assert.equal(backoffMs(1), 60_000);
  assert.equal(backoffMs(2), 120_000);
  assert.equal(backoffMs(3), 240_000);
  assert.equal(backoffMs(20), 3_600_000);
});
