-- Ledger master pembayaran.
--
-- Prinsip: invarian uang ditegakkan database, bukan kode aplikasi. Versi lama
-- menjaganya di Map dalam memori dan satu berkas JSON — hilang saat restart dan
-- tidak tahan dua proses. Semua yang di bawah ini bertahan dan atomik.

CREATE TABLE IF NOT EXISTS clients (
    id              TEXT PRIMARY KEY,
    name            TEXT        NOT NULL,
    api_key_hash    TEXT        NOT NULL,
    api_key_prefix  TEXT        NOT NULL,
    callback_url    TEXT,
    webhook_secret  TEXT,
    active          BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pencarian saat autentikasi memakai prefix, bukan memindai seluruh tabel lalu
-- membandingkan hash satu per satu.
CREATE UNIQUE INDEX IF NOT EXISTS clients_api_key_prefix_key ON clients (api_key_prefix);

CREATE TABLE IF NOT EXISTS invoices (
    id                  TEXT PRIMARY KEY,
    client_id           TEXT        NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
    order_id            TEXT        NOT NULL,
    provider            TEXT        NOT NULL,
    merchant_reference  TEXT        NOT NULL,
    base_amount         BIGINT      NOT NULL CHECK (base_amount > 0),
    unique_code         INTEGER     NOT NULL DEFAULT 0 CHECK (unique_code >= 0),
    payable_amount      BIGINT      NOT NULL CHECK (payable_amount > 0),
    currency            TEXT        NOT NULL DEFAULT 'IDR',
    status              TEXT        NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'PAID', 'EXPIRED', 'CANCELLED', 'FAILED')),
    qris_payload        TEXT,
    callback_url        TEXT,
    metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL,
    paid_at             TIMESTAMPTZ
);

-- order_id hanya unik DI DALAM satu klien. Ini yang membuat soal dan review
-- bebas memakai penomoran sendiri tanpa risiko bentrok, sekaligus membuat
-- pembuatan invoice idempoten per klien.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_client_order_key
    ON invoices (client_id, order_id);

-- Rekonsiliasi mencocokkan mutasi berdasarkan nominal. Dua invoice PENDING
-- dengan nominal sama membuat pencocokan ambigu dan berisiko salah kredit,
-- jadi larangannya ditegakkan di sini — bukan diperiksa di kode lalu balapan.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_pending_amount_key
    ON invoices (provider, payable_amount)
    WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS invoices_client_created_idx ON invoices (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_status_expires_idx  ON invoices (status, expires_at);
CREATE INDEX IF NOT EXISTS invoices_paid_at_idx         ON invoices (paid_at) WHERE status = 'PAID';

-- Mutasi mentah dari provider. Satu transaksi provider hanya boleh dipakai
-- untuk melunasi satu invoice; PRIMARY KEY gabungan itulah penjaganya, dan
-- itu jauh lebih kuat daripada Map di memori yang dipakai versi lama.
CREATE TABLE IF NOT EXISTS provider_transactions (
    provider                TEXT        NOT NULL,
    provider_transaction_id TEXT        NOT NULL,
    invoice_id              TEXT        REFERENCES invoices (id) ON DELETE SET NULL,
    amount                  BIGINT      NOT NULL,
    amount_source           TEXT        NOT NULL DEFAULT 'RAW'
                            CHECK (amount_source IN ('RAW', 'MINOR_UNIT')),
    transaction_time        TIMESTAMPTZ,
    raw                     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    claimed_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, provider_transaction_id)
);

CREATE INDEX IF NOT EXISTS provider_tx_invoice_idx ON provider_transactions (invoice_id);

-- Riwayat pengiriman webhook. Dicatat agar kegagalan kirim tidak senyap dan
-- bisa diputar ulang tanpa menebak apa yang sudah terkirim.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id           BIGSERIAL PRIMARY KEY,
    invoice_id   TEXT        NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
    url          TEXT        NOT NULL,
    event        TEXT        NOT NULL,
    status       TEXT        NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED')),
    attempts     INTEGER     NOT NULL DEFAULT 0,
    last_error   TEXT,
    next_retry_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS webhook_pending_idx
    ON webhook_deliveries (next_retry_at) WHERE status = 'PENDING';

-- Sesi GoPay. Sebelumnya berupa berkas JSON di samping kode; di sini agar satu
-- sumber kebenaran dan tidak ikut hilang saat container diganti.
CREATE TABLE IF NOT EXISTS provider_sessions (
    provider      TEXT PRIMARY KEY,
    phone_number  TEXT,
    merchant_id   TEXT,
    outlet_name   TEXT,
    access_token  TEXT,
    refresh_token TEXT,
    device_id     TEXT,
    expires_at    TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
