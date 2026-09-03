-- Pengaturan yang bisa diubah dari konsol tanpa redeploy.
--
-- Nilai di sini menimpa environment. Env tetap jadi dasar agar deployment baru
-- punya konfigurasi awal yang masuk akal, sementara operator bisa menyetel
-- tanpa menyentuh Dokploy.
--
-- is_secret menandai nilai yang TIDAK boleh dikembalikan API. Konsol hanya
-- diberi tahu apakah sebuah rahasia sudah terisi, bukan isinya.
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    is_secret  BOOLEAN     NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT
);
