# Aturan Wajib Repo fb-grupV2 (Cline)

## 1. Orientasi vs Kontrak

- README.md = peta + cara pakai. Baca SEKALI di awal task untuk orientasi:
  struktur folder src/shared|background|content|dashboard, cara Load unpacked,
  Reload ekstensi, troubleshooting umum.
- docs/ARCHITECTURE.md = KONTRAK yang tidak boleh dilanggar. WAJIB dibaca
  SETIAP KALI sebelum mengubah file apapun di src/, manifest.json,
  dashboard.html, atau tools/.

## 2. Kontrak yang dijaga (dari ARCHITECTURE.md)

- Classic script + namespace global `globalThis.FBAP` (IIFE + "use strict").
  Bukan ES Module. Tanpa build step.
- Urutan pemuatan adalah kontrak (modul destructuring FBAP.\* saat eksekusi):
  Background: shared/config -> shared/random -> shared/time -> shared/storage
  -> state -> power -> messaging -> tabs -> scan -> scheduler
  Content: shared/config -> shared/random -> shared/time -> shared/spintax
  -> selectors -> dom -> stealth -> media -> navigation -> scraper
  -> posting -> content (urutan sama di manifest.json content_scripts[0].js)
  Dashboard: shared/config -> shared/time -> shared/storage
  -> state -> ui -> materials -> settings -> groups -> controls -> main
- Dua tempat harus selalu sinkron: manifest.json -> content_scripts[0].js
  dan FBAP.config.CONTENT_SCRIPT_FILES.
- Satu modul = satu tanggung jawab. Dependensi satu arah: shared/_ ->
  modul konteks -> entry. shared/_ tidak boleh mengimpor apapun.
- Semua kunci chrome.storage.local via FBAP.config.STORAGE._, semua tipe
  pesan via FBAP.config.MSG._ (tanpa string ajaib).
- Perilaku halus yang dipertahankan: storage.set (tak pernah reject) vs
  storage.setStrict (reject saat lastError), guard content.routerReady
  (anti listener ganda), antrean dipersist sebelum alarm pertama,
  status sesi = memori + alarm post-tick (bukan kunci storage saja),
  alur posting media-dulu+caption, EXECUTE_TEST_POST tanpa klik Posting.

## 3. Mengubah ARCHITECTURE.md

- File itu dokumen hidup. BOLEH dan WAJIB diubah saat asumsi arsitektur berubah:
  tambah tipe MSG baru, tambah/ubah urutan modul, ubah timeout perilaku kritis,
  temuan bug yang jadi aturan umum (dipromosikan ke bagian 8 Keputusan Desain).
- DILARANG mengubah/melonggarkan kontrak hanya supaya verify lulus.
  Yang dibetulkan kodenya, bukan dokumennya.
- Jangan tulis detail fungsi-per-fungsi di sana; itu tugas komentar kode.
  ARCHITECTURE.md hanya kontrak antar-modul + alasan keputusan.
- Prosedur: ubah kode -> update ARCHITECTURE.md -> update tools/verify.js
  bila perlu -> jalankan verify sampai hijau.

## 4. Verifikasi wajib

- Setelah selesai mengubah kode, WAJIB jalankan `node tools/verify.js`
  dan memastikan lulus (30 checks) sebelum selesai.
- Jangan selesai bila verify merah.
