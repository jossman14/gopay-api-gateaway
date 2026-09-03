'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { errorHandler } = require('../src/http/middleware/errors');

function run(err) {
  let out = null, code = null;
  const res = { status(c) { code = c; return this; }, json(b) { out = b; } };
  errorHandler(() => {})(err, { method: 'GET', path: '/x' }, res, () => {});
  return { code, message: out.errors[0].message };
}

test('galat dengan statusCode sengaja menampilkan pesannya', () => {
  const r = run(Object.assign(new Error('Belum ada provider'), { statusCode: 503 }));
  assert.equal(r.code, 503);
  assert.equal(r.message, 'Belum ada provider');
});

test('galat 4xx sengaja juga tampil apa adanya', () => {
  const r = run(Object.assign(new Error('order_id wajib'), { statusCode: 400 }));
  assert.equal(r.code, 400);
  assert.equal(r.message, 'order_id wajib');
});

test('galat tak terduga disamarkan agar detail internal tidak bocor', () => {
  const r = run(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
  assert.equal(r.code, 500);
  assert.equal(r.message, 'Terjadi kesalahan internal');
  assert.ok(!r.message.includes('10.0.0.5'));
});
