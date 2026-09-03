'use strict';

/**
 * Laporan pemasukan.
 *
 * Ini alasan gateway disebut "master": setiap aplikasi hanya melihat angkanya
 * sendiri, sementara admin melihat gabungan seluruh aplikasi dalam satu tempat.
 */

/** Ringkasan pemasukan satu klien pada rentang waktu. */
async function revenueForClient(pool, clientId, { from, to } = {}) {
  const { rows } = await pool.query(
    `SELECT
       count(*)                                    AS paid_count,
       coalesce(sum(payable_amount), 0)            AS gross_amount,
       coalesce(sum(base_amount), 0)               AS base_amount,
       coalesce(sum(unique_code), 0)               AS unique_code_total,
       min(paid_at)                                AS first_paid_at,
       max(paid_at)                                AS last_paid_at
     FROM invoices
     WHERE client_id = $1 AND status = 'PAID'
       AND ($2::timestamptz IS NULL OR paid_at >= $2)
       AND ($3::timestamptz IS NULL OR paid_at <  $3)`,
    [clientId, from || null, to || null]
  );
  return normalize(rows[0]);
}

/** Rincian pemasukan per aplikasi — pandangan master. */
async function revenueByClient(pool, { from, to } = {}) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name,
            count(i.*)                            AS paid_count,
            coalesce(sum(i.payable_amount), 0)    AS gross_amount,
            max(i.paid_at)                        AS last_paid_at
     FROM clients c
     LEFT JOIN invoices i
       ON i.client_id = c.id AND i.status = 'PAID'
      AND ($1::timestamptz IS NULL OR i.paid_at >= $1)
      AND ($2::timestamptz IS NULL OR i.paid_at <  $2)
     GROUP BY c.id, c.name
     ORDER BY gross_amount DESC`,
    [from || null, to || null]
  );
  return rows.map((r) => ({
    client_id: r.id, name: r.name,
    paid_count: Number(r.paid_count),
    gross_amount: Number(r.gross_amount),
    last_paid_at: r.last_paid_at,
  }));
}

/** Deret waktu harian, untuk grafik pemasukan. */
async function revenueDaily(pool, { clientId = null, from, to, timezone = 'Asia/Jakarta' } = {}) {
  const { rows } = await pool.query(
    `SELECT (paid_at AT TIME ZONE $4)::date AS day,
            count(*)                        AS paid_count,
            coalesce(sum(payable_amount),0) AS gross_amount
     FROM invoices
     WHERE status = 'PAID'
       AND ($1::text IS NULL OR client_id = $1)
       AND ($2::timestamptz IS NULL OR paid_at >= $2)
       AND ($3::timestamptz IS NULL OR paid_at <  $3)
     GROUP BY day ORDER BY day`,
    [clientId, from || null, to || null, timezone]
  );
  return rows.map((r) => ({
    day: r.day, paid_count: Number(r.paid_count), gross_amount: Number(r.gross_amount),
  }));
}

/** Rincian per provider — memperlihatkan jalur mana yang menghasilkan. */
async function revenueByProvider(pool, { from, to } = {}) {
  const { rows } = await pool.query(
    `SELECT provider, count(*) AS paid_count, coalesce(sum(payable_amount),0) AS gross_amount
     FROM invoices
     WHERE status = 'PAID'
       AND ($1::timestamptz IS NULL OR paid_at >= $1)
       AND ($2::timestamptz IS NULL OR paid_at <  $2)
     GROUP BY provider ORDER BY gross_amount DESC`,
    [from || null, to || null]
  );
  return rows.map((r) => ({
    provider: r.provider, paid_count: Number(r.paid_count), gross_amount: Number(r.gross_amount),
  }));
}

/** Cacah invoice per status — kesehatan operasional. */
async function statusBreakdown(pool, clientId = null) {
  const { rows } = await pool.query(
    `SELECT status, count(*) AS n FROM invoices
     WHERE ($1::text IS NULL OR client_id = $1)
     GROUP BY status ORDER BY status`,
    [clientId]
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

function normalize(row) {
  return {
    paid_count: Number(row.paid_count),
    gross_amount: Number(row.gross_amount),
    base_amount: Number(row.base_amount),
    unique_code_total: Number(row.unique_code_total),
    first_paid_at: row.first_paid_at,
    last_paid_at: row.last_paid_at,
  };
}

module.exports = {
  revenueForClient, revenueByClient, revenueDaily, revenueByProvider, statusBreakdown,
};
