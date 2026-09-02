const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { deliverWebhook } = require('../lib/webhook');

test('webhook ditandatangani dari timestamp dan raw body', async () => {
    let received;
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            received = { headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
            res.writeHead(204).end();
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
        const address = server.address();
        const secret = 'test-webhook-secret';
        const result = await deliverWebhook({
            id: 'pay_test',
            order_id: 'ORDER-TEST',
            base_amount: 100000,
            payable_amount: 100001,
            callback_url: `http://127.0.0.1:${address.port}/webhook`,
            paid_at: '2026-09-02T00:00:00.000Z',
            provider_transaction_id: 'GP-TEST'
        }, secret);

        const expected = crypto.createHmac('sha256', secret)
            .update(`${received.headers['x-payment-timestamp']}.${received.body}`)
            .digest('hex');
        assert.equal(result.status, 'DELIVERED');
        assert.equal(received.headers['x-payment-signature'], `sha256=${expected}`);
        assert.equal(JSON.parse(received.body).event, 'payment.paid');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
