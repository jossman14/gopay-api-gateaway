# Integrasi Aplikasi

Panduan menyambungkan aplikasi apa pun ke gateway pembayaran. Bahasa dan
kerangka bebas — yang dibutuhkan hanya kemampuan memanggil HTTP dan menerima
webhook.

## 1. Daftarkan aplikasi

Buka konsol di `https://bayar.nusawangsa.com/hehehe` → **Aplikasi** → **+ Aplikasi**.

| Kolom | Isi |
|---|---|
| ID | pengenal tetap, huruf kecil, mis. `toko` |
| Nama | untuk tampilan laporan |
| Callback URL | endpoint yang menerima notifikasi lunas |

Kunci API muncul **satu kali** di layar itu. Simpan segera — ia disimpan sebagai
hash, jadi tidak bisa ditampilkan ulang. Kalau hilang, putar kunci baru lewat
tombol **Ubah → Putar kunci**; yang lama langsung tidak berlaku.

## 2. Buat tagihan

```http
POST https://bayar.nusawangsa.com/v1/invoices
X-API-Key: pk_xxxxxxxxx.yyyyyyyyyyyyyyyyyyyy
Content-Type: application/json

{
  "order_id": "INV-2026-0001",
  "amount": 50000,
  "callback_url": "https://tokomu.com/webhook/bayar"
}
```

`order_id` adalah nomor pesanan **milikmu**. Ia hanya perlu unik di dalam
aplikasimu sendiri — aplikasi lain boleh memakai nomor yang sama tanpa bentrok.

Pemanggilan bersifat **idempoten**: mengirim `order_id` yang sama akan
mengembalikan tagihan yang sudah ada, bukan membuat tagihan kedua. Jadi
percobaan ulang akibat timeout jaringan aman.

```json
{
  "success": true,
  "data": {
    "invoice": {
      "id": "inv_9f2c...",
      "order_id": "INV-2026-0001",
      "status": "PENDING",
      "base_amount": 50000,
      "unique_code": 7,
      "payable_amount": 50007,
      "qris_payload": "00020101021226...",
      "expires_at": "2026-09-03T10:15:00.000Z"
    }
  }
}
```

**Tagihkan `payable_amount`, bukan `amount`.** Selisihnya adalah kode unik Rp1–999
yang dipakai gateway untuk mengenali pembayaran mana milik tagihan mana. Kalau
pembeli membayar `base_amount`, pembayarannya tidak akan pernah tercocokkan.

Tampilkan QR-nya dengan salah satu cara:

```html
<!-- gambar siap pakai, berlogo -->
<img src="https://bayar.nusawangsa.com/v1/invoices/inv_9f2c.../qr.png"
     alt="QRIS pembayaran">
```

atau render sendiri dari `qris_payload` memakai pustaka QR apa pun.

## 3. Terima notifikasi lunas

Saat pembayaran terdeteksi, gateway mengirim `POST` ke `callback_url`:

```http
POST /webhook/bayar
X-Gateway-Signature: t=1756800000,v1=3f8a2b...
X-Gateway-Event: invoice.paid
Content-Type: application/json

{
  "event": "invoice.paid",
  "invoice": {
    "id": "inv_9f2c...",
    "order_id": "INV-2026-0001",
    "status": "PAID",
    "provider": "gopay",
    "base_amount": 50000,
    "payable_amount": 50007,
    "paid_at": "2026-09-03T10:03:12.481Z"
  }
}
```

### Verifikasi tanda tangan — jangan dilewati

Tanpa verifikasi, siapa pun yang menebak URL callback bisa menandai pesanan
lunas. Yang ditandatangani adalah `<timestamp>.<body mentah>`:

```js
const crypto = require('crypto');

function verifikasi(secret, rawBody, header) {
  const bagian = Object.fromEntries(header.split(',').map(p => p.split('=')));
  const ts = Number(bagian.t);
  // Menolak kiriman lama membuat serangan putar-ulang tidak berguna.
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const harap = crypto.createHmac('sha256', secret)
    .update(`${ts}.${rawBody}`).digest('hex');
  const a = Buffer.from(harap, 'hex');
  const b = Buffer.from(bagian.v1 || '', 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

```python
import hmac, hashlib, time

def verifikasi(secret: str, raw_body: bytes, header: str) -> bool:
    bagian = dict(p.split("=", 1) for p in header.split(","))
    ts = int(bagian.get("t", 0))
    if abs(time.time() - ts) > 300:
        return False
    harap = hmac.new(secret.encode(), f"{ts}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(harap, bagian.get("v1", ""))
```

Gunakan **body mentah**, bukan hasil parse lalu serialisasi ulang — urutan kunci
bisa berubah dan tanda tangannya jadi tidak cocok.

### Tanggapi dengan 2xx

Status di luar 2xx dianggap gagal dan akan dicoba ulang: 1 menit, 2, 4, 8, …
sampai 1 jam, maksimal 6 kali. Balas cepat, kerjakan prosesnya di belakang.

**Buat penanganan bersifat idempoten.** Percobaan ulang berarti `order_id` yang
sama bisa tiba dua kali; aktifkan pesanan hanya bila statusnya belum aktif.

## 4. Bila webhook terlewat

Webhook bisa gagal karena aplikasimu sempat mati. Dua jaring pengaman:

```http
GET https://bayar.nusawangsa.com/v1/invoices/by-order/INV-2026-0001
X-API-Key: pk_...
```

Polling status saat pembeli kembali ke halaman pesanan sudah cukup untuk
sebagian besar kasus. Untuk memaksa kiriman ulang:

```http
POST https://bayar.nusawangsa.com/v1/invoices/inv_9f2c.../replay-webhook
X-API-Key: pk_...
```

## 5. Laporan pemasukan

```http
GET https://bayar.nusawangsa.com/v1/reports/revenue?from=2026-09-01&to=2026-10-01
X-API-Key: pk_...
```

Mengembalikan ringkasan, deret harian, dan cacah per status — **hanya untuk
aplikasimu sendiri**. Pandangan gabungan seluruh aplikasi ada di konsol admin.

## Daftar endpoint

| Metode | Rute | Guna |
|---|---|---|
| `POST` | `/v1/invoices` | buat tagihan (idempoten per `order_id`) |
| `GET` | `/v1/invoices/:id` | detail tagihan |
| `GET` | `/v1/invoices/by-order/:orderId` | cari dengan nomor pesananmu |
| `GET` | `/v1/invoices?status=PAID&limit=50` | daftar tagihan |
| `GET` | `/v1/invoices/:id/qr.png` | gambar QR |
| `POST` | `/v1/invoices/:id/replay-webhook` | kirim ulang notifikasi |
| `GET` | `/v1/reports/revenue` | pemasukan aplikasimu |

## Status tagihan

| Status | Arti |
|---|---|
| `PENDING` | menunggu pembayaran |
| `PAID` | lunas dan terverifikasi |
| `EXPIRED` | lewat batas waktu, tidak dibayar |
| `CANCELLED` | dibatalkan lewat konsol |
| `FAILED` | ditolak provider |

Hanya `PAID` yang boleh dianggap sebagai uang masuk.

## Bentuk galat

```json
{ "success": false, "errors": [{ "message": "order_id wajib diisi" }] }
```

| Kode | Arti |
|---|---|
| 400 | permintaan tidak sah |
| 401 | `X-API-Key` salah atau tidak ada |
| 404 | tagihan tidak ditemukan, atau bukan milikmu |
| 409 | nominal bentrok; coba lagi sesaat kemudian |
| 503 | provider pembayaran belum dikonfigurasi |

## Yang perlu diperhatikan

**Tagihan kedaluwarsa dalam 15 menit** (dapat diubah di konsol). Sesudah itu
pembayaran tidak akan tercocokkan. Buat tagihan saat pembeli benar-benar siap
membayar, bukan saat memasukkan barang ke keranjang.

**Nominal unik bersifat terbatas** — Rp1 sampai Rp999 per nominal dasar. Bila
seluruhnya sedang dipakai tagihan yang masih `PENDING`, permintaan dibalas 409;
coba lagi setelah ada yang selesai atau kedaluwarsa.

**Deteksi pembayaran memerlukan waktu sampai 20 detik** pada jalur GoPay, karena
pelunasan diketahui lewat penarikan berkala, bukan dorongan dari provider.

**Simpan `webhook_secret` seperti kata sandi.** Ia yang membuktikan notifikasi
berasal dari gateway ini.
