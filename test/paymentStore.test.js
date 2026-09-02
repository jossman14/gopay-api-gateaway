const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PaymentStore = require('../lib/paymentStore');

function input(orderId) {
    return {
        order_id: orderId,
        base_amount: 100000,
        callback_url: null,
        expiry_ms: 15 * 60 * 1000,
        use_unique_amount: true,
        unique_min: 1,
        unique_max: 999
    };
}

test('invoice persisten, idempotent, dan nominal pending tidak bertabrakan', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gopay-store-'));
    const file = path.join(directory, 'payments.json');
    const store = new PaymentStore(file);

    const first = store.create(input('ORDER-1'));
    const replay = store.create(input('ORDER-1'));
    const second = store.create(input('ORDER-2'));

    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.payment.id, first.payment.id);
    assert.notEqual(second.payment.payable_amount, first.payment.payable_amount);

    const reloaded = new PaymentStore(file);
    assert.equal(reloaded.get(first.payment.id).order_id, 'ORDER-1');
});

test('satu transaksi provider hanya dapat mengonfirmasi satu invoice', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gopay-store-'));
    const store = new PaymentStore(path.join(directory, 'payments.json'));
    const first = store.create(input('ORDER-A')).payment;
    const second = store.create(input('ORDER-B')).payment;
    const transaction = { transaction_id: 'GP-123', amount: first.payable_amount };

    assert.equal(store.markPaid(first.id, transaction).status, 'PAID');
    assert.equal(store.markPaid(second.id, transaction), null);
    assert.equal(store.get(second.id).status, 'PENDING');
});
