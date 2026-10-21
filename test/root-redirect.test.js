'use strict';
/**
 * Regression: GET / must redirect to /hehehe (admin console entry).
 *
 * Prior state: root returned 404 JSON, breaking usable entry point.
 * Fix: HTTP 302 redirect to /hehehe so users hitting bare domain land on admin.
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// Minimal Runtime stub — pool is needed for auth middleware, registry for config.
const mockPool = {
  query() { return Promise.resolve({ rows: [] }); },
};
const mockRegistry = new Map();
const mockConfig = { sessionSecret: 'test-secret-not-real', sessionTTL: 3_600_000 };
const mockLog = () => {};

class MockRuntime {
  constructor() {
    this.config = mockConfig;
    this.registry = mockRegistry;
  }
  reload() { return Promise.resolve(); }
  stop() {}
}

const { buildApp } = require('../src/http/app');

let server;
beforeEach(() => {
  const app = buildApp({
    pool: mockPool,
    runtime: new MockRuntime(),
    log: mockLog,
  });
  server = app.listen(0);
});

afterEach(() => {
  server.close();
});

function get(url, headers = {}) {
  return new Promise((resolve) => {
    const addr = server.address();
    const req = http.get({ hostname: '127.0.0.1', port: addr.port, path: url, headers }, (res) => {
      resolve({ status: res.statusCode, location: res.headers.location });
    });
    req.on('error', (err) => resolve({ status: 0, error: err.message }));
  });
}

describe('root entry point', () => {
  test('GET / returns 302 redirect to /hehehe', async () => {
    const res = await get('/');
    assert.equal(res.status, 302, `expected 302, got ${res.status}`);
    assert.equal(res.location, '/hehehe', `expected redirect to /hehehe, got "${res.location}"`);
  });

  // Express static redirects /hehehe → /hehehe/ (trailing slash).
  // We follow the redirect chain to assert the final destination is 200.
  test('GET /hehehe ultimately serves the admin console (200)', async () => {
    const addr = server.address();
    const check = (path) =>
      new Promise((resolve) => {
        const req = http.get({ hostname: '127.0.0.1', port: addr.port, path }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            resolve(check(res.headers.location));
          } else {
            resolve(res.statusCode);
          }
        });
        req.on('error', () => resolve(0));
      });
    const status = await check('/hehehe');
    assert.equal(status, 200, `expected 200 after following redirects, got ${status}`);
  });
});
