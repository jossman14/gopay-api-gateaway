'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GoIdClient, buildHeaders, normalizePhone, toTokens } = require('../src/providers/gopay/goid');

const DEVICE = 'c0c70d6d-82f9-46cd-84cb-d03322a2a409';

/** http palsu yang merekam permintaan dan mengembalikan respons terprogram. */
function stubHttp(responses) {
  const calls = [];
  const queue = [...responses];
  const http = async (url, opts) => {
    calls.push({ url, ...opts });
    return queue.shift() ?? { status: 200, data: {} };
  };
  return { http, calls };
}

test('normalizePhone menerima berbagai bentuk dan membuang nol di depan', () => {
  for (const input of ['081234567890', '81234567890', '+6281234567890', '6281234567890', '0812-3456-7890']) {
    assert.deepEqual(normalizePhone(input), {
      countryCode: '62', phoneNumber: '81234567890', e164: '+6281234567890',
    });
  }
});

test('normalizePhone menolak yang bukan nomor seluler Indonesia', () => {
  for (const bad of ['', '0000', '621234567890', '021234567', 'abc']) {
    assert.throws(() => normalizePhone(bad), /tidak valid|kosong/);
  }
});

test('buildHeaders memakai identitas GoBiz web dan menolak deviceId kosong', () => {
  const h = buildHeaders(DEVICE);
  assert.equal(h['x-appid'], 'go-biz-web-dashboard');
  assert.equal(h['authentication-type'], 'go-id');
  assert.equal(h['x-uniqueid'], DEVICE);
  assert.throws(() => buildHeaders(''), /deviceId wajib/);
});

test('requestOtp memanggil endpoint yang benar dengan nomor ternormalisasi', async () => {
  const { http, calls } = stubHttp([{ status: 200, data: { data: { otp_token: 'OT1', otp_length: 4 } } }]);
  const client = new GoIdClient({ http, deviceId: DEVICE });
  const out = await client.requestOtp('081234567890');

  assert.equal(calls[0].url, 'https://api.gobiz.co.id/goid/login/request');
  assert.deepEqual(calls[0].body, {
    client_id: 'go-biz-web-new', phone_number: '81234567890', country_code: '62',
  });
  assert.equal(out.otpToken, 'OT1');
});

test('verifyOtp menukar OTP dengan sepasang token', async () => {
  const { http, calls } = stubHttp([
    { status: 200, data: { data: { access_token: 'AT', refresh_token: 'RT', expires_in: 60 } } },
  ]);
  const client = new GoIdClient({ http, deviceId: DEVICE });
  const t = await client.verifyOtp('OT1', 1234);

  assert.equal(calls[0].url, 'https://api.gobiz.co.id/goid/token');
  assert.equal(calls[0].body.grant_type, 'otp');
  // OTP dikirim sebagai string; angka 1234 akan ditolak GoID.
  assert.equal(calls[0].body.data.otp, '1234');
  assert.equal(t.accessToken, 'AT');
  assert.ok(Date.parse(t.expiresAt) > Date.now());
});

test('refresh menyertakan nomor HP — refresh token saja ditolak GoID', async () => {
  const { http, calls } = stubHttp([
    { status: 200, data: { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 } },
  ]);
  const client = new GoIdClient({ http, deviceId: DEVICE });
  await client.refresh('RT1', '+6281234567890');

  assert.equal(calls[0].body.grant_type, 'refresh_token');
  assert.deepEqual(calls[0].body.data, {
    refresh_token: 'RT1', phone_number: '81234567890', country_code: '62',
  });
});

test('galat HTTP dimunculkan dengan pesan dari GoID, bukan ditelan', async () => {
  const { http } = stubHttp([{ status: 401, data: { message: 'invalid otp' } }]);
  const client = new GoIdClient({ http, deviceId: DEVICE });
  await assert.rejects(() => client.verifyOtp('OT1', '9999'), /HTTP 401.*invalid otp/);
});

test('respons tanpa access_token ditolak, tidak menghasilkan sesi setengah jadi', async () => {
  assert.throws(() => toTokens({ data: { refresh_token: 'RT' } }), /access_token/);
});

test('expires_in yang hilang tidak membuat sesi langsung dianggap kedaluwarsa', () => {
  const t = toTokens({ access_token: 'AT' });
  assert.ok(Date.parse(t.expiresAt) > Date.now() + 20 * 3600 * 1000);
});
