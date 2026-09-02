async function listenOnce(app, port, host) {
    return new Promise((resolve, reject) => {
        const server = app.listen(port, host);
        const onError = error => {
            server.removeListener('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.removeListener('error', onError);
            resolve(server);
        };
        server.once('error', onError);
        server.once('listening', onListening);
    });
}

async function listenWithFallback(app, options = {}) {
    const preferredPort = Number(options.preferredPort);
    if (!Number.isInteger(preferredPort) || preferredPort < 0 || preferredPort > 65535) {
        throw new Error('PORT harus berupa angka antara 0 dan 65535');
    }

    const autoPort = options.autoPort !== false;
    const maxAttempts = Math.max(1, Number(options.maxAttempts) || 20);
    const host = options.host;
    let port = preferredPort;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const server = await listenOnce(app, port, host);
            return { server, port: server.address().port, attempts: attempt };
        } catch (error) {
            const canRetry = autoPort && error.code === 'EADDRINUSE' && attempt < maxAttempts && port < 65535;
            if (!canRetry) throw error;
            if (typeof options.onRetry === 'function') options.onRetry(port, port + 1, attempt);
            port += 1;
        }
    }

    throw new Error(`Tidak menemukan port kosong setelah ${maxAttempts} percobaan`);
}

module.exports = { listenWithFallback };
