# Arsitektur — FB Auto Poster

Dokumen ini menjelaskan pembagian lapisan, kontrak antar modul, dan alasan
keputusan desain. Setiap perubahan struktur wajib menjaga aturan di sini dan
tetap lulus `node tools/verify.js`.

## 1. Tiga Konteks Runtime

| Konteks                       | Entry                              | Cara memuat                                                                                   | Boleh mengakses                |
| ----------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------ |
| Background (service worker)   | `src/background/service-worker.js` | `manifest.background.service_worker` + `importScripts()`                                      | seluruh `chrome.*`             |
| Content script (tab Facebook) | `src/content/content.js`           | `manifest.content_scripts[0].js` (daftar urut) atau fallback `chrome.scripting.executeScript` | DOM halaman + `chrome.runtime` |
| Dashboard (tab ekstensi)      | `src/dashboard/main.js`            | `<script src>` di `dashboard.html`                                                            | DOM dashboard + `chrome.*`     |

Semua konteks memakai util yang sama dari `src/shared/*` dengan mendaftarkan diri
ke satu namespace: **`globalThis.FBAP`**.

## 2. Mengapa Classic Script, Bukan ES Module?

- Content script MV3 **tidak bisa** dideklarasikan sebagai `type: "module"` di
  manifest, dan `import` dinamis untuk file internal menambah kompleksitas
  (`web_accessible_resources`, CORS internal).
- Tanpa bundler, satu-satunya cara berbagi kode ke tiga konteks adalah script
  klasik yang menempelkan API ke satu namespace.
- Konsekuensinya: **urutan pemuatan adalah kontrak**, bukan detail. Modul
  melakukan destructuring dari `FBAP.*` saat dieksekusi, jadi dependensi harus
  sudah dimuat lebih dulu.

### Urutan Pemuatan (WAJIB)

```
Background : shared/config → shared/random → shared/time → shared/storage
             → shared/materialkey → media-store → state → power → messaging
             → tabs → account → scan → scheduler   (via importScripts)

Content    : shared/config → shared/random → shared/time → shared/spintax
             → selectors → dom → stealth → media → navigation → scraper
             → posting → account → content      (urutan sama di manifest.json)

Dashboard  : shared/config → shared/time → shared/storage → shared/materialkey
             → state → ui → materials → settings → groups → controls
             → account → main
```

`shared/random.js` dan `shared/spintax.js` sengaja tidak dimuat di dashboard
karena tidak dipakai di sana (menghindari kode mati).

Dua tempat yang harus selalu sinkron: `manifest.json → content_scripts[0].js`
dan `FBAP.config.CONTENT_SCRIPT_FILES`. Bila berbeda, fallback injeksi akan
memuat modul dengan urutan salah → dijaga oleh `tools/verify.js`.

## 3. Protokol Pesan (`FBAP.config.MSG`)

| Tipe                           | Arah                   | Payload                                                              | Efek                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ---------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PING`                         | background → content   | –                                                                    | Cek content script terpasang (`{ok:true,pong:true}`)                                                                                                                                                                                                                                                                                   |
| `NAV_HOME_TO_GROUP`            | background → content   | –                                                                    | Navigasi natural, balas `{groupUrl, groupName}`                                                                                                                                                                                                                                                                                        |
| `NAV_HOME_TO_COMPOSER`         | background → content   | –                                                                    | Navigasi natural + buka composer, balas `{groupUrl, groupName, url}`                                                                                                                                                                                                                                                                   |
| `EXECUTE_POST`                 | background → content   | `autoPost, caption, mediaDataUrl, mediaMime, mediaName, extraGroups` | `postToGroup()`: inti media-dulu+caption → tambah s.d. 9 grup via picker "Tambahkan grup" (selalu otomatis, kedua mode) → (mode autoposting) klik Posting + verifikasi composer tertutup / (mode manual) tunggu `LIMITS.MANUAL_POST_WINDOW_MS` lalu lanjut tanpa klik — balas `{ok, added, failed, addedNames}` (added/failed = url grup tambahan; addedNames = [{url, name, how}] nama baris picker yang tercentang, how = exact|fuzzy). Bila grup tidak punya kolom posting (hanya tombol "Jual sesuatu"), `openComposer()` melempar Error ber-prefix `SKIP_SELL_GROUP:` yang mengalir sebagai `error` |
| `SELL_GROUP_MARKED`            | background → dashboard | `{url, name}`                                                        | Grup terdeteksi jual-beli: dashboard me-uncheck barisnya realtime + badge 🏷️ (lihat §8) |
| `EXECUTE_SCRAPE`               | background → content   | –                                                                    | Scraper daftar grup mode lama (scroll window)                                                                                                                                                                                                                                                                                          |
| `START_SCAN`                   | dashboard → background | –                                                                    | Mulai scan sidebar /groups/feed/ pada tab sementara. Guard `scanStatus` anti-dobel; balas `{ok, accepted}` tanpa menunggu hasil — hasil dibaca dashboard via `storage.onChanged` pada kunci `scanStatus`/`groups`. Orkestrasi di `background/scan.js`                                                                                  |
| `SCAN_GROUPS`                  | background → content   | –                                                                    | `scanGroups()`: loop scroll sidebar (maks 80 pass) + kumpulkan `a[href*="/groups/"]`, balas `{ok, sourceUrl, scannedAt, groups}`                                                                                                                                                                                                       |
| `START_POSTING`                | dashboard → background | `{materials, settings}`                                              | Bangun antrean + mulai alarm                                                                                                                                                                                                                                                                                                           |
| `STOP_POSTING`                 | dashboard → background | –                                                                    | Hentikan antrean & lepas keep-awake                                                                                                                                                                                                                                                                                                    |
| `GET_STATUS`                   | dashboard → background | –                                                                    | `{ok, running, recovered?, nextAt}` — status dihitung dari memori + alarm; status basi dibersihkan; `nextAt` = epoch ms posting berikutnya (countdown)                                                                                                                                                                                |
| `SET_VIEW`                     | dashboard → background | `showFbTab`                                                          | Set mode tampilan tab FB                                                                                                                                                                                                                                                                                                               |
| `VIEW_FB_TAB`                  | dashboard → background | –                                                                    | Fokus/buka tab FB                                                                                                                                                                                                                                                                                                                      |
| `OPEN_COMPOSER`                | dashboard → background | –                                                                    | Uji jalur navigasi home → grup → composer (tab FB difokuskan selama proses, lalu fokus balik ke dashboard)                                                                                                                                                                                                                             |
| `GET_ACCOUNT_NAME`             | dashboard → background | –                                                                    | Deteksi nama akun FB yang sedang login. Background membuka **tab deteksi SEMENTARA** `tabs.create(FB_HOME, active:false, pinned:true)` → `waitTabLoaded` → settle → kirim `GET_ACCOUNT_NAME` ke content script (fallback `ensureContentScript` lalu kirim ulang) → tulis `STORAGE.ACCOUNT_NAME` → `tabs.remove()` + `focusDashboard()` di `finally`. Balas `{ok, name}` / `{ok:false, error, busy?}`. Tipe yang SAMA dipakai background → content script (`content/account.js`) untuk membaca DOM   |
| `BACK_TO_DASHBOARD`            | dashboard → background | –                                                                    | Fokus balik ke tab dashboard                                                                                                                                                                                                                                                                                                           |
| `LOG` / `STATE` / `QUEUE_INFO` | background → dashboard | teks log / running / sisa antrean + `nextAt` (epoch ms posting berikutnya untuk countdown) | Update UI realtime + countdown "X mnt Y dtk"                                                                                                                                                                                                                                            |

Nilai setiap konstanta sengaja identik dengan namanya agar mudah dilacak di
DevTools. `tools/verify.js` memastikan tidak ada konstanta yang menganggur dan
tidak ada tipe pesan lama yang hilang.

## 4. Kunci `chrome.storage.local` (`FBAP.config.STORAGE`)

| Kunci                       | Isi                                                                                                                                          | Ditulis oleh                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `settings`                  | `{minDelay,maxDelay,dailyLimit,cooldownEvery,cooldownMinutes,autoPost,batchPost}`                                                            | dashboard (settings, controls), background (startPosting) |
| `materials`                 | daftar materi RINGAN `{account,caption,mediaName}` — tanpa blob media (kuota aman); media dimuat ulang dari folder tiap sesi                | dashboard (materials, main), background (scheduler)       |
| `postMatrix`                | `{materialKey: {groupUrl: {ok, mi, gi, at, error}}}` — status ✅/❌ per materi×grup, persisten lintas sesi; dihapus hanya via tombol "Hapus Riwayat Status" | background (markGroup), dashboard (applyResult, btnClearMatrix) |
| `groupResults`              | `{groupUrl: {ok, mi, at, error}}` — badge sesi berjalan; di-reset tiap `startPosting`                                                        | background (markGroup, startPosting), dashboard           |
| `queue` / `cursor`          | indeks materi & posisi berjalan                                                                                                              | background (scheduler)                                    |
| `postTabId`                 | ID tab FB "postTab" yang dipakai ulang antar langkah/antar sesi posting (`null` saat tidak ada); ID basi dibersihkan otomatis                 | background (tabs: rememberPostTab/forgetPostTab)          |
| `postTabManualIds`           | array ID tab mode manual (FIFO, maks `LIMITS.MAX_MANUAL_TABS` = 3) — tab manual TERTUA ditutup saat pool penuh; ID basi dibersihkan otomatis | background (tabs: ensureManualPostTab/restoreManualTabs)  |
| `stats`                     | `{"YYYY-MM-DD": jumlah}` untuk batas harian                                                                                                  | background (scheduler)                                    |
| `status`                    | `{running}` — dipulihkan/dibersihkan oleh `scheduler.getStatus()`, karena kunci ini bisa tertinggal bila sesi berakhir tanpa `stopPosting()` | background (messaging.setRunning, scheduler.getStatus)    |
| `nextPostAt`                | epoch ms (`Date.now`) posting berikutnya — ditulis `scheduleNext`, di-nol-kan `processNextPost` (saat eksekusi) & `stopPosting`/selesai; sumber countdown dashboard "X mnt Y dtk" (tahan restart SW & reload) | background (scheduler) |
| `postingLogs`               | maksimal 500 baris log terakhir; `[]` = Live Log bersih (lihat §8)                                                                                                              | background (messaging.log), dashboard (controls.clearLog)                                |
| `ui`                        | `{showFbTab}`                                                                                                                                | dashboard & background                                    |
| `accountName`               | `{name, checkedAt, auto?}` — nama akun FB yang dipakai sebagai filter materi; `auto:true` = hasil deteksi background, tanpa `auto` = diketik manual (legacy: string langsung) | background (account.detectAccount), dashboard (controls, account) |
| `groups` / `selectedGroups` | data grup (fitur scraping nonaktif)                                                                                                          | dashboard (groups)                                        |
| `sellGroups`                | `{groupUrl: {at, name}}` — label permanen "grup jual-beli" (hanya tombol "Jual sesuatu", tanpa kolom posting); dilewati di `startPosting`, di-uncheck otomatis; dihapus hanya via tombol "Hapus label jual-beli" | background (handleSkipSellGroup), dashboard (applySellGroupMarked, btnClearSell, btnDeleteGroups) |

## 5. Alur Posting (satu materi)

```
dashboard btnStart --START_POSTING--> background.startPosting()
                                         | simpan queue/materials/settings
                                         | keepAwakeOn + setRunning(true)
                                         v
                                   scheduleNext(6-14s) -> chrome.alarms "post-tick"
                                         v
  onAlarm --------------------> processNextPost()
    | (tiap langkah) ensurePostTab(FB_HOME) -> NAV_HOME_TO_COMPOSER(targetGroupUrl)
    |               -> ensurePostTab(groupUrl) -> EXECUTE_POST(autoPost) -> hasil
    |                  [ensurePostTab SKIP reload bila tab sudah di grup target]
    | stats++, cursor++, broadcastQueueInfo()
    | ANTREAN HABIS / LIMIT HARIAN TERCAPAI -> stopPosting(reason) SEKARANG,
    |   TANPA alarm "post-tick" tersisa (cek sebelum hitung jeda/cooldown,
    |   berlaku juga di jalur catch batch gagal)
    | cooldown bila postsSinceCooldown >= cooldownEvery
    v
  scheduleNext(jeda acak / sisa cooldown) -> alarm berikutnya ...
    | cooldown bila postsSinceCooldown >= cooldownEvery
    v
  scheduleNext(jeda acak / sisa cooldown) -> alarm berikutnya ...
    v
  antrean habis atau limit harian tercapai -> stopPosting(reason)
```

Mode autoposting memakai SATU tab FB biasa (unpinned) yang dipakai ulang untuk
semua langkah; mode manual memakai pool tab manual (kontrak lengkap di bawah). Fokus
tab hanya berpindah bila `ui.showFbTab` aktif; setelah tiap posting fokus kembali ke
dashboard. **Kontrak navigasi: `ensurePostTab(url)` DILARANG me-reload tab yang sudah
berada di grup target** — `chrome.tabs.update({url})` pada tab yang sama memicu full
page reload yang menghancurkan composer modal yang baru dibuka `NAV_HOME_TO_COMPOSER`.
Karena itu `ensurePostTab` memakai `sameGroupUrl()` (bandingkan URL kanonis
`/groups/{id}`) dan bila sama hanya melepas pin + fokus tanpa navigasi. Bila ragu
(URL tidak kanonis), pilih aman: tetap navigasi (perilaku lama).
**Kontrak anti tab numpuk: ID postTab dipersist (`STORAGE.POST_TAB_ID`) dan selalu
ditulis lewat `rememberPostTab()`/`forgetPostTab()`** (`src/background/tabs.js`);
worker MV3 yang bangun dari tidur memulihkannya via `restorePostTab()` (dipanggil
scheduler di `startPosting()` dan `processNextPost()`). Bila ID basi (tab ditutup
user), `ensurePostTab` mengadopsi tab facebook.com yang sudah terbuka sebelum membuat
tab baru, dan `create` hanya terjadi bila benar-benar tidak ada tab yang bisa dipakai
— dalam kasus itu tab lama milik sesi ditutup dulu agar tidak menumpuk satu per satu
batch. `stopPosting()` sengaja TIDAK menutup tabnya; ia hanya melupakan ID-nya
(dipakai-ulang kembali sesi berikutnya via guard `sameGroupUrl`).
**Mode manual — pool tab FIFO (batas `LIMITS.MAX_MANUAL_TABS` = 3):** kontrak reuse
di atas hanya berlaku untuk autoposting. Saat checkbox "autoposting" tidak dicentang,
scheduler membaca `run.settings.autoPost` SEBELUM tab batch dibuat lalu memanggil
`ensureManualPostTab(FB_HOME)` (`src/background/tabs.js`): SELALU `chrome.tabs.create()`
tab baru — composer batch sebelumnya dibiarkan utuh, user bebas mengklik Posting kapan
pun. ID-nya dipersist ke `STORAGE.POST_TAB_MANUAL_IDS` (array FIFO); saat pool penuh
(3 tab), tab manual TERTUA milik sesi ditutup otomatis SEBELUM tab baru dibuka — FIFO,
tanpa timing khusus, tanpa deteksi klik user (mustahil: `EXECUTE_POST` mode manual
selalu membalas `ok:true` tanpa verifikasi klik). `NAV_HOME_TO_COMPOSER` dan
`EXECUTE_POST` berjalan di tab manual YANG SAMA (`tab = navTab`) agar composer tidak
dipindah tab; `findExistingFbTab()` mengecualikan ID pool manual sehingga adopsi mode
auto tidak pernah membajak composer manual. Tab manual TIDAK termasuk pool
autoposting, `stopPosting()` tetap tidak menutup tab apa pun (pool tetap terpersist;
batas 3 ditegakkan saat batch manual berikutnya berjalan), dan jendela
`LIMITS.MANUAL_POST_WINDOW_MS` (10 detik) tetap berlaku. Konsekuensi yang disadari:
eviction bisa menutup tab manual yang belum sempat diklik user — harga dari batas 3.
Bila `settings.autoPost` **tidak aktif**, langkah `EXECUTE_POST` menjalankan
workflow yang SAMA PERSIS dengan autoposting (media dulu + caption + tambah
grup), hanya klik Posting akhir yang diserahkan ke user: scheduler MEMAKSA
tab FB tampil & terfokus untuk langkah itu (mengabaikan `ui.showFbTab`),
content script scroll ke tombol Posting (tanpa klik), lalu modal composer
dibiarkan terbuka selama `MANUAL_POST_WINDOW_MS` (10 detik). Tidak ada
konfirmasi klik user — bila semua persiapan lancar, langkah langsung
dianggap BERHASIL (`ok:true`, dihitung 1 posting) tanpa memeriksa apakah
user mengklik atau tidak.

## 6. Tanggung Jawab Modul

| Modul                     | Tanggung jawab                                                                                         | Tidak boleh                |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------- | --- |
| `shared/config.js`        | nilai default, kunci storage, tipe pesan, batas, daftar file content script                            | mengakses `chrome.*` / DOM |
| `shared/random.js`        | `randInt`, `gauss`                                                                                     | —                          |
| `shared/time.js`          | `nowStamp`, `todayKey`, `sleep`                                                                        | —                          |
| `shared/storage.js`       | Promise wrapper storage                                                                                | menyimpan state aplikasi   |
| `shared/spintax.js`       | parser `{a                                                                                             | b}`                        | —   |
| `background/state.js`     | objek `run` + `restoreState()`                                                                         | logika posting             |
| `background/media-store.js` | IndexedDB sesi: persist blob media lintas restart service worker (`putAllMedia`, `hydrateMaterials`) | dipakai di luar background |
| `background/power.js`     | keep-awake                                                                                             | —                          |
| `background/messaging.js` | `log`, `setRunning`, `broadcastQueueInfo`                                                              | navigasi tab               |
| `background/tabs.js`      | tab FB/dashboard, injeksi content script, `sendToContent`                                              | mengubah antrean           |
| `background/account.js`   | deteksi akun login via tab deteksi sementara (`detectAccount`) + simpan `STORAGE.ACCOUNT_NAME`          | akses DOM Facebook, mengubah antrean |
| `background/scheduler.js` | antrean + alarm + `processNextPost` + `getStatus` (pemulihan status basi) + uji `openComposerFromHome` | akses DOM Facebook         |
| `content/selectors.js`    | konstanta selektor                                                                                     | logika                     |
| `content/dom.js`          | penunggu & pencari elemen                                                                              | klik aksi bisnis           |
| `content/stealth.js`      | humanizer input                                                                                        | selektor                   |
| `content/media.js`        | data URL → File → input upload                                                                         | —                          |
| `content/navigation.js`   | alur home → grup                                                                                       | posting                    |
| `content/scraper.js`      | scraper grup                                                                                           | posting                    |
| `content/posting.js`      | `openComposer()` (buka composer) + eksekusi posting (mode autoposting/manual via parameter `autoPost`) | navigasi                   |
| `content/account.js`      | baca NAMA akun login dari DOM (`getAccountName`, `pickAccountName`)                                    | menyentuh `chrome.*`       |
| `dashboard/state.js`      | state UI                                                                                               | DOM                        |
| `dashboard/ui.js`         | `$`, `escapeHtml`, `addLog`, `setStatus`                                                               | data                       |
| `dashboard/materials.js`  | import materi & media                                                                                  | kontrol running            |
| `dashboard/settings.js`   | form pengaturan                                                                                        | antrean                    |
| `dashboard/groups.js`     | tabel & pencarian grup                                                                                 | antrean                    |
| `dashboard/controls.js`   | tombol start/stop, checkbox autoposting, uji buka composer, `syncStatus` awal, tab FB, event realtime, textbox nama akun (ketik manual) | render tabel               |
| `dashboard/account.js`    | deteksi akun otomatis saat dashboard dibuka + tombol ↻ (deteksi ulang)                                 | render tabel, menulis storage langsung |
| `dashboard/main.js`       | init + catch error global                                                                              | logika fitur               |

## 7. Checklist Menambah / Mengubah Modul

1. Buat file di `src/<konteks>/`, bungkus dengan IIFE + `"use strict"` dan
   daftarkan API-nya di `FBAP.<konteks>.<nama>`.
2. Destructure dependensi dari `FBAP.*` **hanya** untuk modul yang dimuat lebih dulu.
3. Daftarkan file di entry yang sesuai:
   - content → `manifest.json` **dan** `FBAP.config.CONTENT_SCRIPT_FILES` (urutan
     identik, file baru ditaruh sebelum `content.js`),
   - background → `importScripts()` di `service-worker.js`,
   - dashboard → `<script src>` di `dashboard.html` (sebelum `main.js`).
4. Gunakan `FBAP.config.STORAGE.*` / `FBAP.config.MSG.*`, jangan string literal.
5. Jalankan `node tools/verify.js` sampai semua check lulus.

## 8. Keputusan Desain Penting

- **ID tab posting dipersist (`STORAGE.POST_TAB_ID`) — bug "tab FB menumpuk satu
  per satu postingan".** Temuan lapangan: `run.postTabId` tadinya hanya in-memory
  DAN di-nol-kan `startPosting()`, sementara alarm `post-tick` menyala tiap 180–300
  detik dan service worker MV3 bisa dimatikan Chrome di antara dua alarm. Worker
  yang bangun lagi membaca ulang `queue/cursor/materials` dari storage tapi TIDAK
  tahu tab FB lama masih terbuka → `ensurePostTab()` selalu jatuh ke
  `chrome.tabs.create()` → tiap batch menyisakan satu tab baru, tab lama dibiarkan
  hidup. Perbaikan tiga lapis di `src/background/tabs.js`:
  (1) satu pintu tulis `rememberPostTab()` (memori + storage, best-effort) /
  `forgetPostTab()` / `restorePostTab()` — dilarang mengubah `run.postTabId`
  langsung di luar helper ini;
  (2) `restorePostTab()` dipanggil scheduler di `startPosting()` dan
  `processNextPost()` (jalur worker bangun dari tidur);
  (3) `ensurePostTab()` berjenjang: pakai-ulang tab tercatat → adopsi tab
  facebook.com yang sudah terbuka (`findExistingFbTab()`, tab dashboard ikut
  ter-query sehingga difilter via `DASH_URL`) → baru `chrome.tabs.create()`,
  dan bila create terjadi sementara tab lama milik sesi masih terdeteksi,
  tab lama ditutup dulu. Tab sengaja TIDAK ditutup di akhir sesi (biaya navigasi
  login/render FB mahal); `stopPosting()` hanya melupakan ID-nya, sesi berikutnya
  memakai ulang via guard `sameGroupUrl` (bila URL kanonis sama, tab tidak
  di-reload — kontrak bagian 5 tetap berlaku).

- **Mode manual = pool tab baru FIFO maks 3 (`STORAGE.POST_TAB_MANUAL_IDS`) —
  bukan new tab tanpa batas, bukan reuse 1 tab.** Alasan: (a) reuse 1 tab
  menghancurkan composer batch sebelumnya setiap batch berikutnya menavigasi
  ulang tab yang sama — user yang lambat kehilangan isinya; (b) new tab tanpa
  batas mengembalikan bug "tab menumpuk" dan membebani RAM/CPU (tiap tab FB =
  renderer + realtime sendiri) sehingga alarm/worker bisa terlambat dan content
  script gagal. Kompromi: tiap batch manual MEMANG membuka tab baru (user punya
  waktu panjang untuk klik Posting), tapi ID-nya masuk pool berpersist berbatas
  `LIMITS.MAX_MANUAL_TABS` = 3 — batch manual keempat menutup tab manual tertua
  lebih dulu (FIFO, tanpa timing khusus). Deteksi "user sudah mengklik" sengaja
  TIDAK dipakai: background mustahil mengetahuinya, jadi eviction hanya
  berbasis jumlah tab. Tab autoposting tidak pernah masuk pool;
  `findExistingFbTab()` mengecualikan pool manual agar adopsi mode auto tidak
  membajak composer manual.

- **Deteksi akun FB = TAB DETEKSI SEMENTARA (`active:false, pinned:true`) yang selalu
  ditutup — bukan reuse `postTab`.** Nama akun yang sedang login dibaca dari DOM
  halaman Facebook oleh `content/account.js` (adaptasi ekstensi rujukan
  `assets/fb-akun-detector`: anchor `aria-label` "Linimasa/Timeline <Nama>" →
  link yang mengarah ke PROFIL SENDIRI → `img[alt^="Foto profil"]` → kontrol
  berlabel; setiap kandidat disaring daftar label generik + batas 60 karakter,
  dan prefix "Linimasa/Foto profil" dipotong), lalu diorkestrasi
  `background/account.js`: `chrome.tabs.create(FB_HOME, active:false, pinned:true)` →
  `waitTabLoaded` → settle → `GET_ACCOUNT_NAME` (fallback `ensureContentScript`
  bila content belum terpasang) → tulis `STORAGE.ACCOUNT_NAME`
  `{name, checkedAt, auto:true}` → `chrome.tabs.remove()` + `focusDashboard()`
  di `finally`. Alasan TIDAK memakai ulang tab posting: (a) deteksi dipicu
  otomatis saat dashboard dibuka sehingga bisa bertabrakan dengan composer mode
  manual yang sedang menunggu klik user atau dengan navigasi batch berjalan;
  (b) umur tab deteksi sangat pendek dan selalu ditutup, jadi tidak ada tab
  menumpuk (kontrak anti-tab-numpuk §5 tetap berlaku untuk posting);
  (c) `active:false` menjaga FOKUS TETAP DI DASHBOARD — user tidak dipindahkan
  dari dashboard saat deteksi berjalan; (d) `pinned:true` menyembunyikan tombol
  tutup tab selama deteksi sehingga user tidak bisa menutupnya tak sengaja
  (tab pinned tetap bisa dihapus via `chrome.tabs.remove`, jadi penutupan
  otomatis di `finally` tidak terpengaruh). Polling DOM dilakukan di CONTENT script
  (`LIMITS.ACCOUNT_DETECT_TRIES` × `ACCOUNT_DETECT_INTERVAL_MS` = 10s) karena
  service worker MV3 tidak boleh menahan timer panjang; guard memori `detecting`
  menolak deteksi dobel (klik ↻ beruntun). Tiga lapis pengisian nama akun:
  OTOMATIS saat dashboard dibuka (`dashboard.account.detectOnStartup()` dari
  `main.js`) → tombol ↻ (`btnRefreshAccount`, deteksi ulang manual) → KETIK
  MANUAL (handler lama di `dashboard/controls.js`, backstop terakhir). Hasil
  deteksi TIDAK PERNAH menimpa ketikan manual yang datang belakangan, dan
  deteksi gagal TIDAK mengosongkan nama lama (filter materi tetap jalan) —
  hanya tick amber + satu baris log peringatan.

- **Blob media wajib persisten di IndexedDB sesi (`background/media-store.js`)
  dan media yang hilang = STOP TOTAL, bukan posting teks diam-diam.**
  Temuan lapangan (bug "media hilang di grup ke-4+"): `chrome.storage.local`
  hanya menyimpan materi VERSI RINGAN tanpa blob (kuota ~5MB), blob hanya hidup
  di memori service worker MV3 — dan worker pasti dimatikan Chrome selama jeda
  antar posting (180–300s). Hasilnya batch ke-4 dan seterusnya terkirim
  `mediaDataUrl: null` lalu di-posting TEKS SAJA tanpa error. Perbaikan tiga
  lapis: (1) `startPosting()` menyimpan semua blob ke IndexedDB
  (`putAllMedia`, satu store dibersihkan per sesi; IndexedDB tersedia di
  service worker MV3, bertahan lintas restart worker DAN browser);
  (2) `processNextPost()` mengisi ulang blob dari IndexedDB setiap langkah
  (`hydrateMaterials`) SEBELUM `EXECUTE_POST` dikirim;
  (3) gate dua sisi — materi yang memakai media tapi blob tidak terbaca
  MENOLAK sesi dimulai (dashboard `btnStart` + `startPosting()`), dan bila
  blob hilang di tengah sesi (store rusak/dibersihkan eksternal) SELURUH SESI
  dihentikan (`stopSession`) — keputusan user: jangan pernah posting teks
  diam-diam. Materi yang memang "Tanpa Media" (tanpa kolom `Media_Name`)
  tetap sah diposting sebagai teks.
- **Grup tanpa kolom posting ("Jual sesuatu") di-SKIP, diberi LABEL permanen,
  dan di-uncheck otomatis.** Temuan lapangan: sebagian grup tidak menyediakan
  trigger "Tulis sesuatu..." / "Write something..." — tombol **"Jual sesuatu" /
  "Sell something"** (alur Marketplace) menggantikannya, sehingga composer
  tidak akan pernah terbuka. Karena itu `openComposer()`
  (`src/content/posting.js`) mengecek marker jual-beli via
  `detectSellOnlyMarker()` (`src/content/dom.js`, keyword `SELL_ONLY_KW`
  ID+EN di `src/content/selectors.js`) DUA KALI: sebelum menunggu trigger
  (hemat ±45 detik tunggu sia-sia per grup) dan sekali lagi setelah window
  trigger habis (anti false-positive pada grup yang lambat render — tanpa
  trigger + ada marker barulah disimpulkan jual-beli). Bila ketemu, lempar
  Error ber-prefix **`SKIP_SELL_GROUP:`** — kontrak content → scheduler.
  Scheduler (`src/background/scheduler.js`) mengenali prefix itu (dua jalur:
  cabang `!res.ok` DAN blok `catch`) lalu memanggil `handleSkipSellGroup()`:
  (1) tandai ❌ dengan alasan jual-beli (BUKAN pesan gagal teknis),
  (2) tulis label permanen ke `STORAGE.SELL_GROUPS`
  (`{groupUrl: {at, name}}`, hanya grup UTAMA batch yang dilabeli; grup
  tambahan cukup ❌ untuk batch itu), (3) **uncheck** URL grup dari
  `STORAGE.SELECTED_GROUPS`, (4) kirim `MSG.SELL_GROUP_MARKED` ke dashboard
  agar baris ter-uncheck realtime + badge 🏷️, lalu lanjut antrean (bukan
  berhenti). Label menang atas centang: `startPosting()` memfilter grup
  berlabel SEBELUM antrean dibangun (hemat navigasi sia-sia) — user yang
  ingin mencoba lagi harus menghapus label via tombol **"Hapus label
  jual-beli"** (atau hapus grupnya). Keyword memakai frasa PENUH
  "jual sesuatu"/"sell something" (bukan "jual" saja) agar tidak
  false-positive pada teks "Jual" di nama grup/feed Marketplace.
- **findPostButton() TIDAK BOLEH mengklik toggle "Posting sebagai anonim".**
  Temuan lapangan: `POST_BUTTON_SELECTORS` (`aria-label*="Posting"/"Post"`)
  juga mencocokkan switch **"Posting sebagai anonim" / "Post anonymously"**
  di composer, dan toggle itu muncul lebih dulu di urutan DOM sehingga mode
  autoposting pernah menyalakannya alih-alih men-submit. Karena itu
  `findPostButton()` (`src/content/dom.js`) WAJIB memakai filter 4 lapis:
  (1) scope utama = dialog composer dari `findComposerDialog()`
  (document hanya fallback ber-skor lebih rendah), (2) tolak kandidat yang
  labelnya mengandung `POST_BUTTON_POISON_RE` (`anonim|anonymous|sebagai|
  switch|toggle|jadwal|schedule|draft`), (3) tolak label > 40 karakter
  (label gabungan, bukan tombol submit), (4) tolak `aria-disabled="true"`;
  lalu pilih skor tertinggi (aria-label eksak & pendek menang). Label poison
  hidup di `src/content/selectors.js` — jangan hardcode di dom.js.
- **URL grup selalu dikanonikalkan ke `/groups/{id}` setelah klik sidebar
  (SPA-safe).** Temuan lapangan: anchor di halaman `/groups` bisa href-nya
  `/groups/{id}/posts/...` atau `/groups/{id}/user/...` (permalink postingan
  sendiri / profil member) namun lolos filter `isGroupLink()` karena
  `normalizeUrl()` memangkas ekor path sebelum perbandingan. Membuka permalink
  membuat FB langsung fokus ke kolom komentar, lalu trigger composer
  "Tulis sesuatu..." tidak ditemukan. Karena itu `navHomeToGroup()`
  (`src/content/navigation.js`) selalu memanggil `ensureCanonicalUrl()`:
  bila `location.pathname` masih punya ekor, cari anchor yang href-nya PERSIS
  `/groups/{id}` dan klik itu (navigasi SPA, content script tetap hidup sehingga
  `sendResponse` terkirim); full reload `location.href` hanya fallback terakhir.
  Handler `NAV_HOME_TO_COMPOSER` (`src/content/content.js`) memanggil ulang
  helper yang sama sebagai jaring pengaman sebelum `openComposer()`.
  STEALTH-FIRST: kanonisasi TIDAK memakai `location.href`/reload paksa —
  satu-satunya cara keluar dari URL racun adalah KLIK ANCHOR KANONIS yang
  ada di halaman (href persis `/groups/{id}`, tanpa query). `isGroupLink()`
  menolak anchor yang raw href-nya mengandung marker notifikasi/permalink
  (`multi_permalinks`, `comment_id`, `notif_id`, `notif_t`, `story_fbid`,
  `permalink`, `ref=notif`) SEJAK AWAL supaya klik pertama sudah bersih.
  Bila anchor kanonis tidak ketemu / klik 3x tetap tidak membersihkan URL,
  `ensureCanonicalUrl()` melempar Error eksplisit → scheduler menandai grup
  itu ❌ dan lanjut antrean (bukan dipaksa lolos; user bisa retry manual).
- **Workflow posting = SATU inti bersama: media DULU, baru caption (GATE blob),
  dengan saklar mode "autoposting".** Temuan lapangan: attach media
  me-`re-render` composer Lexical sehingga caption yang diketik SEBELUM media
  ikut terhapus. `composeMediaAndCaption()` (`src/content/posting.js`) karena itu
  memaksa urutan `openComposer() → uploadMedia() → GATE preview blob
(`video[blob] readyState>=2`/`img[blob]`baru muncul) → query editor ulang
(scope preview media dulu, lalu dialog SEGAR dari`findComposerDialog()`,
lalu document) → `typeCaption()`.

  Jangkar editor BUKAN `aria-placeholder` semata: placeholder berubah/hilang
  setelah media dilampirkan, dan referensi dialog lama bisa STALE karena
  composer di-re-render. Karena itu `CAPTION_EDITOR_LEXICAL`
  (`div[contenteditable][role=textbox][data-lexical-editor]`) menjadi
  fallback jangkar stabil, `findComposerDialog()` mencari dialog dari ISI
  (editor ketat ATAU Lexical di dalamnya), dan editor hasil wajib visible
  (`isEditableVisible`) supaya `typeCaption()` tidak mengetik ke node
  detached.

  Editor WAJIB berada di dalam dialog composer (`isInComposerDialog`).
  Editor komentar di feed juga `contenteditable` + `data-lexical-editor`,
  dan dialog pop-up KOMENTAR (editor `aria-placeholder`/`aria-label`
  "Balas sebagai…" / "Reply as…") juga visible + berisi editor — sehingga
  `isCommentEditor()` menolak editor semacam itu SEBELUM cek dialog, dan
  `findComposerDialog()` hanya menerima dialog yang punya editor composer
  non-komentar. Pencarian document-wide dilarang — `findEditor()` dan
  pencarian editor pasca-media hanya menerima editor yang
  `closest('div[role="dialog"]')`-nya visible dan lolos
  `dialogHasComposerEditor`. Tidak ada fallback document-wide: bila tidak
  ketemu, langkah GAGAL (jangan pernah mengetik ke kolom komentar).
  Setelah itu `postToGroup(caption, media…, autoPost)` bercabang:
  - `autoPost === true` (checkbox **autoposting** dicentang, default): klik
    tombol Posting + **verifikasi pasca-submit** (composer & preview media harus
    hilang; bila tidak, klik diulang sekali lalu throw agar scheduler mencatat
    GAGAL, antrean tidak maju palsu).
  - `autoPost === false`: workflow SAMA dengan cabang `true` (media dulu +
    caption + tambah grup — tambah grup hanya saat "Posting Batch" aktif),
    hanya klik akhir yang manual: scheduler memaksa
    tab FB fokus, content script scroll ke tombol Posting TANPA klik, modal
    composer dibiarkan terbuka selama `LIMITS.MANUAL_POST_WINDOW_MS`
    (10 detik), lalu `return true` **tanpa konfirmasi** klik user — bila
    semua persiapan lancar hasilnya langsung dianggap BERHASIL (1 posting
    sukses oleh scheduler: cursor maju, statistik harian +1, loop tidak
    macet). Scroll ke tombol gagal TIDAK menggagalkan langkah.
    Selektor hanya `role`/`aria-label`/`aria-placeholder` (tanpa class `x…` FB);
    dialog composer asli dicari dari ISI (editor di dalamnya), bukan dari
    `aria-label` — dialog berlabel "Buat postingan" hanya kotak judul kosong.
    Ketik per-baris memakai `execCommand("insertText")` + fallback paste,
    verifikasi pertumbuhan teks ASYNC, dan anti-dobel (bersihkan & ketik ulang
    sekali bila teks terduplikasi). Keputusan (temuan lapangan): `normText`
    HARUS strip karakter tak terlihat Lexical (`\u200B \u200C \u200D \uFEFF
    \u00A0`) — tanpa itu editor yang tampak kosong terbaca "berisi" dan guard
    anti-dobel terpicu palsu; editor dianggap KOSONG bila textContent-nya
    kosong ATAU identik dengan atribut `aria-placeholder` node itu — FB
    me-render salam dinamis ("Assalamualaikum 👋Semoga sehat selalu…") sebagai
    textContent di dalam node Lexical; ia tak terhapus via select-all+delete
    (FB me-render ulang), jadi menghapusnya = false-positive; `clearEditor()`
    memakai FALLBACK CHAIN metode
    hapus (delete -> insertText timpa -> cut -> hard-reset innerHTML +
    event input bubbles), tiap metode diverifikasi kosong via polling +
    re-query node fresh (commit Lexical ASINKRON; retry metode yang sama
    terbukti tidak mempan — isi editor yang benar-benar menolak terhapus
    harus dicoba lewat jalur berbeda); keputusan "perlu ketik ulang"
    (baik di typeCaption maupun re-verify pasca-picker) hanya boleh diambil
    SETELAH jendela sinkronisasi (polling s.d. 2–3s) memastikan isi editor
    memang stabil berbeda dari target. `uploadMedia()` punya fallback jalur lama
    `attachMedia()` bila konversi `fetch(dataURL)` gagal. Timeout `EXECUTE_POST`
    150s (upload + GATE 20s + caption + submit/manual-window untuk materi besar).
    Dijaga check `checkAutoPostWiring()` di `tools/verify.js` (urutan
    `uploadMedia` < `typeCaption`, cabang manual sebelum `findPostButton`, satu
    inti bersama, verifikasi pasca-submit pada mode autoposting).

- **Tombol "Uji Post" & pesan `TEST_POST`/`EXECUTE_TEST_POST` dihapus.** Perannya
  digantikan checkbox "autoposting": mode manual (`autoPost:false`) persis
  melakukan apa yang dulu dilakukan tombol uji (media+caption terisi, tanpa
  submit) tetapi kini menjadi bagian alur produksi, bukan jalur uji terpisah —
  sehingga tidak ada dua jalur media-dulu yang harus dijaga sinkron.
- **Nilai `autoPost` per sesi.** Dibaca sekali di `startPosting()` dari
  `payload.settings.autoPost` (checkbox dikirim saat **Mulai Posting**), lalu
  dipakai setiap langkah `processNextPost()`. Toggle checkbox saat sesi berjalan
  hanya tersimpan di storage untuk sesi berikutnya — perilaku per-sesi ini
  disengaja agar antrean tetap prediktabel.

- **Dua varian penulis storage.** `storage.set()` tidak pernah reject (dipakai alur
  kritis posting, sesuai perilaku lama background) sedangkan `storage.setStrict()`
  reject saat `chrome.runtime.lastError` (perilaku lama dashboard yang memang
  memasang `.catch()`/`try-catch`). Perbedaan ini dipertahankan agar tidak ada
  perubahan perilaku error.
- **Guard `content.routerReady`.** Content script bisa tersuntik dua kali (manifest
  - fallback `executeScript`). Guard ini mencegah listener `onMessage` ganda, yang
    akan membuat `sendResponse` dipanggil berulang.
- **Antrean dipersist sebelum alarm pertama** (`queue`, `cursor`, `materials`,
  `settings`) karena service worker MV3 dapat dimatikan dan dihidupkan ulang oleh
  alarm.
- **Status lintas sesi = matriks `postMatrix`, bukan `groupResults`.**
  `groupResults` adalah badge sesi berjalan (di-reset tiap `startPosting`);
  status yang harus bertahan walau ekstensi/browser ditutup disimpan di
  `postMatrix` dengan kunci `materialKey` (fingerprint `account|caption|mediaName`
  dari `shared/materialkey.js`). Caption sama → kunci sama → ✅/❌ lama tetap
  tercocokkan walau user import ulang Excel yang sama dengan urutan berbeda.
  Posting ulang materi yang sama BOLEH menimpa sel lama; matriks hanya
  dikosongkan lewat tombol **Hapus Riwayat Status** dashboard.
- **Blob media TIDAK dipersist.** `materials` di storage hanya menyimpan
  `account/caption/mediaName` (ringan) agar tidak meledakkan kuota
  `chrome.storage.local` (~5MB). `mediaDataUrl/mediaMime/available` hanya
  in-memory: dashboard memuat ulang folder media tiap sesi, dan
  `processNextPost` me-merge blob dari `run.materials` in-memory (urutan sama
  dalam satu sesi) agar media tetap terkirim setelah service worker tidur.
- **Fallback in-memory di `processNextPost`.** Bila storage kosong (alarm menyala
  sebelum persist), state in-memory dipakai agar antrean tidak "selesai" palsu.
- **Status sesi = memori + alarm, bukan kunci storage.** `run.running` hilang
  setiap kali service worker MV3 mati, sedangkan kunci `status` bisa tetap
  `{running:true}` bila sesi berakhir tanpa `stopPosting()` (browser/ekstensi
  ditutup saat posting berjalan). Karena dashboard memakai kunci itu untuk
  mengunci tombol **Mulai Posting**, `scheduler.getStatus()` selalu
  membandingkannya dengan alarm `post-tick` yang benar-benar terjadwal:
  alarm ada → sesi lama dipulihkan (`run.running = true`), alarm tidak ada →
  kunci `status`/`queue`/`cursor` dibersihkan supaya tombol tidak terkunci.
  `processNextPost` juga memulihkan `run.running` dari storage agar sesi panjang
  tidak berhenti diam-diam saat worker dihidupkan ulang oleh alarm.
- **Kode mati dibuang, bukan disimpan "untuk nanti".** `EDITOR_SELECTOR`,
  `randFloat`, `spin`, `storageRemove`, dan variabel `txt` dihapus setelah
  diverifikasi tidak pernah dipakai; `tools/verify.js` mencegah kode mati baru
  masuk kembali.
- **Pencarian grup = urutan dokumen, bukan ancestor heading.** Ukuran DOM
  nyata (DevTools, `/groups/feed/`) menunjukkan daftar grup berada di cabang
  sibling heading — penelusuran ke atas 6 hop hanya berisi 0–1 anchor
  ("Buat Grup Baru"). `findTopJoinedGroup()` (navigation.js) karenanya memakai
  `compareDocumentPosition` (`DOCUMENT_POSITION_FOLLOWING`) untuk memilih link
  grup valid pertama SETELAH heading "Grup yang Anda bergabung…", dengan
  fallback berlapis: penelusuran ancestor (layout lama) → link grup valid
  pertama di seluruh sidebar. Harness `tools/verify.js` meniru struktur ini
  (cabang ancestor heading sengaja kosong) agar check hanya bisa lulus lewat
  strategi urutan dokumen.
- **Pencarian grup TARGET (`findGroupByUrl`) wajib memicu lazy-render
  sidebar.** Sidebar `/groups/feed/` di-render grid dua kolom dengan
  lazy-render + collapsible "Lihat selengkapnya" — scroll kecil `+500px`
  pada `[data-visualcompletion]` sering bukan scroller sebenarnya sehingga
  grup target tidak pernah termuat (loop ke-2+ gagal menemukannya).
  `findGroupByUrl()` memakai `scraper.findSidebar()` (auto-detect container
  scroll: overflowY + scrollHeight > clientHeight + memuat anchor /groups/),
  meng-expand collapsible "Lihat selengkapnya", lalu scroll langkah signifikan
  `scraper.scrollStep()` (75% clientHeight + event scroll sintetis) hingga
  ketemu / mentok bawah (berhenti setelah 3 pass tanpa gerak). Pencarian
  anchor dilakukan document-wide karena lazy-render bisa menempatkan anchor
  di luar sub-tree sidebar yang lama.

- **Countdown jeda = derivasi `nextPostAt`, bukan alarm kedua.** `scheduleNext`
  menulis epoch ms posting berikutnya ke `run.nextAt` + `STORAGE.NEXT_POST_AT`
  dan menyiarkannya via `QUEUE_INFO.nextAt`; `processNextPost` me-nol-kannya
  saat eksekusi dimulai dan `scheduleNext` menulis lagi di akhir langkah;
  `stopPosting`/selesai me-nol-kannya. Dashboard hanya `setInterval` 1 detik
  me-render "X mnt Y dtk" (`controls.formatCountdown`), pulih via `GET_STATUS`
  + `storage.onChanged(NEXT_POST_AT)` — tanpa tick dari background agar SW
  tetap bisa tidur di antara posting.
- **Batch 1+9 grup per submit (picker "Tambahkan grup") — OPSIONAL via
  checkbox "Posting Batch" (`settings.batchPost`, default AKTIF).**
  Antrean dibangun per batch `{mi, gi, extras}`:
  - batchPost aktif: grup pertama batch = grup utama yang dinavigasi
    natural, sisanya (maks `LIMITS.EXTRA_GROUPS_PER_POST = 9`) dicentang
    via picker "Tambahkan grup" composer (fitur bawaan FB).
  - batchPost NONAKTIF: setiap grup jadi batch sendiri dengan `extras: []`
    — posting 1 grup 1 submit, picker TIDAK PERNAH dibuka. Motivasi:
    satu kegagalan picker sebelumnya menghanguskan s.d. 10 grup sekaligus;
    mode satuan membatasi blast radius ke 1 grup per kegagalan (eksekusi
    lebih lama, jeda antar-grup tetap `minDelay..maxDelay`).
  Search-FIRST di picker (temuan lapangan: enumerasi baris gagal karena
  checkbox picker tidak selalu punya role='checkbox', dan set-value
  sekaligus tidak memicu filter React). DETEKSI PICKER (temuan lapangan
  #2): judul "Tambahkan grup" di header picker adalah TEKS biasa, bukan
  div[role="button"], sehingga pencarian judul via tombol klikabel selalu
  gagal (popup terlihat di layar tapi tetap timeout) — findGroupPicker()
  kini mengecek judul via teks heading pendek (pickerHasTitleText()) ATAU
  keberadaan kolom "Cari grup" (findPickerSearch()), dan mengecualikan
  composer utama via dialogHasComposerEditor() (picker tidak punya editor
  caption) selain identitas referensi. listPickerRows() punya fallback:
  bila tidak ada kandidat checkbox sama sekali, baris dibangun dari logo
  img (klik nama/logo/baris sama sah mencentang). VERIFIKASI CENTANG (temuan lapangan #3): checkbox picker FB adalah <input type=checkbox> yang state-nya ada di ATRIBUT aria-checked, bukan properti .checked DOM — isRowChecked()/countCheckedRows() wajib cek keduanya (verifikasi hanya-.checked selalu baca false walau klik berhasil). DIALOG TERTUTUP (temuan lapangan #4): FB menutup dialog dengan fade visibility:hidden/opacity:0 — dialog tetap berdimensi sehingga isElementVisible tetap true; deteksi buka/tutup picker memakai dialogIsOpen() (computed style: display/visibility/opacity). TOMBOL PEMBUKA PICKER (temuan lapangan #5): composer memuat banyak teks mengandung kata "grup" ("Posting hingga ke 9 grup...", panel "Tambahkan ke postingan Anda") sehingga ambil-kandidat-pertama sering mengklik tombol SALAH dan picker tidak pernah terbuka. findAddGroupsButton() kini memberi SKOR presisi per kandidat (aria-label > teks persis > prefix > contains), menolak kandidat beracun (ADD_GROUPS_POISON_RE), dan memilih skor tertinggi. Kliknya memakai rangkaian event React-realistis (clickButtonRealistic(): pointerover/pointerdown/mousedown/focus/mouseup/click dengan koordinat), lalu DIVERIFIKASI kemunculan picker dan diulang maks 3x sebelum menyerah. Jalur utama:
  pickOneGroupBySearch() mengetik nama target KARAKTER-PER-KARAKTER di
  kolom 'Cari grup' (typePickerSearch(): execCommand insertText + event
  keydown/input/keyup, verifikasi search.value penuh, coba 2x), tunggu
  hasil menyempit (PICKER_SEARCH_TIMEOUT_MS), cocokkan baris (matchScore),
  klik fleksibel (clickRowFlexible), verifikasi aria-checked, kosongkan
  search (clearPickerSearch). PENCOCOKAN NAMA DUA TAHAP (temuan lapangan
  #7): nama di Manajemen Data Grup disimpan APA ADANYA (case asli FB,
  hanya trim+rapikan spasi), jadi tahap 1 = EXACT case-sensitive
  (normExactText: trim+spasi tunggal TANPA lowercase; nama storage ===
  nama baris picker), tahap 2 = FUZZY matchScore (persis-lowercase >
  contains dua arah > semua kata kunci) hanya untuk target yang belum
  ketemu. FALLBACK LAMA DIHAPUS: dulu baris kosong mana pun dicentang
  agar jumlah tercentang = target — itu menyebabkan grup SALAH
  tercentang (baris teratas picker) padahal nama tidak cocok; kini yang
  tidak ketemu di kedua tahap = failed -> ❌ di tabel dashboard, batch
  tetap lanjut. Background menerima addedNames dan menuliskan NAMA grup
  yang benar-benar tercentang di Live Log (bukan hanya jumlah; entri
  fuzzy ditandai akhiran "(fuzzy)"). FALLBACK bila kolom search tidak
  ditemukan: pickGroupsByRows() enumerasi baris + scroll lazy-render
  (dua pass exact→fuzzy, tanpa isi baris sembarang),
   PORTAL-SAFE (temuan lapangan #6, adopsi tambahGrupFB): FB me-render
   daftar grup picker via React PORTAL di luar subtree dialog — query ketat
   di dalam dialog menghasilkan 0 item. Saat listPickerRows() tidak
   menemukan baris di dalam picker, enumerasi beralih ke checkbox grup
   DOCUMENT-WIDE dengan filter 4 lapis (isGroupCheckbox): buang
   role="switch", buang disabled, WAJIB wrapper [role="button"] memuat
   foto (svg/image/img), buang wrapper berteks "anonim/anonymous" — supaya
   toggle "Posting secara anonim" tidak pernah tersentuh. Klik baris
   memakai WRAPPER [role="button"] dulu (klik langsung ke <input> sering
   tidak memicu state React FB), dengan jeda ritme manusia 70/30
   (600-1400 ms vs 1400-2600 ms) antar checklist dan jeda 1500-3500 ms
   sebelum menutup picker. findPickerDone() punya fallback document-wide
   [role="button"] dengan aria-label/teks persis "Selesai/Done" — tombol
   bisa ikut di-render di luar dialog.
  diagnostik Live Log. Alur
  `postToGroup()`:
  media → caption → `addExtraGroups()` (selalu otomatis, juga di mode
  manual) → verifikasi caption utuh (picker bisa re-render Lexical) → submit.
  Timeout `EXECUTE_POST` = `LIMITS.EXECUTE_POST_TIMEOUT_MS` (240s) karena
  9x (search + centang) di picker. Pencocokan grup di picker pakai
  search + nama (case-insensitive, normalized) + fallback baris-apa-saja;
  hanya gagal (masuk `failed`) bila baris di picker benar-benar habis
  (mentok scroll) sebelum semua slot terisi — scheduler menandai ❌ per URL
  via `markGroup()` (utama + tiap tambahan), sehingga tabel dashboard update
  per baris. Statistik harian +1 per submit (per batch), bukan per grup.
  Timeout picker: `ADD_GROUPS_TIMEOUT_MS` / `GROUP_SEARCH_TIMEOUT_MS`; tutup
  picker = tombol "Selesai" dengan fallback panah mundur lalu tombol Escape; setiap percobaan tutup WAJIB re-query picker fresh (findGroupPicker()) karena referensi picker bisa stale (search/centang me-re-render dialog FB).

- **Live Log dashboard = proyeksi `postingLogs` di storage, bukan state DOM.**
  Temuan lapangan (bug "Bersihkan Log / auto-clear saat Mulai Posting tampak
  tidak berefek"): tombol **Bersihkan Log** dan clear di **Mulai Posting**
  dahulu hanya menulis `$("terminal").innerHTML = ""`, sementara
  `chrome.storage.onChanged` di `dashboard/controls.js` me-render ulang SELURUH
  isi `postingLogs` begitu background `messaging.log()` menulis log baru (saat
  idle, `!State.running`) — log lama pun muncul kembali. Aturan: setiap
  permintaan bersihkan Live Log WAJIB lewat satu pintu `controls.clearLog()`
  yang mengosongkan DOM **dan** `STORAGE.POSTING_LOGS` dalam satu operasi;
  listener `onChanged` mengabaikan `newValue` kosong (`if (logs.length &&
  !State.running)`) supaya baris yang baru ditulis setelah clear (misalnya pesan
  validasi saat Mulai Posting ditolak) tidak ikut terhapus. Konsekuensinya
  kunci `postingLogs` kini ditulis dua konteks: background (`messaging.log`)
  dan dashboard (`clearLog`) — kontrak kolomnya di §4.

## 9. Verifikasi Otomatis

`node tools/verify.js` menjalankan pemeriksaan: sintaks, kode mati,
id DOM dashboard ↔ HTML, sinkronisasi manifest, urutan `<script>`, konstanta
pesan, wiring checkbox **autoposting** dan **Posting Batch** (HTML →
`controls.js` → `payload.settings`
→ scheduler → `EXECUTE_POST.autoPost`/`extraGroups` → `postToGroup()`: cabang manual menunggu
`LIMITS.MANUAL_POST_WINDOW_MS` sebelum `findPostButton`, jadi mode manual tidak
mungkin men-submit; `batchPost` nonaktif membuat antrean satuan `extras: []`
sehingga picker "Tambahkan grup" tidak pernah dibuka), paritas nama fungsi & literal tipe pesan terhadap snapshot
`backups/pre-refactor/`, smoke test pemuatan modul (vm + stub `chrome` dan
`document`) untuk ketiga konteks, pemulihan status basi (`GET_STATUS`
mereset sesi yang sudah mati sehingga tombol **Mulai Posting** tetap bisa diklik),
serta uji rantai navigasi `home → grup → composer` di atas DOM Facebook tiruan
(urutan klik natural, grup pertama sidebar, dan editor composer terdeteksi). `checkLogDebugTools()` mengunci kontrak Live Log: tombol Salin Log memakai clipboard API, seluruh jalur clear (tombol **Bersihkan Log** + auto-clear **Mulai Posting**) wajib lewat `clearLog()` yang mengosongkan `#terminal` **dan** `postingLogs`, sementara listener `onChanged` melewati `newValue` kosong. `checkAccountDetectWiring()` mengunci kontrak deteksi akun: MSG + `LIMITS` deteksi terdaftar, `content/account.js` dimuat tepat sebelum `content.js` (manifest == `CONTENT_SCRIPT_FILES`), tab deteksi dibuka `active:false` lalu ditutup + `focusDashboard()`, guard anti-dobel, urutan pemuatan dashboard (`controls.js` → `account.js` → `main.js`), textbox nama akun tetap bisa diketik manual, serta perilaku `pickAccountName()`/`getAccountName()` di DOM Facebook tiruan (prioritas timeline → avatar → kontrol berlabel, filter label generik & teks > 60 karakter).

## 10. 🛡️ FACEBOOK DOM AUTOMATION & ROBUSTNESS GUIDELINES

1. DILARANG MENGGUNAKAN CLASS NAME DINAMIS

Dilarang menggunakan CSS class bawaan Facebook (seperti .x1n2onr6, .x1ja2u2z) karena di-generate oleh kompilator StyleX/Atomic CSS Meta dan berubah acak pada setiap update deployment. Gunakan urutan prioritas: (1) Atribut Aksesibilitas (role, aria-label), (2) Text-content matching (pencarian teks di layar), (3) Computed Styles (scrollHeight > clientHeight & overflowY).

2. STRATEGI SELECTOR BERLAPIS (FALLBACK CHAIN)

Setiap pencarian elemen UI Facebook HARUS menggunakan pola fallback chain (memeriksa array berisi beberapa opsi selektor secara berurutan). Jangan menggantungkan alur pada satu selektor tunggal.

3. PENCARIAN ELEMEN BERBASIS TEKS & DOM EVENT BUBBLING

Pencarian elemen berbasis teks wajib case-insensitive, di-trim, dan HARUS mendukung variasi multi-bahasa minimal Bahasa Indonesia & Bahasa Inggris (contoh: "Post" / "Kirim", "Write something..." / "Tulis sesuatu...").

Aturan Khusus Event Klik (Targeting Parent Button): Dilarang melakukan .click() langsung pada elemen span / p / div paling dalam (leaf-node). Wajib memanjat pohon DOM menggunakan .closest('div[role="button"]') atau .closest('div[tabindex="0"]') untuk memastikan event klik diterima oleh elemen induk yang menangani event listener Facebook.

4. MANIPULASI STATE REACT & DRAFTJS/LEXICAL

Facebook menggunakan React Virtual DOM; mengedit input.value atau element.innerText secara langsung tidak akan memperbarui State internal React.

Teks Editor: Wajib gunakan document.execCommand('insertText', false, text) setelah elemen di-focus.

Input / File / Scroll: Wajib menembakkan event sintetis yang bubbles: element.dispatchEvent(new Event('change', { bubbles: true })) atau new Event('scroll', { bubbles: true }).

5. ASYNCHRONOUS WAITING (MANDATORY MUTATIONOBSERVER)

Dilarang menggantungkan alur utama pada setTimeout berdurasi panjang. Wajib menggunakan MutationObserver atau polling berbasis Promise untuk menunggu hingga elemen siap/muncul di DOM dengan batas timeout yang jelas.

6. AUTO-DETECT SCROLL CONTAINER

Dilarang melakukan scroll pada window atau elemen statis. Container scroll harus dicari secara dinamis berdasarkan sifat layarnya: overflowY === 'auto' || 'scroll' dan scrollHeight > clientHeight. Manfaatkan getBoundingClientRect() untuk membedakan antara sidebar kiri, feed tengah, atau modal.

7. PISAHKAN LOGIKA SELECTOR DARI LOGIKA BISNIS

Seluruh fungsi pencari elemen Facebook HARUS terpusat di modul/file selektor tersendiri (misal: utils/fb-selectors.js). File logika bisnis (seperti content-script.js) hanya boleh memanggil fungsi pembungkus (wrapper functions).
