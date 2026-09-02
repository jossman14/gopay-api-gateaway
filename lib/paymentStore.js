const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class PaymentStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.state = { payments: {}, claimedTransactions: {} };
        this.load();
    }

    load() {
        if (!fs.existsSync(this.filePath)) return;
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.state.payments = parsed.payments || {};
        this.state.claimedTransactions = parsed.claimedTransactions || {};
    }

    persist() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
        fs.renameSync(temporary, this.filePath);
    }

    list() {
        return Object.values(this.state.payments);
    }

    get(id) {
        return this.state.payments[id] || null;
    }

    findByOrderId(orderId) {
        return this.list().find(payment => payment.order_id === orderId) || null;
    }

    create(input) {
        const existing = this.findByOrderId(input.order_id);
        if (existing) return { payment: existing, created: false };

        const now = Date.now();
        const activeAmounts = new Set(this.list()
            .filter(payment => payment.status === 'PENDING' && Date.parse(payment.expires_at) > now)
            .map(payment => payment.payable_amount));

        let uniqueCode = 0;
        if (input.use_unique_amount) {
            for (let candidate = input.unique_min; candidate <= input.unique_max; candidate++) {
                if (!activeAmounts.has(input.base_amount + candidate)) {
                    uniqueCode = candidate;
                    break;
                }
            }
            if (!uniqueCode) throw new Error('Semua kode nominal unik sedang digunakan; coba lagi setelah invoice kedaluwarsa');
        } else if (activeAmounts.has(input.base_amount)) {
            throw new Error('Ada invoice PENDING dengan nominal sama. Aktifkan USE_UNIQUE_AMOUNT atau tunggu invoice tersebut selesai');
        }

        const id = `pay_${crypto.randomBytes(10).toString('hex')}`;
        const reference = `PAY-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
        const payment = {
            id,
            order_id: input.order_id,
            merchant_reference: reference,
            base_amount: input.base_amount,
            unique_code: uniqueCode,
            payable_amount: input.base_amount + uniqueCode,
            qris_payload: null,
            status: 'PENDING',
            callback_url: input.callback_url || null,
            created_at: new Date(now).toISOString(),
            expires_at: new Date(now + input.expiry_ms).toISOString(),
            paid_at: null,
            provider_transaction_id: null,
            provider_transaction_time: null,
            provider_transaction: null,
            webhook: { status: 'NOT_SENT', attempts: 0, last_error: null }
        };
        this.state.payments[id] = payment;
        this.persist();
        return { payment, created: true };
    }

    update(id, changes) {
        const current = this.get(id);
        if (!current) return null;
        this.state.payments[id] = { ...current, ...changes };
        this.persist();
        return this.state.payments[id];
    }

    remove(id) {
        if (!this.get(id)) return false;
        delete this.state.payments[id];
        this.persist();
        return true;
    }

    pending(now = Date.now()) {
        let dirty = false;
        for (const payment of this.list()) {
            if (payment.status === 'PENDING' && Date.parse(payment.expires_at) <= now) {
                payment.status = 'EXPIRED';
                dirty = true;
            }
        }
        if (dirty) this.persist();
        return this.list().filter(payment => payment.status === 'PENDING');
    }

    markPaid(id, transaction) {
        const payment = this.get(id);
        if (!payment || payment.status !== 'PENDING') return null;
        const transactionId = transaction.transaction_id;
        if (!transactionId || this.state.claimedTransactions[transactionId]) return null;

        this.state.claimedTransactions[transactionId] = id;
        Object.assign(payment, {
            status: 'PAID',
            paid_at: new Date().toISOString(),
            provider_transaction_id: transactionId,
            provider_transaction_time: transaction.transaction_time || null,
            provider_transaction: transaction
        });
        this.persist();
        return payment;
    }
}

module.exports = PaymentStore;
