# FB Auto Poster — Ekstensi Chrome (Manifest V3)

Ekstensi posting otomatis ke grup Facebook dengan simulasi aktivitas manusia
(anti-bot stealth). Mode aktif: **input langsung** — caption & media dikirim dari
dashboard, grup dipilih otomatis oleh background melalui navigasi natural
(home → Grup → sidebar → klik grup teratas). Rantai navigasi yang sama bisa
diuji tanpa memposting apa pun lewat tombol **🧪 Uji Buka Composer**.

## Struktur Folder

```
fbGrup-AutoPosting/
├─ manifest.json            # MV3: service worker + daftar content script
├─ dashboard.html           # UI dashboard (memuat modul src/dashboard/*)
├─ src/
│  ├─ shared/               # util lintas konteks (tanpa dependensi)
│  │  ├─ config.js          #   konfigurasi, kunci storage, tipe pesan, batas
│  │  ├─ random.js          #   randInt, gauss
│  │  ├─ time.js            #   nowStamp, todayKey, sleep
│  │  ├─ storage.js         #   pembungkus Promise chrome.storage.local
│  │  └─ spintax.js         #   parser {varian1|varian2}
│  ├─ background/           # service worker (modular via importScripts)
│  │  ├─ service-worker.js  #   entry: listener chrome.* + message router
│  │  ├─ state.js           #   state aktif (run) + restoreState
│  │  ├─ power.js           #   chrome.power keep-awake
│  │  ├─ messaging.js       #   log, setRunning, broadcastQueueInfo
│  │  ├─ tabs.js            #   tab FB/dashboard, injeksi content script
│  │  └─ scheduler.js       #   antrean + alarm + processNextPost
│  ├─ content/              # content script (urut, satu isolated world)
│  │  ├─ content.js         #   entry: message router saja
│  │  ├─ selectors.js       #   selektor DOM stabil (role/aria)
│  │  ├─ dom.js             #   penunggu & pencari elemen
│  │  ├─ stealth.js         #   humanizer: scroll, ketik, klik
│  │  ├─ media.js           #   data URL → File → input upload
│  │  ├─ navigation.js      #   navigasi natural home → grup
│  │  ├─ scraper.js         #   scraper daftar grup (fitur nonaktif)
│  │  └─ posting.js         #   eksekusi posting ke grup
│  └─ dashboard/            # logika UI dashboard
│     ├─ state.js           #   state UI
│     ├─ ui.js              #   $, escapeHtml, addLog, setStatus
│     ├─ materials.js       #   import Excel/CSV + folder media
│     ├─ settings.js        #   pengaturan anti-bot & limit
│     ├─ groups.js          #   tabel grup + pencarian
│     ├─ controls.js        #   start/stop, tab FB, event realtime
│     └─ main.js            #   entry: catch error global + init()
├─ docs/ARCHITECTURE.md     # detail arsitektur, protokol pesan, konvensi
├─ tools/verify.js          # pemeriksa struktur (node tools/verify.js)
├─ vendor/xlsx.full.min.js  # library pihak ketiga (SheetJS)
├─ assets/template_materi.xlsx
└─ backups/                 # arsip (tidak dipakai runtime)
```

## Cara Memuat

1. Buka `chrome://extensions` → aktifkan **Developer mode**.
2. **Load unpacked** → pilih folder proyek ini (folder yang berisi `manifest.json`).
3. Klik ikon ekstensi untuk membuka dashboard.
4. Import materi (Excel/CSV kolom `Caption` & `Media_Name`), pilih folder media,
   lalu tekan **Mulai Posting**.
5. Untuk memastikan jalur navigasi (dan login FB) sehat tanpa memposting apa pun,
   klik **🧪 Uji Buka Composer**: background membuka homepage FB, mengklik menu
   **Grup** di sidebar, memilih grup teratas, lalu membuka composer grup tersebut.
   Hasil (nama & URL grup) tampil di Live Log dan antrean posting tidak tersentuh.

## Troubleshooting

- **Tombol "Mulai Posting" tidak bisa diklik (abu-abu) & status "Berjalan".**
  Kunci `status` di storage tertinggal dari sesi sebelumnya yang berakhir tanpa
  `stopPosting()` — misalnya browser/ekstensi ditutup saat posting berjalan,
  atau service worker MV3 dimatikan di antara dua alarm. Sejak
  `scheduler.getStatus()`, dashboard menanyakan status sebenarnya ke background
  setiap kali dibuka: bila alarm `post-tick` tidak lagi aktif, status basi
  (`status`, `queue`, `cursor`) dibersihkan otomatis dan tombol kembali aktif.
  Bila masih terkunci, tekan **Hentikan Posting**, lalu muat ulang ekstensi.
- **Perubahan kode tidak berpengaruh.** Setelah mengedit file, klik **Reload**
  pada kartu ekstensi di `chrome://extensions`, tutup lalu buka kembali tab
  dashboard.

## Verifikasi Struktur

```bash
node tools/verify.js
```

Memeriksa (30 check): sintaks semua file JS, kode mati, konsistensi id DOM
dashboard, sinkronisasi `manifest.json` ↔ `FBAP.config.CONTENT_SCRIPT_FILES`,
urutan `<script>` dashboard, konstanta pesan, paritas nama fungsi & tipe pesan
dengan versi sebelum refactor (`backups/pre-refactor/`), smoke test pemuatan
seluruh modul memakai `vm` + stub `chrome`/`document`, pemulihan status
basi (tombol **Mulai Posting** tidak terkunci oleh sesi lama), serta uji rantai
navigasi `home → grup → composer` di atas DOM Facebook tiruan.

## Aturan Main (Konvensi)

- **Tanpa build step.** Semua file adalah classic script yang mendaftarkan diri ke
  namespace global `globalThis.FBAP` (IIFE + `"use strict"`).
- **Satu modul = satu tanggung jawab.** Entry (`service-worker.js`, `content.js`,
  `main.js`) hanya memuat modul, memasang listener, dan menjalankan inisialisasi.
- **Dependensi satu arah:** `shared/*` → modul konteks → entry. `shared/*` tidak
  boleh mengimpor apa pun.
- **Urutan pemuatan wajib dijaga** (lihat `docs/ARCHITECTURE.md`) dan diverifikasi
  otomatis oleh `tools/verify.js`.
- Semua kunci `chrome.storage.local` diakses via `FBAP.config.STORAGE.*`, semua tipe
  pesan via `FBAP.config.MSG.*` (tidak ada string ajaib yang tersebar).

## Catatan Refactor (v1.0.0 struktur)

Tidak ada perubahan perilaku pada alur posting. Yang berubah hanya struktur file;
agar ekstensi tetap jalan, muat ulang ekstensi di `chrome://extensions`.

- `background.js`, `content.js`, `dashboard.js` dipecah menjadi `src/background/*`,
  `src/content/*`, `src/dashboard/*`; util bersama dipindah ke `src/shared/*`.
- `xlsx.full.min.js` → `vendor/xlsx.full.min.js`; `template_materi.xlsx` → `assets/`.
  Salinan duplikat `js/xlsx.full.min.js` (identik secara hash) dihapus.
- Utilitas yang sebelumnya terduplikasi (`nowStamp`, `todayKey`, `randInt`, `gauss`,
  `sleep`, `parseSpintax`, pembungkus storage) kini satu implementasi di `src/shared`.
- Kode mati yang dihapus: `EDITOR_SELECTOR` & `randFloat` (content.js), `spin` &
  `storageRemove` (dashboard.js), serta variabel `txt` yang tidak terpakai.
- Tombol **Reset** pada kartu Pengaturan Anti-Bot tadinya belum punya handler; kini
  mengisi form dengan nilai default (baru tersimpan setelah **Simpan Pengaturan**).

