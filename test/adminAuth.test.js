const test = require('node:test');
const assert = require('node:assert/strict');
const { AdminAuth, parseCookies, safeEqual } = require('../lib/adminAuth');

function requestWithCookie(cookie, csrfToken) {
    return { headers: { cookie, 'x-csrf-token': csrfToken } };
}

test('admin login membuat sesi, cookie aman, dan CSRF token', () => {
    const auth = new AdminAuth({ email: 'admin@hehe.com', password: 'admin@hehe.com' });
    const login = auth.login('ADMIN@HEHE.COM', 'admin@hehe.com', '127.0.0.1');

    assert.equal(login.ok, true);
    assert.ok(login.session.csrfToken.length >= 24);
    const cookie = auth.cookie(login.token);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal(parseCookies(cookie).gopay_admin_session, login.token);

    const session = auth.sessionFromRequest(requestWithCookie(cookie));
    assert.equal(session.email, 'admin@hehe.com');
    assert.equal(safeEqual(session.csrfToken, login.session.csrfToken), true);
});

test('login salah dibatasi setelah lima percobaan', () => {
    const auth = new AdminAuth({ email: 'admin@hehe.com', password: 'admin@hehe.com' });
    for (let attempt = 0; attempt < 5; attempt++) {
        assert.equal(auth.login('admin@hehe.com', 'salah', 'client-a').status, 401);
    }
    const blocked = auth.login('admin@hehe.com', 'admin@hehe.com', 'client-a');
    assert.equal(blocked.status, 429);
});

test('logout menghapus sesi aktif', () => {
    const auth = new AdminAuth({ email: 'admin@hehe.com', password: 'admin@hehe.com' });
    const login = auth.login('admin@hehe.com', 'admin@hehe.com', 'client-b');
    const cookie = auth.cookie(login.token);
    const request = requestWithCookie(cookie, login.session.csrfToken);

    assert.ok(auth.sessionFromRequest(request));
    auth.logout(request);
    assert.equal(auth.sessionFromRequest(request), null);
});

test('request mutasi admin menolak CSRF token yang salah', () => {
    const auth = new AdminAuth({ email: 'admin@hehe.com', password: 'admin@hehe.com' });
    const login = auth.login('admin@hehe.com', 'admin@hehe.com', 'client-c');
    const req = requestWithCookie(auth.cookie(login.token), 'token-yang-salah');
    req.adminSession = auth.sessionFromRequest(req);
    let statusCode = 200;
    let payload;
    const res = {
        status(code) { statusCode = code; return this; },
        json(body) { payload = body; return this; }
    };
    let continued = false;

    auth.requireCsrf(req, res, () => { continued = true; });

    assert.equal(continued, false);
    assert.equal(statusCode, 403);
    assert.equal(payload.success, false);
});
