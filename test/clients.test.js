'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateApiKey, hashKey } = require('../src/domain/clients');

test('kunci API punya prefix yang bisa diindeks dan rahasia yang panjang', () => {
  const { key, prefix, hash } = generateApiKey('soal');
  assert.ok(key.startsWith(prefix), 'prefix harus menjadi awalan kunci');
  assert.ok(key.split('.')[1].length >= 30, 'bagian rahasia harus panjang');
  assert.equal(hash, hashKey(key));
  assert.equal(hash.length, 64);
});

test('setiap kunci berbeda', () => {
  const keys = new Set(Array.from({ length: 50 }, () => generateApiKey('x').key));
  assert.equal(keys.size, 50);
});

test('hash tidak memuat kunci aslinya', () => {
  const { key, hash } = generateApiKey('soal');
  assert.ok(!hash.includes(key.split('.')[1]));
});
