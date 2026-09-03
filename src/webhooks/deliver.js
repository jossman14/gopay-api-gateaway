'use strict';

const crypto = require('crypto');

/**
 * Pengiriman webhook ke aplikasi klien.
 *
 * Setiap kiriman ditandatangani HMAC-SHA256 dengan secret milik klien itu
 * sendiri, sehingga penerima bisa membuktikan pesan datang dari gateway ini dan
 * bukan dari siapa pun yang menebak URL callback.
 */

/** `t=<unix>,v1=<hex>` — timestamp ikut ditandatangani agar tidak bisa diputar ulang. */
function signPayload(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const payload = `${timestamp}.${typeof body === 'string' ? body : JSON.stringify(body)}`;
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { header: `t=${timestamp},v1=${mac}`, timestamp, signature: mac };
}

/** Verifikasi untuk dipakai sisi penerima (soal, review). Diekspor agar bisa diuji. */
function verifySignature(secret, body, header, { toleranceSeconds = 300, now = Date.now() } = {}) {
  if (typeof header !== 'string') return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const ts = Number(parts.t);
  if (!Number.isFinite(ts)) return false;
  // Menolak kiriman yang terlalu tua membuat serangan putar-ulang tidak berguna.
  if (Math.abs(now / 1000 - ts) > toleranceSeconds) return false;

  const expected = signPayload(secret, body, ts).signature;
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(parts.v1 || ''), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Memastikan URL callback aman dituju.
 *
 * Tanpa penyaring ini, klien yang dikompromikan bisa memakai gateway sebagai
 * batu loncatan untuk menjangkau layanan internal (SSRF).
 */
function isAllowedUrl(rawUrl, allowedHosts) {
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;

  const host = url.hostname.toLowerCase();
  // Alamat loopback dan jaringan privat selalu ditolak, apa pun allowlist-nya.
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host)) return false;
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;

  if (allowedHosts.length === 0) return true;
  return allowedHosts.some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`));
}

/** Jeda coba-ulang eksponensial: 1m, 2m, 4m, ... dibatasi 1 jam. */
function backoffMs(attempt) {
  return Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
}

/** Mengantrikan kiriman. Pengiriman dilakukan worker, bukan di jalur permintaan. */
async function enqueue(pool, { invoiceId, url, event }) {
  const { rows } = await pool.query(
    `INSERT INTO webhook_deliveries (invoice_id, url, event, next_retry_at)
     VALUES ($1,$2,$3, now()) RETURNING *`,
    [invoiceId, url, event]
  );
  return rows[0];
}

/** Memproses satu batch kiriman yang jatuh tempo. */
async function processDue(pool, { http, config, log = () => {} }) {
  const { rows } = await pool.query(
    `SELECT d.*, i.client_id, i.order_id, i.status AS invoice_status,
            i.payable_amount, i.base_amount, i.paid_at, i.provider,
            c.webhook_secret
     FROM webhook_deliveries d
     JOIN invoices i ON i.id = d.invoice_id
     JOIN clients  c ON c.id = i.client_id
     WHERE d.status = 'PENDING' AND d.next_retry_at <= now()
     ORDER BY d.next_retry_at LIMIT 20`
  );

  for (const row of rows) {
    if (!isAllowedUrl(row.url, config.webhook.allowedHosts)) {
      await fail(pool, row, 'URL callback tidak diizinkan', config, true);
      continue;
    }
    const body = {
      event: row.event,
      invoice: {
        id: row.invoice_id, order_id: row.order_id, status: row.invoice_status,
        provider: row.provider, base_amount: Number(row.base_amount),
        payable_amount: Number(row.payable_amount), paid_at: row.paid_at,
      },
    };
    const { header } = signPayload(row.webhook_secret, body);
    try {
      const res = await http(row.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-gateway-signature': header,
                   'x-gateway-event': row.event },
        body, timeoutMs: config.webhook.timeoutMs,
      });
      if (res.status >= 200 && res.status < 300) {
        await pool.query(
          `UPDATE webhook_deliveries SET status='DELIVERED', attempts=attempts+1, delivered_at=now()
           WHERE id=$1`, [row.id]
        );
        log(`webhook terkirim: invoice ${row.invoice_id} -> ${row.url}`);
      } else {
        await fail(pool, row, `HTTP ${res.status}`, config);
      }
    } catch (err) {
      await fail(pool, row, err.message, config);
    }
  }
  return rows.length;
}

async function fail(pool, row, reason, config, permanent = false) {
  const attempts = row.attempts + 1;
  const exhausted = permanent || attempts >= config.webhook.maxAttempts;
  await pool.query(
    `UPDATE webhook_deliveries
     SET attempts=$2, last_error=$3,
         status = CASE WHEN $4 THEN 'FAILED' ELSE 'PENDING' END,
         next_retry_at = CASE WHEN $4 THEN NULL ELSE now() + ($5 || ' milliseconds')::interval END
     WHERE id=$1`,
    [row.id, attempts, String(reason).slice(0, 500), exhausted, backoffMs(attempts)]
  );
}

module.exports = { signPayload, verifySignature, isAllowedUrl, backoffMs, enqueue, processDue };
