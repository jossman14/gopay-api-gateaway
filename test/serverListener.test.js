const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { listenWithFallback } = require('../lib/serverListener');

function listen(server, port = 0) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });
}

function close(server) {
    return new Promise(resolve => server.close(resolve));
}

test('berpindah ke port berikutnya ketika port pilihan sedang dipakai', async () => {
    const blocker = http.createServer((_req, res) => res.end('occupied'));
    await listen(blocker);
    const occupiedPort = blocker.address().port;
    assert.ok(occupiedPort < 65535, 'Port ephemeral harus memungkinkan satu fallback');

    const app = express();
    app.get('/', (_req, res) => res.send('gateway'));
    const retries = [];
    let gateway;
    try {
        const result = await listenWithFallback(app, {
            preferredPort: occupiedPort,
            autoPort: true,
            maxAttempts: 3,
            host: '127.0.0.1',
            onRetry: (from, to) => retries.push({ from, to })
        });
        gateway = result.server;

        assert.equal(result.port, occupiedPort + 1);
        assert.equal(result.attempts, 2);
        assert.deepEqual(retries, [{ from: occupiedPort, to: occupiedPort + 1 }]);
    } finally {
        if (gateway) await close(gateway);
        await close(blocker);
    }
});

test('mengembalikan EADDRINUSE saat auto port dimatikan', async () => {
    const blocker = http.createServer((_req, res) => res.end('occupied'));
    await listen(blocker);
    try {
        await assert.rejects(
            listenWithFallback(express(), {
                preferredPort: blocker.address().port,
                autoPort: false,
                host: '127.0.0.1'
            }),
            error => error.code === 'EADDRINUSE'
        );
    } finally {
        await close(blocker);
    }
});
