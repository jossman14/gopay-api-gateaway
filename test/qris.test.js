const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateCRC16, parseTLV, generateDynamicQRIS } = require('../lib/qris');

function staticQris() {
    const body = '0002010102115802ID5904TOKO6007JAKARTA6304';
    return body + calculateCRC16(body);
}

test('membuat QRIS dinamis dengan amount, reference 62.05, dan CRC valid', () => {
    const generated = generateDynamicQRIS(staticQris(), 100037, 'PAY-ABC123');
    const tags = parseTLV(generated.slice(0, -8));
    const additional = parseTLV(tags.find(item => item.tag === '62').val);

    assert.equal(tags.find(item => item.tag === '01').val, '12');
    assert.equal(tags.find(item => item.tag === '54').val, '100037');
    assert.equal(additional.find(item => item.tag === '05').val, 'PAY-ABC123');
    assert.equal(generated.slice(-4), calculateCRC16(generated.slice(0, -4)));
});

test('mengganti amount dan reference yang sudah ada tanpa duplikasi', () => {
    const first = generateDynamicQRIS(staticQris(), 100001, 'PAY-FIRST');
    const second = generateDynamicQRIS(first, 200002, 'PAY-SECOND');
    const tags = parseTLV(second.slice(0, -8));
    const references = parseTLV(tags.find(item => item.tag === '62').val)
        .filter(item => item.tag === '05');

    assert.equal(tags.filter(item => item.tag === '54').length, 1);
    assert.equal(tags.find(item => item.tag === '54').val, '200002');
    assert.deepEqual(references, [{ tag: '05', val: 'PAY-SECOND' }]);
});

test('menolak reference di luar karakter EMV yang diizinkan gateway', () => {
    assert.throws(
        () => generateDynamicQRIS(staticQris(), 1000, 'ORDER DENGAN SPASI'),
        /Reference QRIS/
    );
});
