# Payments Master Gateway

Gateway pembayaran terpusat untuk beberapa aplikasi. Satu tempat membuat tagihan,
satu tempat mencatat pemasukan. Aplikasi klien (`soal`, `review`, dan seterusnya)
memanggil API ini alih-alih mengintegrasikan penyedia pembayaran satu per satu.

## Kenapa ada

Sebelumnya tiap aplikasi punya jalur pembayarannya sendiri: `soal` memakai Mayar
dengan tabel `orders` terpisah, sementara QRIS GoPay berdiri sendiri. Pemasukan
jadi terpecah dan tidak ada satu angka yang bisa dipercaya. Gateway ini
menyatukannya.

## Provider

Tiga adapter di balik satu API. Yang dipakai per invoice bisa dipilih; bila tidak
disebut, urutan preferensinya `gobiz` → `mayar` → `gopay`.

| Provider | Status | Korelasi pembayaran | Tahu lunas dari |
|---|---|---|---|
| `gobiz` | **utamakan** — GoBiz Open API resmi | `order_id` + `transaction_id` | webhook |
| `mayar` | resmi | `id` invoice | webhook |
| `gopay` | cadangan, rapuh | nominal unik Rp1–999 | polling mutasi |

### Kenapa `gobiz` diutamakan

Adapter `gopay` adalah hasil rekayasa balik dashboard GoBiz web. Ia bekerja tanpa
registrasi, tapi:

- tidak ada webhook — pelunasan hanya diketahui dengan memoll tiap 20 detik;
- tidak ada korelasi pesanan — pembayaran dicocokkan lewat **nominal unik**,
  karena itu satu-satunya pembeda yang tersedia. Maka dua invoice `PENDING`
  bernominal sama dilarang, dan larangan itu ditegakkan database;
- bergantung pada API internal yang bisa berubah tanpa pemberitahuan.

Seluruh peretasan nominal unik itu tidak diperlukan pada `gobiz`, yang
mengembalikan `transaction_id` resmi dan mengirim webhook. Daftar di
<https://developer.gobiz.com> untuk memperoleh `client_id`/`client_secret`.

## Invarian uang

Ditegakkan **database**, bukan pemeriksaan di kode. Memeriksa lebih dulu lalu
menulis membuka jendela balapan; dengan uang, jendela itu berarti dobel kredit.

| Invarian | Penjaga |
|---|---|
| Satu pesanan → satu tagihan | `invoices_client_order_key` unik `(client_id, order_id)` |
| Aplikasi bebas menomori sendiri | kunci di atas mengikat klien, bukan global |
| Nominal `PENDING` tak boleh kembar | `invoices_pending_amount_key` parsial |
| Satu mutasi → satu invoice | `provider_transactions` PK `(provider, transaction_id)` |
| Pelunasan atomik | `markPaid` melakukan klaim + update dalam satu transaksi |

Kelimanya punya uji integrasi terhadap PostgreSQL asli di
`test/invoices.integration.test.js`.

## API

Semua permintaan klien memakai header `X-API-Key`. Setiap klien hanya melihat
invoicenya sendiri — pembatasan dilakukan di query, bukan menyaring hasil.

### Membuat invoice

```http
POST /v1/invoices
X-API-Key: pk_xxx.yyy
Content-Type: application/json

{ "order_id": "INV-2026-001", "amount": 100000, "callback_url": "https://soal.nusawangsa.com/api/payment/webhook" }
```

Idempoten terhadap `order_id`: memanggil ulang mengembalikan invoice yang sama,
bukan tagihan kedua.

```json
{ "success": true,
  "data": { "invoice": {
    "id": "inv_...", "order_id": "INV-2026-001", "provider": "gobiz",
    "status": "PENDING", "base_amount": 100000, "payable_amount": 100000,
    "qris_payload": "00020101...", "expires_at": "..." } } }
```

### Selebihnya

| Metode | Rute | Guna |
|---|---|---|
| `GET` | `/v1/invoices/:id` | detail invoice |
| `GET` | `/v1/invoices/by-order/:orderId` | cari dengan nomor pesanan sendiri |
| `GET` | `/v1/invoices?status=PAID&limit=50` | daftar invoice |
| `GET` | `/v1/invoices/:id/qr.png` | QR siap tampil |
| `POST` | `/v1/invoices/:id/replay-webhook` | kirim ulang notifikasi |
| `GET` | `/v1/reports/revenue?from=&to=` | pemasukan aplikasi ini |

### Admin (header `X-Admin-Token`)

| Metode | Rute | Guna |
|---|---|---|
| `POST` | `/admin/api/clients` | daftarkan aplikasi, kembalikan `api_key` **sekali** |
| `POST` | `/admin/api/clients/:id/rotate-key` | putar kunci |
| `GET` | `/admin/api/reports/revenue` | **pemasukan gabungan seluruh aplikasi** |
| `POST` | `/admin/api/reconcile` | rekonsiliasi manual (provider tanpa webhook) |
| `POST` | `/admin/api/gopay/login/request` | login OTP GoPay, langkah 1 |
| `POST` | `/admin/api/gopay/login/verify` | login OTP GoPay, langkah 2 |

Login OTP kini lewat API, menggantikan `node login.js` yang interaktif dan
menyulitkan deployment di container.

## Webhook keluar

Setiap notifikasi ditandatangani dengan secret milik klien:

```
X-Gateway-Signature: t=1756800000,v1=<hmac-sha256>
```

Yang ditandatangani adalah `<timestamp>.<body>`. Timestamp ikut masuk agar
kiriman lama tidak bisa diputar ulang. Verifikasi di sisi penerima ada di
`src/webhooks/deliver.js` (`verifySignature`) dan bisa disalin apa adanya.

Hostname callback dibatasi `WEBHOOK_ALLOWED_HOSTS`. Alamat loopback dan jaringan
privat **selalu** ditolak, apa pun isi allowlist — tanpa itu gateway bisa
dipakai sebagai batu loncatan SSRF.

Coba-ulang eksponensial: 1m, 2m, 4m, … dibatasi 1 jam, maksimal
`WEBHOOK_MAX_ATTEMPTS`. Setiap percobaan tercatat di `webhook_deliveries`
sehingga kegagalan tidak senyap dan bisa diputar ulang.

## Menjalankan

```bash
cp .env.example .env      # isi DATABASE_URL dan minimal satu provider
npm install
npm start                 # migrasi berjalan otomatis sebelum port dibuka
npm test                  # 27 tes; uji integrasi jalan bila TEST_DATABASE_URL diisi
```

Uji integrasi butuh PostgreSQL sungguhan karena yang diuji justru constraint-nya:

```bash
TEST_DATABASE_URL=postgresql://... npm test
```

## Struktur

```
src/
├── config/       validasi env saat start — salah konfigurasi = gagal terbit
├── db/           pool, runner migrasi, migrations/
├── domain/       invoices, reconcile, reports, clients  (logika uang)
├── providers/    gobiz/ (resmi) · mayar/ · gopay/ (cadangan)
├── http/         app, client, middleware/, routes/
├── webhooks/     penandatanganan, allowlist, coba-ulang
└── lib/          qris (EMVCo TLV), providerAmount
```

## Catatan keamanan

- Kunci API disimpan sebagai hash SHA-256, tidak pernah teks terang. Prefix
  dipakai untuk pencarian terindeks, hash dibandingkan `timingSafeEqual`.
- Webhook masuk **tidak** dipercaya isinya. Payload hanya dipakai sebagai sinyal;
  status ditanyakan ulang ke provider, jadi memalsukan notifikasi tidak berguna.
- Dashboard admin mati bila `ADMIN_SESSION_SECRET` kosong — fitur hilang lebih
  baik daripada terbuka dengan kredensial default.
- Versi 1 memuat `sessionManager.js` dan `login.js` yang terobfuskasi berat
  (869 KB gabungan) dan memegang sesi merchant. Keduanya dihapus dan diganti
  `src/providers/gopay/goid.js`, 182 baris yang bisa dibaca dan diuji.
