const test = require('node:test');
const assert = require('node:assert/strict');
const { rawProviderAmount, providerAmountCandidates } = require('../src/lib/providerAmount');

test('nominal provider IDR menyediakan raw dan fallback minor-unit', () => {
    const transaction = { gross_amount: 1100, currency: 'IDR' };
    assert.equal(rawProviderAmount(transaction), 1100);
    assert.deepEqual(providerAmountCandidates(transaction), [1100, 11]);
});

test('nominal tidak dibagi jika bukan IDR atau tidak habis dibagi 100', () => {
    assert.deepEqual(providerAmountCandidates({ gross_amount: 1101, currency: 'IDR' }), [1101]);
    assert.deepEqual(providerAmountCandidates({ gross_amount: 1100, currency: 'USD' }), [1100]);
});
