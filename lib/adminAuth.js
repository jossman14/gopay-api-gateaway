const crypto = require('crypto');

function safeEqual(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    if (a.length !== b.length) {
        crypto.timingSafeEqual(a, Buffer.alloc(a.length));
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}

function parseCookies(header = '') {
    return header.split(';').reduce((cookies, part) => {
        const separator = part.indexOf('=');
        if (separator === -1) return cookies;
        const key = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        if (key) cookies[key] = decodeURIComponent(value);
        return cookies;
    }, {});
}

class AdminAuth {
    constructor(options = {}) {
        this.email = String(options.email || 'admin@hehe.com').toLowerCase();
        this.password = String(options.password || 'admin@hehe.com');
        this.cookieName = options.cookieName || 'gopay_admin_session';
        this.ttlMs = options.ttlMs || 8 * 60 * 60 * 1000;
        this.maxFailures = options.maxFailures || 5;
        this.failureWindowMs = options.failureWindowMs || 15 * 60 * 1000;
        this.secureCookie = Boolean(options.secureCookie);
        this.sessions = new Map();
        this.failures = new Map();
    }

    cleanup(now = Date.now()) {
        for (const [token, session] of this.sessions) {
            if (session.expiresAt <= now) this.sessions.delete(token);
        }
        for (const [key, failure] of this.failures) {
            if (failure.resetAt <= now) this.failures.delete(key);
        }
    }

    login(email, password, clientKey = 'unknown') {
        const now = Date.now();
        this.cleanup(now);
        const failure = this.failures.get(clientKey);
        if (failure && failure.count >= this.maxFailures && failure.resetAt > now) {
            return { ok: false, status: 429, message: 'Terlalu banyak percobaan login. Coba lagi setelah 15 menit.' };
        }

        const valid = safeEqual(String(email || '').toLowerCase(), this.email) && safeEqual(password || '', this.password);
        if (!valid) {
            const current = failure && failure.resetAt > now ? failure : { count: 0, resetAt: now + this.failureWindowMs };
            current.count += 1;
            this.failures.set(clientKey, current);
            return { ok: false, status: 401, message: 'Email atau password tidak cocok.' };
        }

        this.failures.delete(clientKey);
        const token = crypto.randomBytes(32).toString('base64url');
        const session = {
            email: this.email,
            csrfToken: crypto.randomBytes(24).toString('base64url'),
            createdAt: now,
            expiresAt: now + this.ttlMs
        };
        this.sessions.set(token, session);
        return { ok: true, status: 200, token, session };
    }

    sessionFromRequest(req) {
        this.cleanup();
        const token = parseCookies(req.headers.cookie || '')[this.cookieName];
        if (!token) return null;
        const session = this.sessions.get(token);
        return session ? { token, ...session } : null;
    }

    requireSession(req, res, next) {
        const session = this.sessionFromRequest(req);
        if (!session) return res.status(401).json({ success: false, message: 'Sesi admin tidak aktif. Login kembali.' });
        req.adminSession = session;
        next();
    }

    requireCsrf(req, res, next) {
        const supplied = req.headers['x-csrf-token'];
        if (!req.adminSession || !supplied || !safeEqual(supplied, req.adminSession.csrfToken)) {
            return res.status(403).json({ success: false, message: 'CSRF token tidak valid. Muat ulang dashboard.' });
        }
        next();
    }

    cookie(token) {
        const parts = [
            `${this.cookieName}=${encodeURIComponent(token)}`,
            'Path=/',
            'HttpOnly',
            'SameSite=Strict',
            `Max-Age=${Math.floor(this.ttlMs / 1000)}`
        ];
        if (this.secureCookie) parts.push('Secure');
        return parts.join('; ');
    }

    clearCookie() {
        const parts = [`${this.cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
        if (this.secureCookie) parts.push('Secure');
        return parts.join('; ');
    }

    logout(req) {
        const token = parseCookies(req.headers.cookie || '')[this.cookieName];
        if (token) this.sessions.delete(token);
    }
}

module.exports = { AdminAuth, parseCookies, safeEqual };
