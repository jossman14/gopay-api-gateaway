'use strict';

/**
 * Klien HTTP tipis di atas fetch bawaan Node.
 *
 * Diinjeksi ke setiap adapter provider supaya seluruhnya bisa diuji tanpa
 * jaringan — itulah kenapa tidak ada modul yang memanggil fetch langsung.
 */
async function httpClient(url, { method = 'GET', headers = {}, body, form, timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let payload;
    const hdrs = { ...headers };
    if (form) {
      payload = new URLSearchParams(form).toString();
      hdrs['content-type'] = 'application/x-www-form-urlencoded';
    } else if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      hdrs['content-type'] = hdrs['content-type'] || 'application/json';
    }

    const res = await fetch(url, { method, headers: hdrs, body: payload, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: Object.fromEntries(res.headers) };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Permintaan ke ${url} melewati batas waktu ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { httpClient };
