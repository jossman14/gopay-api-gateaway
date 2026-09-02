# Invoice API v1

Implementasi ini menambahkan alur payment gateway yang persisten di atas login/session GoPay dari repository asli.

> Integrasi Merchant Analytics GoPay yang dipakai repository ini tidak resmi. Uji dengan merchant sendiri, gunakan interval polling yang wajar, dan jangan menganggap tag reference QRIS pasti dikembalikan oleh GoPay sebelum dibuktikan melalui transaksi nyata.

## Alur

1. Backend toko membuat invoice melalui `POST /api/v1/payments`.
2. Gateway mengalokasikan suffix unik Rp1-999 untuk invoice `PENDING`.
3. Gateway membuat QRIS dinamis dengan nominal akhir dan reference pada EMV tag `62.05`.
4. Satu worker mengambil mutasi GoPay untuk seluruh invoice, bukan satu polling GoPay per browser.
5. Worker mencocokkan `reference + amount` bila reference diteruskan GoPay; jika tidak, ia memakai nominal unik.
6. Payment diubah atomik menjadi `PAID`, transaction ID diklaim satu kali, lalu webhook HMAC dikirim.

Untuk respons Merchant Analytics tertentu yang mengembalikan IDR sebagai minor unit (contoh pembayaran Rp11 terbaca `1100`), worker selalu mencoba nominal mentah terlebih dahulu lalu fallback `÷100`. Hasil fallback dicatat sebagai `UNIQUE_AMOUNT_MINOR_UNIT` agar dapat diaudit.

State disimpan atomik di `data/payments.json` dan volume tersebut dipertahankan oleh Docker Compose. Ini cocok untuk satu instance/MVP. Untuk beberapa instance atau throughput production, ganti `PaymentStore` dengan PostgreSQL dan transaksi database/unique constraint.

## Konfigurasi

Salin `.env.example` ke `.env`, isi `API_KEY`, `QRIS_STATIC`, dan session GoPay seperti dokumentasi asli. Konfigurasi baru:

```env
PORT=3000
AUTO_PORT=true
MAX_PORT_ATTEMPTS=20
PAYMENT_EXPIRY_MINUTES=15
USE_UNIQUE_AMOUNT=true
UNIQUE_AMOUNT_MIN=1
UNIQUE_AMOUNT_MAX=999
RECONCILE_INTERVAL_SECONDS=20
PAYMENT_STORE_FILE=data/payments.json
WEBHOOK_SECRET=secret-acak-minimal-32-karakter
WEBHOOK_ALLOWED_HOSTS=example.com
ENABLE_RAW_TRANSACTION_DEBUG=false
```

Jika `PORT` sedang dipakai, `AUTO_PORT=true` membuat gateway mencoba port berikutnya secara otomatis. Contoh: `3000` sibuk akan berpindah ke `3001`. Perhatikan URL aktual pada log startup. Gunakan `AUTO_PORT=false` bila reverse proxy atau firewall mewajibkan satu port tetap.

Jangan menonaktifkan `USE_UNIQUE_AMOUNT` bila beberapa order dapat memiliki nominal yang sama. Tag `62.05` diperlakukan sebagai peningkatan akurasi eksperimental, bukan satu-satunya dasar rekonsiliasi.

## Membuat payment

```http
POST /api/v1/payments
X-API-Key: YOUR_API_KEY
Content-Type: application/json

{
  "order_id": "INV-20260902-001",
  "amount": 100000,
  "callback_url": "https://example.com/webhooks/payment"
}
```

Contoh response:

```json
{
  "success": true,
  "idempotent_replay": false,
  "data": {
    "id": "pay_...",
    "order_id": "INV-20260902-001",
    "merchant_reference": "PAY-...",
    "base_amount": 100000,
    "unique_code": 37,
    "amount": 100037,
    "status": "PENDING",
    "qris_code": "000201010212...",
    "expires_at": "..."
  }
}
```

`order_id` idempotent. Mengirim request yang sama lagi mengembalikan payment yang sama dan `idempotent_replay: true`.

Status payment:

```http
GET /api/v1/payments/pay_...
X-API-Key: YOUR_API_KEY
```

Daftar payment:

```http
GET /api/v1/payments?status=PENDING&limit=20
X-API-Key: YOUR_API_KEY
```

## Verifikasi webhook

Gateway mengirim body JSON dengan header:

```text
X-Payment-Timestamp: 1788312345
X-Payment-Signature: sha256=<hex>
```

Signature dihitung sebagai:

```text
HMAC-SHA256(timestamp + "." + raw_request_body, WEBHOOK_SECRET)
```

Backend penerima wajib memakai raw body, perbandingan constant-time, menolak timestamp lama (misalnya lebih dari lima menit), dan membuat pemrosesan `payment_id`/`transaction_id` idempotent. Gateway mencoba pengiriman paling banyak lima kali.

## Eksperimen reference QRIS

Untuk melihat apakah GoPay Merchant Analytics mengembalikan tag `62.05`, aktifkan sementara:

```env
ENABLE_RAW_TRANSACTION_DEBUG=true
```

Lalu, setelah satu pembayaran uji kecil:

```http
GET /api/v1/debug/transactions/raw?hours=24
X-API-Key: YOUR_API_KEY
```

Cari field seperti `reference_label`, `reference`, `bill_number`, `customer_reference`, atau `merchant_reference`. Endpoint ini dapat menampilkan data transaksi sensitif; matikan lagi setelah pengujian dan jangan membuka aksesnya ke publik.

## Pengujian

```bash
npm test
npm start
```

## Dashboard admin

Setelah server berjalan, buka:

```text
http://localhost:<port-aktual>/admin
```

Port aktual dicetak pada log startup dan dapat berpindah otomatis bila port pilihan sedang digunakan. Kredensial dashboard diatur melalui:

```env
ADMIN_EMAIL=admin@hehe.com
ADMIN_PASSWORD=admin@hehe.com
ADMIN_SECURE_COOKIE=false
```

Gunakan `ADMIN_SECURE_COOKIE=true` ketika dashboard dipasang di belakang HTTPS. Dashboard menggunakan cookie `HttpOnly`, `SameSite=Strict`, CSRF token, pembatasan percobaan login, dan tidak mengirim API key atau token GoPay ke browser.
