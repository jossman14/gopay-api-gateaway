-- Memisahkan invoice uji dari transaksi sungguhan.
--
-- Menghapus data uji begitu saja menghilangkan jejak bahwa sistem pernah
-- diverifikasi. Menandainya lebih baik: laporan pemasukan mengabaikannya secara
-- baku, tapi buktinya tetap bisa dilihat bila diperlukan.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS invoices_real_paid_idx
    ON invoices (paid_at) WHERE status = 'PAID' AND is_test = FALSE;

-- Invoice yang dibuat selama verifikasi awal ditandai berdasarkan pola nomornya.
UPDATE invoices SET is_test = TRUE
 WHERE order_id LIKE '%TEST%' OR order_id LIKE '%DUPE%'
    OR order_id LIKE 'UJI-%' OR order_id LIKE 'CRUD-%';
