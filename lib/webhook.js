const crypto = require('crypto');

async function deliverWebhook(payment, secret) {
    if (!payment.callback_url) return { status: 'SKIPPED' };
    if (!secret) throw new Error('WEBHOOK_SECRET belum dikonfigurasi');

    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
        event: 'payment.paid',
        payment_id: payment.id,
        order_id: payment.order_id,
        base_amount: payment.base_amount,
        amount: payment.payable_amount,
        paid_at: payment.paid_at,
        transaction_id: payment.provider_transaction_id
    });
    const signature = crypto.createHmac('sha256', secret)
        .update(`${timestamp}.${body}`)
        .digest('hex');

    const response = await fetch(payment.callback_url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-payment-timestamp': timestamp,
            'x-payment-signature': `sha256=${signature}`,
            'user-agent': 'gopay-merchant-gateway/2.0'
        },
        body,
        signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);
    return { status: 'DELIVERED' };
}

module.exports = { deliverWebhook };
