# FP BJY: Invoice PDF ke XML Coretax

Aplikasi web untuk mengubah PDF "Faktur Penjualan" (invoice yang dibuat di Excel lalu disimpan sebagai PDF) menjadi file XML faktur pajak keluaran yang bisa diimpor ke Coretax. Bisa dipakai dari HP, tablet, atau laptop.

Alamat aplikasinya: **https://vill0701.github.io/fp-bjy/**

## Cara pakai

1. Pertama kali di tiap perangkat: isi NPWP penjual di Pengaturan.
2. Pilih satu atau beberapa PDF invoice. Satu PDF boleh berisi beberapa invoice. PDF dibaca di perangkat, tidak di-upload ke mana pun.
3. Aplikasi memeriksa setiap invoice: jumlah baris sama dengan Sub Total, PPN cocok, dan total DPP, DPP Nilai Lain, serta PPN faktur sama dengan angka di invoice.
4. NPWP pembeli diambil dari invoice. Kode barang otomatis 720000, satuan BTG menjadi Piece dan LBR menjadi Lembar. Semuanya bisa diubah per barang, dan perubahannya diingat.
5. Download XML, lalu impor di Coretax.

## Cara hitung

Sama dengan template Excel: harga jual = harga termasuk PPN ÷ 1,11. Invoice mencetak harga yang sudah dibagi 1,11 dan dibulatkan ke rupiah, jadi harga termasuk PPN dihitung balik dari kolom Harga dan Jumlah (misalnya Harga 81.081 berasal dari 90.000 ÷ 1,11 = 81.081,08). DPP Nilai Lain = 11/12 × DPP, PPN = 12% × DPP Nilai Lain, dibulatkan ke sen. Untuk harga yang bulat, hasilnya sama persis dengan angka invoice.

## Data

Tidak ada data master dan tidak ada server. NPWP penjual, kode barang yang diubah, dan riwayat XML hanya disimpan di browser perangkat itu. Untuk memindahkannya ke perangkat lain, pakai Pengaturan → Simpan cadangan / Pulihkan cadangan.

Commit yang membawa file data (PDF, XML, CSV, Excel, folder `contoh/`) atau angka mirip NPWP ditolak otomatis oleh `.githooks/pre-commit`. Aktifkan sekali di setiap salinan repo:

```
git config core.hooksPath .githooks
```

## Pengembangan

- `npm test`: jalankan tes. Tes dengan file contoh asli (PDF invoice, PDF faktur Coretax, XML dari template Excel) hanya berjalan kalau folder `contoh/` ada di laptop.
- `npm start`: coba di http://localhost:8080.
- `npm run vendor`: salin PDF.js ke `vendor/` setelah memperbarui `pdfjs-dist`.
- `npm run kode-barang -- path/ke/ListOfGoods.txt`: perbarui daftar kode barang dari file referensi DJP.
