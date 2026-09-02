const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const sessionManager = require('./sessionManager');
const PaymentStore = require('./lib/paymentStore');
const { generateDynamicQRIS } = require('./lib/qris');
const { deliverWebhook } = require('./lib/webhook');
const { listenWithFallback } = require('./lib/serverListener');
const { AdminAuth } = require('./lib/adminAuth');
const { rawProviderAmount, providerAmountCandidates } = require('./lib/providerAmount');
const QRCode = require('qrcode');

const PORT = parseInt(process.env.PORT || '3000', 10);
const AUTO_PORT = String(process.env.AUTO_PORT || 'true').toLowerCase() !== 'false';
const MAX_PORT_ATTEMPTS = Math.max(1, parseInt(process.env.MAX_PORT_ATTEMPTS || '20', 10));
const MAX_LOGS = 100;
const CLAIMED_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 jam
const QRIS_EXPIRY_MS = 5 * 60 * 1000; // 5 menit
const GOJEK_TRANSACTIONS_URL = 'https://api.gojekapi.com/merchant-analytics/v2/merchants/transactions';
const PAYMENT_EXPIRY_MS = Math.max(60, parseInt(process.env.PAYMENT_EXPIRY_MINUTES || '15', 10)) * 60 * 1000;
const RECONCILE_INTERVAL_MS = Math.max(10, parseInt(process.env.RECONCILE_INTERVAL_SECONDS || '20', 10)) * 1000;
const PAYMENT_STORE_FILE = path.resolve(__dirname, process.env.PAYMENT_STORE_FILE || 'data/payments.json');
const PUBLIC_DIR = path.join(__dirname, 'public');


// claimedTransactions: Map<txId, { qrisId: string|null, claimedAt: number }>
// Menyimpan mapping txId -> qrisId agar satu transaksi tidak bisa diklaim oleh dua QRIS berbeda
const claimedTransactions = new Map();
const activityLogs = [];
const qrisStore = new Map();
const paymentStore = new PaymentStore(PAYMENT_STORE_FILE);
const adminAuth = new AdminAuth({
    email: process.env.ADMIN_EMAIL || 'admin@hehe.com',
    password: process.env.ADMIN_PASSWORD || 'admin@hehe.com',
    secureCookie: String(process.env.ADMIN_SECURE_COOKIE || 'false').toLowerCase() === 'true'
});
let activePort = null;
const reconciliationStatus = {
    running: false,
    last_started_at: null,
    last_success_at: null,
    last_error: null,
    transactions_seen: 0
};
let providerTransactionCache = [];

const CACHE_FILE = path.join(__dirname, '.gopay_cache.json');

function saveCookieToFile(cookie) {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ gopay_cookie: cookie }), 'utf-8');
        logActivity('INFO', 'Cookie berhasil disimpan ke ' + CACHE_FILE);
    } catch (err) {
        logActivity('ERROR', 'Gagal simpan cookie ke file: ' + err.message);
    }
}

function logActivity(type, message, details = null) {
    const timestamp = new Date().toISOString();
    const logObj = { id: Date.now(), timestamp, type, message, details };
    activityLogs.unshift(logObj);
    if (activityLogs.length > MAX_LOGS) {
        activityLogs.pop();
    }
    console.log(`[${timestamp}] [${type}] ${message}`);
}

// Clean up expired claimed transactions
function cleanExpiredTransactions() {
    const now = Date.now();
    for (const [txId, claim] of claimedTransactions.entries()) {
        const claimedAt = typeof claim === 'object' ? claim.claimedAt : claim;
        if (now - claimedAt > CLAIMED_CLEANUP_INTERVAL_MS) {
            claimedTransactions.delete(txId);
        }
    }
}
setInterval(cleanExpiredTransactions, 60 * 60 * 1000);

// Periodik auto-refresh session (tiap 6 jam)
async function autoRefreshSessionPeriodically() {
    try {
        const session = sessionManager.loadSession();
        if (session && session.refresh_token) {
            if (sessionManager.isExpired(session)) {
                logActivity('INFO', 'Auto Refresh: Token mendekati kedaluwarsa, memperbarui sesi...');
                await sessionManager.refreshSession();
            }
        }
    } catch (err) {
        logActivity('ERROR', `Gagal auto refresh session: ${err.message}`);
    }
}
setInterval(autoRefreshSessionPeriodically, 6 * 60 * 60 * 1000);

// Middleware Proteksi API Key
const apiKeyAuth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.api_key || req.query.apikey;
    if (!apiKey || apiKey !== process.env.API_KEY) {
        return res.status(401).json({ success: false, message: 'Autentikasi Gagal: API Key tidak valid' });
    }
    next();
};

const app = express();
app.use(cors());
app.use(express.json());

app.use('/admin', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    next();
});
app.use('/admin/assets', (req, res, next) => {
    if (req.path.toLowerCase().endsWith('.html')) return res.status(404).end();
    next();
}, express.static(PUBLIC_DIR, { fallthrough: false, maxAge: 0 }));

app.get('/admin/login', (req, res) => {
    if (adminAuth.sessionFromRequest(req)) return res.redirect('/admin');
    return res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.post('/admin/api/login', (req, res) => {
    const result = adminAuth.login(req.body?.email, req.body?.password, req.ip || req.socket.remoteAddress);
    if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });
    res.setHeader('Set-Cookie', adminAuth.cookie(result.token));
    return res.json({ success: true, data: { email: result.session.email, csrf_token: result.session.csrfToken } });
});

app.get('/admin', (req, res) => {
    if (!adminAuth.sessionFromRequest(req)) return res.redirect('/admin/login');
    return res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
});

app.get('/admin/api/session', adminAuth.requireSession.bind(adminAuth), (req, res) => {
    return res.json({
        success: true,
        data: {
            email: req.adminSession.email,
            csrf_token: req.adminSession.csrfToken,
            expires_at: new Date(req.adminSession.expiresAt).toISOString()
        }
    });
});

app.post(
    '/admin/api/logout',
    adminAuth.requireSession.bind(adminAuth),
    adminAuth.requireCsrf.bind(adminAuth),
    (req, res) => {
        adminAuth.logout(req);
        res.setHeader('Set-Cookie', adminAuth.clearCookie());
        return res.json({ success: true });
    }
);

app.get('/', (req, res) => {
    res.send('GoPay Partner API Gateway Berjalan');
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK', service: 'GoPay Partner API Gateway', timestamp: new Date() });
});

app.get('/api/health', (req, res) => {
    res.json({ success: true, message: 'Layanan API GoPay Berfungsi Normal', timestamp: new Date() });
});


// Cek Status Sesi Token
app.get('/token-status', apiKeyAuth, async (req, res) => {
    const activeHeaders = await sessionManager.getValidHeaders(req.headers['user-agent']);
    if (!activeHeaders) {
        return res.json({ success: false, data: { token_status: 'invalid', message: 'Sesi belum dikonfigurasi. Jalankan `node login.js` di terminal.' } });
    }
    try {
        const merchantId = process.env.GOPAY_MERCHANT_ID || '';
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 3600 * 1000).toISOString();

        await axios.get(GOJEK_TRANSACTIONS_URL, {
            headers: activeHeaders,
            params: {
                from: 0,
                size: 1,
                statuses: 'SETTLEMENT,CAPTURE',
                payment_types: 'QRIS,GOPAY',
                start_time: oneHourAgo,
                end_time: now.toISOString(),
                merchant_ids: merchantId
            },
            timeout: 5000
        });

        res.json({ success: true, data: { token_status: 'valid', message: 'Token dan Sesi GoPay Merchant Aktif' } });
    } catch (err) {
        res.json({ success: false, data: { token_status: 'invalid', message: err.message } });
    }
});

// Buat QRIS Dinamis (Support GET query & POST body)
app.all('/create-qris', apiKeyAuth, (req, res) => {
    const amount = req.body?.amount || req.query?.amount;
    if (!amount || isNaN(amount) || amount <= 0) {
        return res.status(400).json({ success: false, message: 'Nominal pembayaran tidak valid (gunakan ?amount=...)' });
    }

    const staticTemplate = process.env.QRIS_STATIC;
    if (!staticTemplate) {
        return res.status(500).json({ success: false, message: 'QRIS_STATIC belum dikonfigurasi di .env' });
    }

    const dynamicCode = generateDynamicQRIS(staticTemplate, amount);
    const qrisId = Math.random().toString(36).substring(2, 10);
    // TRX-ID unik per payment — dipakai sebagai scope klaim agar tidak tabrakan dengan payment lain
    const trxId = 'TRX-' + Math.random().toString(36).substring(2, 10).toUpperCase();
    const expiresAt = new Date(Date.now() + QRIS_EXPIRY_MS);
    const createdAt = new Date();

    qrisStore.set(qrisId, {
        data: dynamicCode,
        amount: parseInt(amount, 10),
        trxId,
        expiresAt,
        createdAt,
        status: 'PENDING'
    });

    const host = req.get('host');
    const protocol = req.protocol;
    const publicUrl = `${protocol}://${host}/qr/${qrisId}`;

    logActivity('INFO', `QRIS Dinamis dibuat | TRX-ID: ${trxId} | Nominal: Rp ${amount}`);

    res.json({
        success: true,
        data: {
            qris_id: qrisId,
            trx_id: trxId,
            qris_url: publicUrl,
            qris_code: dynamicCode,
            amount: parseInt(amount, 10),
            expires_at: expiresAt.toISOString(),
            expires_in: '5 menit'
        }
    });
});

function paymentResponse(payment) {
    return {
        id: payment.id,
        order_id: payment.order_id,
        merchant_reference: payment.merchant_reference,
        base_amount: payment.base_amount,
        unique_code: payment.unique_code,
        amount: payment.payable_amount,
        status: payment.status,
        qris_code: payment.qris_payload,
        created_at: payment.created_at,
        expires_at: payment.expires_at,
        paid_at: payment.paid_at,
        transaction_id: payment.provider_transaction_id,
        webhook_status: payment.webhook?.status || 'NOT_SENT'
    };
}

function paymentError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function createPayment(input) {
    const orderId = String(input?.order_id || '').trim();
    const amount = Number(input?.amount);
    const callbackUrl = input?.callback_url ? String(input.callback_url) : null;

    if (!/^[A-Za-z0-9._-]{1,100}$/.test(orderId)) {
        throw paymentError(400, 'order_id harus 1-100 karakter ASCII yang aman');
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw paymentError(400, 'amount harus berupa bilangan bulat positif');
    }
    if (callbackUrl) {
        let parsed;
        try {
            parsed = new URL(callbackUrl);
        } catch (_) {
            throw paymentError(400, 'callback_url harus berupa URL HTTP/HTTPS yang valid');
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw paymentError(400, 'callback_url harus berupa URL HTTP/HTTPS yang valid');
        }
        const allowedHosts = String(process.env.WEBHOOK_ALLOWED_HOSTS || '')
            .split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
        if (allowedHosts.length && !allowedHosts.includes(parsed.hostname.toLowerCase())) {
            throw paymentError(400, 'Host callback_url tidak ada di WEBHOOK_ALLOWED_HOSTS');
        }
    }
    if (!process.env.QRIS_STATIC) throw paymentError(500, 'QRIS_STATIC belum dikonfigurasi di .env');

    let result = null;
    try {
        result = paymentStore.create({
            order_id: orderId,
            base_amount: amount,
            callback_url: callbackUrl,
            expiry_ms: PAYMENT_EXPIRY_MS,
            use_unique_amount: String(process.env.USE_UNIQUE_AMOUNT || 'true').toLowerCase() !== 'false',
            unique_min: Math.max(1, parseInt(process.env.UNIQUE_AMOUNT_MIN || '1', 10)),
            unique_max: Math.min(999, parseInt(process.env.UNIQUE_AMOUNT_MAX || '999', 10))
        });
        let payment = result.payment;
        if (result.created) {
            const qrisPayload = generateDynamicQRIS(process.env.QRIS_STATIC, payment.payable_amount, payment.merchant_reference);
            payment = paymentStore.update(payment.id, { qris_payload: qrisPayload });
            logActivity('INFO', `Invoice ${payment.id} dibuat untuk order ${orderId}, nominal Rp ${payment.payable_amount}`);
        }
        return { payment, created: result.created };
    } catch (error) {
        if (result?.created && !result.payment.qris_payload) paymentStore.remove(result.payment.id);
        if (!error.status) error.status = 409;
        throw error;
    }
}

// API invoice persisten. order_id bersifat idempotent: request ulang mengembalikan invoice yang sama.
app.post('/api/v1/payments', apiKeyAuth, (req, res) => {
    try {
        const result = createPayment(req.body);
        return res.status(result.created ? 201 : 200).json({
            success: true,
            idempotent_replay: !result.created,
            data: paymentResponse(result.payment)
        });
    } catch (err) {
        logActivity('ERROR', `Gagal membuat invoice: ${err.message}`);
        return res.status(err.status || 500).json({ success: false, message: err.message });
    }
});

app.get('/api/v1/payments/:id', apiKeyAuth, (req, res) => {
    paymentStore.pending();
    const payment = paymentStore.get(req.params.id);
    if (!payment) return res.status(404).json({ success: false, message: 'Payment tidak ditemukan' });
    return res.json({ success: true, data: paymentResponse(payment) });
});

app.get('/api/v1/payments', apiKeyAuth, (req, res) => {
    paymentStore.pending();
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const payments = paymentStore.list()
        .filter(payment => !status || payment.status === status)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10))))
        .map(paymentResponse);
    return res.json({ success: true, data: payments });
});

// Render Halaman HTML QRIS Interaktif (Tombol Cek Manual + Auto Polling Toggle)
app.get('/qr/:id', (req, res) => {
    const qris = qrisStore.get(req.params.id);
    if (!qris) {
        return res.status(404).send('<h3>Gambar QRIS tidak ditemukan atau telah dihapus</h3>');
    }

    // Jika dipanggil via query format=raw / raw=1, redirect ke gambar mentah
    if (req.query.format === 'raw' || req.query.raw === '1') {
        if (Date.now() > qris.expiresAt.getTime()) {
            qrisStore.delete(req.params.id);
            return res.status(410).send('QRIS Kedaluwarsa');
        }
        const qrServerUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qris.data)}`;
        return res.redirect(302, qrServerUrl);
    }

    const formattedAmount = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(qris.amount);
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(qris.data)}`;
    const expiresTimestamp = qris.expiresAt.getTime();

    const html = `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pembayaran QRIS - ${formattedAmount}</title>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
        body { background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; }
        .card { background: #1e293b; border: 1px solid #334155; border-radius: 20px; width: 100%; max-width: 420px; padding: 28px 24px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); text-align: center; }
        .badge-qris { display: inline-flex; align-items: center; gap: 6px; background: rgba(0, 174, 217, 0.15); color: #38bdf8; font-weight: 600; font-size: 13px; padding: 6px 14px; border-radius: 20px; border: 1px solid rgba(56, 189, 248, 0.3); margin-bottom: 16px; }
        .amount-title { font-size: 14px; color: #94a3b8; margin-bottom: 4px; }
        .amount-value { font-size: 28px; font-weight: 700; color: #38bdf8; letter-spacing: -0.5px; margin-bottom: 20px; }
        .qr-wrapper { background: #ffffff; padding: 16px; border-radius: 16px; display: inline-block; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3); margin-bottom: 20px; position: relative; }
        .qr-wrapper img { display: block; width: 240px; height: 240px; border-radius: 8px; }
        .timer-box { font-size: 14px; color: #cbd5e1; background: #0f172a; padding: 10px 16px; border-radius: 12px; border: 1px solid #334155; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; }
        .timer-val { font-weight: 700; color: #f59e0b; font-family: monospace; font-size: 16px; }
        .status-badge { display: flex; align-items: center; justify-content: center; gap: 8px; font-weight: 600; font-size: 14px; padding: 12px; border-radius: 12px; margin-bottom: 20px; transition: all 0.3s ease; }
        .status-pending { background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); }
        .status-paid { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }
        .status-expired { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
        .btn-check { width: 100%; background: #0284c7; hover: #0369a1; color: #ffffff; border: none; font-weight: 600; font-size: 15px; padding: 14px; border-radius: 12px; cursor: pointer; transition: all 0.2s ease; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 6px -1px rgba(2, 132, 199, 0.3); }
        .btn-check:hover { background: #0369a1; transform: translateY(-1px); }
        .btn-check:disabled { background: #475569; cursor: not-allowed; opacity: 0.7; transform: none; }
        .toggle-box { display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 13px; color: #94a3b8; margin-top: 16px; }
        .toggle-box input[type="checkbox"] { width: 16px; height: 16px; accent-color: #0284c7; cursor: pointer; }
        .spinner { width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; border-radius: 50%; animation: spin 0.8s linear infinite; display: none; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .success-box { display: none; background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 12px; padding: 16px; text-align: left; font-size: 13px; color: #cbd5e1; margin-top: 16px; }
        .success-box strong { color: #4ade80; display: block; font-size: 15px; margin-bottom: 6px; }
    </style>
</head>
<body>
    <div class="card">
        <div class="badge-qris">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
            GoPay / QRIS Dinamis
        </div>

        <div class="amount-title">Total Pembayaran</div>
        <div class="amount-value">${formattedAmount}</div>

        <div class="qr-wrapper" id="qr-container">
            <img src="${qrImageUrl}" alt="QRIS Code">
        </div>

        <div class="timer-box">
            <span>Batas Waktu Pembayaran</span>
            <span class="timer-val" id="timer-text">05:00</span>
        </div>

        <div class="status-badge status-pending" id="status-badge">
            <span id="status-icon">🟡</span>
            <span id="status-text">Menunggu Pembayaran</span>
        </div>

        <button class="btn-check" id="btn-check" onclick="checkStatusManual()">
            <span class="spinner" id="btn-spinner"></span>
            <span id="btn-label">🔄 Cek Status Pembayaran</span>
        </button>

        <div class="toggle-box">
            <input type="checkbox" id="chk-auto" onchange="handleAutoPollChange(this)">
            <label for="chk-auto">Cek otomatis setiap 8 detik (Opsional)</label>
        </div>

        <div class="success-box" id="success-details">
            <strong>✅ Pembayaran Berhasil!</strong>
            <p>Order ID: <span id="tx-order"></span></p>
            <p>Sumber: <span id="tx-issuer"></span></p>
            <p>Waktu: <span id="tx-time"></span></p>
        </div>
    </div>

    <script>
        const qrisId = "${req.params.id}";
        const expiresTimestamp = ${expiresTimestamp};
        let isChecking = false;
        let isPaid = false;
        let isExpired = false;
        let pollTimer = null;

        function updateCountdown() {
            if (isPaid) return;
            const now = Date.now();
            const diff = expiresTimestamp - now;

            if (diff <= 0) {
                isExpired = true;
                document.getElementById('timer-text').innerText = "00:00";
                document.getElementById('status-badge').className = "status-badge status-expired";
                document.getElementById('status-icon').innerText = "🔴";
                document.getElementById('status-text').innerText = "QRIS Kedaluwarsa";
                document.getElementById('btn-check').disabled = true;
                document.getElementById('chk-auto').disabled = true;
                clearInterval(countdownInterval);
                stopAutoPoll();
                return;
            }

            const minutes = Math.floor(diff / 60000);
            const seconds = Math.floor((diff % 60000) / 1000);
            document.getElementById('timer-text').innerText = 
                String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
        }

        const countdownInterval = setInterval(updateCountdown, 1000);
        updateCountdown();

        async function checkStatusManual() {
            if (isChecking || isPaid || isExpired) return;
            isChecking = true;

            const btn = document.getElementById('btn-check');
            const spinner = document.getElementById('btn-spinner');
            const label = document.getElementById('btn-label');

            btn.disabled = true;
            spinner.style.display = 'inline-block';
            label.innerText = 'Memeriksa...';

            try {
                const res = await fetch('/api/qr-status/' + qrisId);
                const data = await res.json();

                if (data.success && data.paid) {
                    onPaymentSuccess(data.transaction);
                } else if (data.status === 'EXPIRED') {
                    isExpired = true;
                    updateCountdown();
                } else {
                    document.getElementById('status-text').innerText = "Belum Dibayar (Dicoba lagi...)";
                    setTimeout(() => {
                        if (!isPaid && !isExpired) {
                            document.getElementById('status-text').innerText = "Menunggu Pembayaran";
                        }
                    }, 2000);
                }
            } catch (err) {
                console.error("Gagal periksa status:", err);
            } finally {
                isChecking = false;
                if (!isPaid && !isExpired) {
                    btn.disabled = false;
                }
                spinner.style.display = 'none';
                label.innerText = '🔄 Cek Status Pembayaran';
            }
        }

        function onPaymentSuccess(tx) {
            isPaid = true;
            stopAutoPoll();
            clearInterval(countdownInterval);

            document.getElementById('status-badge').className = "status-badge status-paid";
            document.getElementById('status-icon').innerText = "🟢";
            document.getElementById('status-text').innerText = "Pembayaran Berhasil / Lunas";

            const btn = document.getElementById('btn-check');
            btn.disabled = true;
            btn.style.display = 'none';

            if (tx) {
                document.getElementById('tx-order').innerText = tx.order_id || tx.transaction_id || '-';
                document.getElementById('tx-issuer').innerText = tx.payer_issuer || 'GoPay / Bank';
                document.getElementById('tx-time').innerText = tx.transaction_time ? new Date(tx.transaction_time).toLocaleString('id-ID') : '-';
                document.getElementById('success-details').style.display = 'block';
            }
        }

        function startAutoPoll() {
            stopAutoPoll();
            pollTimer = setInterval(() => {
                if (!isChecking && !isPaid && !isExpired) {
                    checkStatusManual();
                }
            }, 8000);
        }

        function stopAutoPoll() {
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
        }

        function handleAutoPollChange(chk) {
            if (chk.checked) {
                startAutoPoll();
            } else {
                stopAutoPoll();
            }
        }

        // Start auto poll on load if checked
        if (document.getElementById('chk-auto').checked) {
            startAutoPoll();
        }
    </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
});

// Ambil Riwayat Transaksi
app.get('/transactions', apiKeyAuth, async (req, res) => {
    let headers = await sessionManager.getValidHeaders(req.headers['user-agent']);

    if (!headers && process.env.GOPAY_EMAIL && process.env.GOPAY_PASSWORD) {
        logActivity('INFO', 'Sesi tidak ditemukan, memicu auto-login...');
        await autoLoginGojek();
        headers = await sessionManager.getValidHeaders(req.headers['user-agent']);
    }

    if (!headers) return res.status(400).json({ success: false, error: 'Sesi GoPay belum ada. Jalankan `node login.js` di terminal.' });

    try {
        const fetchTransactions = async (activeHeaders) => {
            const merchantId = req.headers['x-gopay-merchant-id'] || process.env.GOPAY_MERCHANT_ID || '';
            const now = new Date();
            const startTimeISO = req.query.startTime ? new Date(parseInt(req.query.startTime) * 1000).toISOString() : new Date(now.getTime() - 3 * 24 * 3600 * 1000).toISOString();
            const endTimeISO = req.query.endTime ? new Date(parseInt(req.query.endTime) * 1000).toISOString() : now.toISOString();

            return await axios.get(GOJEK_TRANSACTIONS_URL, {
                headers: activeHeaders,
                params: {
                    from: 0,
                    size: parseInt(req.query.pageSize || '20', 10),
                    statuses: 'SETTLEMENT,CAPTURE,REFUND,PARTIAL_REFUND',
                    payment_types: 'QRIS,GOPAY,OFFLINE_CREDIT_CARD,OFFLINE_DEBIT_CARD,CREDIT_CARD',
                    start_time: startTimeISO,
                    end_time: endTimeISO,
                    merchant_ids: merchantId
                },
                timeout: 10000
            });
        };

        let response;
        try {
            response = await fetchTransactions(headers);
        } catch (firstErr) {
            if (firstErr.response && firstErr.response.status === 401) {
                logActivity('WARNING', 'Sesi expired (401). Memulai auto-refresh...');
                const refreshed = await sessionManager.refreshSession();
                if (refreshed) {
                    const newHeaders = await sessionManager.getValidHeaders(req.headers['user-agent']);
                    response = await fetchTransactions(newHeaders);
                } else {
                    throw firstErr;
                }
            } else {
                throw firstErr;
            }
        }

        const rawTransactions = response.data?.transactions || response.data?.data?.transactions || [];
        const formattedTransactions = rawTransactions.map(tx => ({
            amount: parseInt(tx.gross_amount || tx.real_gross_amount || 0, 10),
            status: tx.transaction_status ? tx.transaction_status.toLowerCase() : 'success',
            time: tx.transaction_time || tx.settlement_time,
            issuer: tx.qris_provider_aspi_issuer || 'GoPay / Bank',
            order_id: tx.order_id,
            transaction_id: tx.id
        }));

        res.json({
            success: true,
            total_amount: String(formattedTransactions.reduce((total, tx) => total + tx.amount, 0)),
            data: { transactions: formattedTransactions }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Shortcut Semua Transaksi Bulan Ini
app.get('/transactions/all', apiKeyAuth, async (req, res) => {
    const now = new Date();
    const startOfMonthUnix = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
    req.query.startTime = startOfMonthUnix;
    req.query.pageSize = 100;
    return app._router.handle({ ...req, url: '/transactions', method: 'GET' }, res);
});

// Core Helper: Verifikasi Pembayaran dari GoPay API
// qrisId: scope klaim — satu txId hanya bisa diklaim oleh satu qrisId
async function verifyPayment(amount, startTime, merchantIdOverride = null, userAgent = null, qrisId = null) {
    let headers = await sessionManager.getValidHeaders(userAgent);
    if (!headers) {
        throw new Error('Sesi GoPay belum ada. Jalankan `node login.js` di terminal.');
    }

    const fetchCheckPayment = async (activeHeaders) => {
        const merchantId = merchantIdOverride || process.env.GOPAY_MERCHANT_ID || '';
        const now = new Date();
        const startTimeISO = startTime ? new Date(startTime).toISOString() : new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
        const endTimeISO = now.toISOString();

        return await axios.get(GOJEK_TRANSACTIONS_URL, {
            headers: activeHeaders,
            params: {
                from: 0,
                size: 20,
                statuses: 'SETTLEMENT,CAPTURE,REFUND,PARTIAL_REFUND',
                payment_types: 'QRIS,GOPAY,OFFLINE_CREDIT_CARD,OFFLINE_DEBIT_CARD,CREDIT_CARD',
                start_time: startTimeISO,
                end_time: endTimeISO,
                merchant_ids: merchantId
            },
            timeout: 10000
        });
    };

    let response;
    try {
        response = await fetchCheckPayment(headers);
    } catch (firstErr) {
        if (firstErr.response && firstErr.response.status === 401) {
            logActivity('WARNING', 'Sesi expired (401) di verifyPayment. Memulai auto-refresh...');
            const refreshed = await sessionManager.refreshSession();
            if (refreshed) {
                const newHeaders = await sessionManager.getValidHeaders(userAgent);
                response = await fetchCheckPayment(newHeaders);
            } else {
                throw firstErr;
            }
        } else {
            throw firstErr;
        }
    }

    const rawTransactions = response.data?.transactions || response.data?.data?.transactions || response.data?.data || [];
    const targetAmount = parseInt(amount, 10);
    const filterStartTimeMs = startTime ? new Date(startTime).getTime() : 0;

    for (const tx of rawTransactions) {
        const amountCandidates = providerAmountCandidates(tx);
        const txAmount = amountCandidates.find(candidate => candidate === targetAmount);
        const txTimestamp = new Date(tx.transaction_time || tx.created_at || tx.settlement_time || 0).getTime();
        const txId = tx.id || tx.order_id || tx.wallstreet_transaction_id;

        if (txAmount !== undefined && txTimestamp >= filterStartTimeMs) {
            const existingClaim = claimedTransactions.get(txId);

            if (!existingClaim) {
                // Transaksi belum diklaim siapapun → klaim sekarang
                claimedTransactions.set(txId, { qrisId, claimedAt: Date.now() });
                logActivity('INFO', `TRX ${txId} diklaim oleh QRIS ${qrisId || 'manual-check'}`);
                return {
                    transaction_id: txId,
                    order_id: tx.order_id,
                    amount: txAmount,
                    payer_issuer: tx.qris_provider_aspi_issuer || 'GoPay / Bank',
                    payment_type: tx.payment_type || tx.transaction_source || 'GOPAY_INSTORE',
                    transaction_time: tx.transaction_time || tx.settlement_time
                };
            } else if (qrisId && existingClaim.qrisId === qrisId) {
                // Re-check dari QRIS yang sama → kembalikan hasil yang sudah diklaim
                return {
                    transaction_id: txId,
                    order_id: tx.order_id,
                    amount: txAmount,
                    payer_issuer: tx.qris_provider_aspi_issuer || 'GoPay / Bank',
                    payment_type: tx.payment_type || tx.transaction_source || 'GOPAY_INSTORE',
                    transaction_time: tx.transaction_time || tx.settlement_time
                };
            } else {
                // Transaksi ini sudah diklaim oleh QRIS lain → skip, cari transaksi berikutnya
                logActivity('INFO', `TRX ${txId} sudah diklaim oleh QRIS ${existingClaim.qrisId || 'lain'}, skip untuk QRIS ${qrisId}`);
                continue;
            }
        }
    }
    return null;
}

async function fetchMerchantTransactions(startTime) {
    let headers = await sessionManager.getValidHeaders('gopay-merchant-gateway-worker/2.0');
    if (!headers) throw new Error('Sesi GoPay belum tersedia');

    const request = activeHeaders => axios.get(GOJEK_TRANSACTIONS_URL, {
        headers: activeHeaders,
        params: {
            from: 0,
            size: 100,
            statuses: 'SETTLEMENT,CAPTURE',
            payment_types: 'QRIS,GOPAY',
            start_time: new Date(startTime).toISOString(),
            end_time: new Date().toISOString(),
            merchant_ids: process.env.GOPAY_MERCHANT_ID || ''
        },
        timeout: 10000
    });

    try {
        const response = await request(headers);
        return response.data?.transactions || response.data?.data?.transactions || response.data?.data || [];
    } catch (err) {
        if (err.response?.status !== 401) throw err;
        const refreshed = await sessionManager.refreshSession();
        if (!refreshed) throw err;
        headers = await sessionManager.getValidHeaders('gopay-merchant-gateway-worker/2.0');
        const response = await request(headers);
        return response.data?.transactions || response.data?.data?.transactions || response.data?.data || [];
    }
}

function normalizeTransaction(tx) {
    const referenceKeys = new Set([
        'reference_label', 'reference', 'bill_number', 'customer_reference',
        'merchant_reference', 'terminal_label'
    ]);
    const references = [];
    const visit = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 3) return;
        for (const [key, nested] of Object.entries(value)) {
            if (referenceKeys.has(key) && ['string', 'number'].includes(typeof nested)) {
                references.push(String(nested));
            } else if (typeof nested === 'object') {
                visit(nested, depth + 1);
            }
        }
    };
    visit(tx);

    return {
        transaction_id: String(tx.id || tx.wallstreet_transaction_id || tx.order_id || ''),
        order_id: tx.order_id || null,
        amount: rawProviderAmount(tx),
        amount_candidates: providerAmountCandidates(tx),
        transaction_time: tx.transaction_time || tx.settlement_time || tx.created_at || null,
        payer_issuer: tx.qris_provider_aspi_issuer || 'GoPay / Bank',
        payment_type: tx.payment_type || tx.transaction_source || 'QRIS',
        references,
        raw: tx
    };
}

function providerTransactionResponse(transaction) {
    const linkedPayment = paymentStore.list().find(payment =>
        payment.provider_transaction_id === transaction.transaction_id
    );
    const { raw, amount_candidates, ...safeTransaction } = transaction;
    if (!linkedPayment) return safeTransaction;

    return {
        ...safeTransaction,
        amount: linkedPayment.payable_amount,
        amount_normalized: linkedPayment.payable_amount !== transaction.amount
    };
}

let reconciliationRunning = false;
async function processWebhookQueue() {
    const candidates = paymentStore.list().filter(payment =>
        payment.status === 'PAID' &&
        payment.callback_url &&
        payment.webhook?.status !== 'DELIVERED' &&
        (payment.webhook?.attempts || 0) < 5
    );

    for (const payment of candidates) {
        const attempts = (payment.webhook?.attempts || 0) + 1;
        try {
            const result = await deliverWebhook(payment, process.env.WEBHOOK_SECRET);
            paymentStore.update(payment.id, { webhook: { status: result.status, attempts, last_error: null } });
            logActivity('SUCCESS', `Webhook payment ${payment.id} terkirim`);
        } catch (err) {
            paymentStore.update(payment.id, { webhook: { status: 'FAILED', attempts, last_error: err.message } });
            logActivity('WARNING', `Webhook payment ${payment.id} gagal (percobaan ${attempts}): ${err.message}`);
        }
    }
}

async function reconcilePayments() {
    if (reconciliationRunning) return;
    reconciliationRunning = true;
    reconciliationStatus.running = true;
    reconciliationStatus.last_started_at = new Date().toISOString();
    try {
        const pending = paymentStore.pending();
        if (pending.length) {
            const earliest = Math.min(...pending.map(payment => Date.parse(payment.created_at)));
            const rawTransactions = await fetchMerchantTransactions(earliest);
            const transactions = (Array.isArray(rawTransactions) ? rawTransactions : []).map(normalizeTransaction);
            reconciliationStatus.transactions_seen = transactions.length;

            // Prioritaskan nilai provider mentah. Fallback ÷100 hanya dipakai bila
            // endpoint Merchant Analytics mengembalikan IDR dalam minor unit.
            const matchPasses = [
                transaction => [transaction.amount],
                transaction => transaction.amount_candidates.filter(amount => amount !== transaction.amount)
            ];

            for (const amountCandidates of matchPasses) {
              for (const transaction of transactions) {
                if (!transaction.transaction_id || !transaction.amount) continue;
                const txTime = Date.parse(transaction.transaction_time || 0);
                const candidates = amountCandidates(transaction);
                if (!candidates.length) continue;
                const referenceMatch = pending.find(payment =>
                    candidates.includes(payment.payable_amount) &&
                    transaction.references.includes(payment.merchant_reference) &&
                    txTime >= Date.parse(payment.created_at)
                );
                const amountMatch = pending.find(payment =>
                    candidates.includes(payment.payable_amount) &&
                    txTime >= Date.parse(payment.created_at)
                );
                const payment = referenceMatch || amountMatch;
                if (!payment) continue;

                const matchedAmount = payment.payable_amount;
                const providerRawAmount = transaction.amount;

                const paid = paymentStore.markPaid(payment.id, {
                    transaction_id: transaction.transaction_id,
                    order_id: transaction.order_id,
                    amount: matchedAmount,
                    provider_raw_amount: providerRawAmount,
                    transaction_time: transaction.transaction_time,
                    payer_issuer: transaction.payer_issuer,
                    payment_type: transaction.payment_type,
                    matched_by: referenceMatch
                        ? 'QRIS_REFERENCE_AND_AMOUNT'
                        : (matchedAmount === transaction.amount ? 'UNIQUE_AMOUNT' : 'UNIQUE_AMOUNT_MINOR_UNIT')
                });
                if (paid) {
                    transaction.amount = matchedAmount;
                    transaction.amount_normalized = matchedAmount !== providerRawAmount;
                    logActivity('SUCCESS', `Payment ${paid.id} PAID oleh transaksi ${transaction.transaction_id}`);
                }
              }
            }
            providerTransactionCache = transactions.slice(0, 100).map(providerTransactionResponse);
        }
        await processWebhookQueue();
        reconciliationStatus.last_success_at = new Date().toISOString();
        reconciliationStatus.last_error = null;
    } catch (err) {
        reconciliationStatus.last_error = err.message;
        // Tidak adanya sesi saat belum ada invoice bukan error operasional. Error worker tetap dicatat saat ada pekerjaan.
        if (paymentStore.pending().length) logActivity('WARNING', `Worker rekonsiliasi: ${err.message}`);
    } finally {
        reconciliationRunning = false;
        reconciliationStatus.running = false;
    }
}

app.get('/api/v1/debug/transactions/raw', apiKeyAuth, async (req, res) => {
    if (String(process.env.ENABLE_RAW_TRANSACTION_DEBUG || 'false').toLowerCase() !== 'true') {
        return res.status(404).json({ success: false, message: 'Raw transaction debug dinonaktifkan' });
    }
    try {
        const hours = Math.min(72, Math.max(1, parseInt(req.query.hours || '24', 10)));
        const raw = await fetchMerchantTransactions(Date.now() - hours * 60 * 60 * 1000);
        return res.json({ success: true, warning: 'Data ini dapat mengandung informasi sensitif. Jangan dipublikasikan.', data: raw });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

const requireAdmin = adminAuth.requireSession.bind(adminAuth);
const requireAdminCsrf = adminAuth.requireCsrf.bind(adminAuth);

function adminPaymentResponse(payment) {
    return {
        ...paymentResponse(payment),
        qr_image_url: `/admin/api/payments/${encodeURIComponent(payment.id)}/qr`
    };
}

function paymentCounts() {
    const counts = { total: 0, pending: 0, paid: 0, expired: 0 };
    for (const payment of paymentStore.list()) {
        counts.total += 1;
        const key = String(payment.status || '').toLowerCase();
        if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key] += 1;
    }
    return counts;
}

app.get('/admin/api/monitor', requireAdmin, (req, res) => {
    paymentStore.pending();
    const merchantSession = sessionManager.loadSession();
    const memory = process.memoryUsage();
    return res.json({
        success: true,
        data: {
            service: {
                status: 'ONLINE',
                port: activePort,
                uptime_seconds: Math.floor(process.uptime()),
                node_version: process.version,
                memory_rss_mb: Math.round(memory.rss / 1024 / 1024),
                started_at: new Date(Date.now() - process.uptime() * 1000).toISOString()
            },
            merchant: {
                session_configured: Boolean(merchantSession?.access_token),
                merchant_id: merchantSession?.merchant_id || process.env.GOPAY_MERCHANT_ID || null,
                outlet_name: merchantSession?.outlet_name || null,
                token_expires_at: merchantSession?.expires_at || null,
                token_expired: merchantSession ? sessionManager.isExpired(merchantSession) : true
            },
            worker: { ...reconciliationStatus, interval_seconds: RECONCILE_INTERVAL_MS / 1000 },
            payments: paymentCounts(),
            provider_transactions: providerTransactionCache,
            activity: activityLogs.slice(0, 30).map(({ id, timestamp, type, message }) => ({ id, timestamp, type, message }))
        }
    });
});

app.post('/admin/api/monitor/sync', requireAdmin, requireAdminCsrf, async (req, res) => {
    try {
        const raw = await fetchMerchantTransactions(Date.now() - 24 * 60 * 60 * 1000);
        providerTransactionCache = (Array.isArray(raw) ? raw : [])
            .map(normalizeTransaction)
            .map(providerTransactionResponse)
            .slice(0, 100);
        reconciliationStatus.last_success_at = new Date().toISOString();
        reconciliationStatus.last_error = null;
        reconciliationStatus.transactions_seen = providerTransactionCache.length;
        await reconcilePayments();
        return res.json({ success: true, data: { transactions: providerTransactionCache } });
    } catch (error) {
        reconciliationStatus.last_error = error.message;
        return res.status(502).json({ success: false, message: `Sinkronisasi GoPay gagal: ${error.message}` });
    }
});

app.get('/admin/api/payments', requireAdmin, (req, res) => {
    paymentStore.pending();
    const payments = paymentStore.list()
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 100)
        .map(adminPaymentResponse);
    return res.json({ success: true, data: payments });
});

app.post('/admin/api/payments', requireAdmin, requireAdminCsrf, (req, res) => {
    try {
        const result = createPayment(req.body);
        return res.status(result.created ? 201 : 200).json({
            success: true,
            idempotent_replay: !result.created,
            data: adminPaymentResponse(result.payment)
        });
    } catch (error) {
        logActivity('ERROR', `Admin gagal membuat invoice: ${error.message}`);
        return res.status(error.status || 500).json({ success: false, message: error.message });
    }
});

app.get('/admin/api/payments/:id', requireAdmin, (req, res) => {
    paymentStore.pending();
    const payment = paymentStore.get(req.params.id);
    if (!payment) return res.status(404).json({ success: false, message: 'Payment tidak ditemukan' });
    return res.json({ success: true, data: adminPaymentResponse(payment) });
});

app.get('/admin/api/payments/:id/qr', requireAdmin, async (req, res) => {
    const payment = paymentStore.get(req.params.id);
    if (!payment?.qris_payload) return res.status(404).json({ success: false, message: 'QRIS payment tidak ditemukan' });
    try {
        const image = await QRCode.toBuffer(payment.qris_payload, {
            type: 'png',
            width: 420,
            margin: 2,
            errorCorrectionLevel: 'M',
            color: { dark: '#151919', light: '#F8FAF8' }
        });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Length', image.length);
        return res.end(image);
    } catch (error) {
        return res.status(500).json({ success: false, message: `QR gagal dibuat: ${error.message}` });
    }
});

// Endpoint Public Check Status QRIS (Dipanggil oleh Halaman Frontend HTML QRIS tanpa butuh API Key)
app.get('/api/qr-status/:id', async (req, res) => {
    const qrisId = req.params.id;
    const qris = qrisStore.get(qrisId);
    if (!qris) {
        return res.json({ success: false, status: 'NOT_FOUND', message: 'QRIS tidak ditemukan' });
    }

    if (qris.status === 'PAID') {
        return res.json({ success: true, paid: true, status: 'PAID', transaction: qris.transaction });
    }

    if (Date.now() > qris.expiresAt.getTime()) {
        qrisStore.delete(qrisId);
        return res.json({ success: false, paid: false, status: 'EXPIRED', message: 'QRIS sudah kedaluwarsa' });
    }

    try {
        // Pakai trx_id sebagai scope klaim agar transaksi hanya bisa diklaim oleh payment ini
        const matched = await verifyPayment(qris.amount, qris.createdAt, null, req.headers['user-agent'], qris.trxId || qrisId);
        if (matched) {
            qris.status = 'PAID';
            qris.transaction = matched;
            qrisStore.set(qrisId, qris);
            logActivity('SUCCESS', `Pembayaran QRIS ID ${qrisId} terverifikasi lunas untuk nominal Rp ${qris.amount}`);
            return res.json({ success: true, paid: true, status: 'PAID', transaction: matched });
        }
        return res.json({ success: true, paid: false, status: 'PENDING', message: 'Belum ada pembayaran masuk' });
    } catch (err) {
        return res.json({ success: false, paid: false, status: 'PENDING', message: err.message });
    }
});

// Cek Pembayaran Masuk (Support GET query & POST body)
// Opsional: sertakan qris_id atau trx_id sebagai scope klaim agar tidak konflik dengan payment lain
app.all('/check-payment', apiKeyAuth, async (req, res) => {
    const amount = req.body?.amount || req.query?.amount;
    const startTime = req.body?.startTime || req.query?.startTime || req.query?.start_time;
    // trx_id dipakai sebagai scope klaim agar tidak tabrakan dengan payment nominal sama
    const scopeId = req.body?.trx_id || req.query?.trx_id || null;

    if (!amount || isNaN(amount)) {
        return res.status(400).json({ success: false, message: 'Nominal pembayaran tidak valid' });
    }

    try {
        const merchantId = req.headers['x-gopay-merchant-id'] || null;
        const matchedTransaction = await verifyPayment(amount, startTime, merchantId, req.headers['user-agent'], scopeId);

        if (matchedTransaction) {
            logActivity('SUCCESS', `Pembayaran terverifikasi lunas untuk nominal Rp ${parseInt(amount, 10)}`, matchedTransaction);
            return res.json({
                success: true,
                paid: true,
                transaction: matchedTransaction
            });
        } else {
            return res.json({
                success: true,
                paid: false,
                message: 'Pembayaran belum ditemukan atau sudah pernah diklaim'
            });
        }
    } catch (err) {
        const errorDetail = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
        logActivity('ERROR', `Gagal periksa pembayaran: ${errorDetail}`);
        return res.status(500).json({
            success: false,
            message: 'Gagal mengambil data transaksi dari API GoPay',
            error: errorDetail
        });
    }
});

// Logs Endpoint
app.get('/api/logs', apiKeyAuth, (req, res) => {
    res.json({ success: true, logs: activityLogs });
});

async function startGateway() {
    try {
        const result = await listenWithFallback(app, {
            preferredPort: PORT,
            autoPort: AUTO_PORT,
            maxAttempts: MAX_PORT_ATTEMPTS,
            onRetry: (occupiedPort, nextPort) => {
                logActivity('WARNING', `Port ${occupiedPort} sedang dipakai, mencoba port ${nextPort}...`);
            }
        });
        activePort = result.port;
        logActivity('SYSTEM', `GoPay Partner Gateway berjalan pada http://localhost:${result.port}`);
        logActivity('SYSTEM', `Dashboard admin tersedia di http://localhost:${result.port}/admin`);
        if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
            logActivity('WARNING', 'Dashboard memakai kredensial admin default. Ganti ADMIN_EMAIL dan ADMIN_PASSWORD di .env sebelum akses publik.');
        }
        logActivity('SYSTEM', `Worker rekonsiliasi aktif setiap ${RECONCILE_INTERVAL_MS / 1000} detik`);
        setTimeout(reconcilePayments, 1000);
        setInterval(reconcilePayments, RECONCILE_INTERVAL_MS);
    } catch (error) {
        logActivity('ERROR', `Gateway gagal dijalankan: ${error.message}`);
        process.exitCode = 1;
    }
}

startGateway();
