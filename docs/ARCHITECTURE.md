# Arsitektur — FB Auto Poster

Dokumen ini menjelaskan pembagian lapisan, kontrak antar modul, dan alasan
keputusan desain. Setiap perubahan struktur wajib menjaga aturan di sini dan
tetap lulus `node tools/verify.js`.

## 1. Tiga Konteks Runtime

| Konteks | Entry | Cara memuat | Boleh mengakses |
|---|---|---|---|
| Background (service worker) | `src/background/service-worker.js` | `manifest.background.service_worker` + `importScripts()` | seluruh `chrome.*` |
| Content script (tab Facebook) | `src/content/content.js` | `manifest.content_scripts[0].js` (daftar urut) atau fallback `chrome.scripting.executeScript` | DOM halaman + `chrome.runtime` |
| Dashboard (tab ekstensi) | `src/dashboard/main.js` | `<script src>` di `dashboard.html` | DOM dashboard + `chrome.*` |

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
             → state → power → messaging → tabs → scan → scheduler   (via importScripts)

Content    : shared/config → shared/random → shared/time → shared/spintax
             → selectors → dom → stealth → media → navigation → scraper
             → posting → content                (urutan sama di manifest.json)

Dashboard  : shared/config → shared/time → shared/storage
             → state → ui → materials → settings → groups → controls → main
```

`shared/random.js` dan `shared/spintax.js` sengaja tidak dimuat di dashboard
karena tidak dipakai di sana (menghindari kode mati).

Dua tempat yang harus selalu sinkron: `manifest.json → content_scripts[0].js`
dan `FBAP.config.CONTENT_SCRIPT_FILES`. Bila berbeda, fallback injeksi akan
memuat modul dengan urutan salah → dijaga oleh `tools/verify.js`.

## 3. Protokol Pesan (`FBAP.config.MSG`)

| Tipe | Arah | Payload | Efek |
|---|---|---|---|
| `PING` | background → content | – | Cek content script terpasang (`{ok:true,pong:true}`) |
| `NAV_HOME_TO_GROUP` | background → content | – | Navigasi natural, balas `{groupUrl, groupName}` |
| `NAV_HOME_TO_COMPOSER` | background → content | – | Navigasi natural + buka composer, balas `{groupUrl, groupName, url}` |
| `EXECUTE_POST` | background → content | `caption, mediaDataUrl, mediaMime, mediaName` | `postToGroup()`: inti media-dulu+caption → klik Posting → verifikasi composer tertutup, balas `{ok, error}` |
| `TEST_POST` | dashboard → background | – | Uji workflow penuh: navigasi + materi pertama ber-media + `EXECUTE_TEST_POST`, balas `{ok, dialog, editorText, error?}` |
| `EXECUTE_TEST_POST` | background → content | `caption, mediaDataUrl, mediaMime, mediaName` | `testCompose()`: uploadMedia DULU (GATE preview blob) → query editor ulang → `typeCaption()` anti-dobel → STOP tanpa klik Posting, balas `{ok, dialog, editorText}` |
| `EXECUTE_SCRAPE` | background → content | – | Scraper daftar grup mode lama (scroll window) |
| `START_SCAN` | dashboard → background | – | Mulai scan sidebar /groups/feed/ pada tab sementara. Guard `scanStatus` anti-dobel; balas `{ok, accepted}` tanpa menunggu hasil — hasil dibaca dashboard via `storage.onChanged` pada kunci `scanStatus`/`groups`. Orkestrasi di `background/scan.js` |
| `SCAN_GROUPS` | background → content | – | `scanGroups()`: loop scroll sidebar (maks 80 pass) + kumpulkan `a[href*="/groups/"]`, balas `{ok, sourceUrl, scannedAt, groups}` |
| `START_POSTING` | dashboard → background | `{materials, settings}` | Bangun antrean + mulai alarm |
| `STOP_POSTING` | dashboard → background | – | Hentikan antrean & lepas keep-awake |
| `GET_STATUS` | dashboard → background | – | `{ok, running, recovered?}` — status dihitung dari memori + alarm; status basi dibersihkan |
| `SET_VIEW` | dashboard → background | `showFbTab` | Set mode tampilan tab FB |
| `VIEW_FB_TAB` | dashboard → background | – | Fokus/buka tab FB |
| `OPEN_COMPOSER` | dashboard → background | – | Uji jalur navigasi home → grup → composer (tab FB difokuskan selama proses, lalu fokus balik ke dashboard) |
| `BACK_TO_DASHBOARD` | dashboard → background | – | Fokus balik ke tab dashboard |
| `LOG` / `STATE` / `QUEUE_INFO` | background → dashboard | teks log / running / sisa antrean | Update UI realtime |

Nilai setiap konstanta sengaja identik dengan namanya agar mudah dilacak di
DevTools. `tools/verify.js` memastikan tidak ada konstanta yang menganggur dan
tidak ada tipe pesan lama yang hilang.

## 4. Kunci `chrome.storage.local` (`FBAP.config.STORAGE`)

| Kunci | Isi | Ditulis oleh |
|---|---|---|
| `settings` | `{minDelay,maxDelay,dailyLimit,cooldownEvery,cooldownMinutes}` | dashboard (settings), background (startPosting) |
| `materials` | daftar materi `{caption,mediaName,available,mediaDataUrl,mediaMime}` | dashboard, background |
| `queue` / `cursor` | indeks materi & posisi berjalan | background (scheduler) |
| `stats` | `{"YYYY-MM-DD": jumlah}` untuk batas harian | background (scheduler) |
| `status` | `{running}` — dipulihkan/dibersihkan oleh `scheduler.getStatus()`, karena kunci ini bisa tertinggal bila sesi berakhir tanpa `stopPosting()` | background (messaging.setRunning, scheduler.getStatus) |
| `postingLogs` | maksimal 500 baris log terakhir | background (messaging.log) |
| `ui` | `{showFbTab}` | dashboard & background |
| `groups` / `selectedGroups` | data grup (fitur scraping nonaktif) | dashboard (groups) |

## 5. Alur Posting (satu materi)

```
dashboard btnStart --START_POSTING--> background.startPosting()
                                         | simpan queue/materials/settings
                                         | keepAwakeOn + setRunning(true)
                                         v
                                   scheduleNext(6-14s) -> chrome.alarms "post-tick"
                                         v
  onAlarm --------------------> processNextPost()
    | (sekali) ensurePostTab(FB_HOME) -> NAV_HOME_TO_GROUP -> run.groupUrl
    | (tiap materi) ensurePostTab(groupUrl) -> EXECUTE_POST -> hasil
    | stats++, cursor++, broadcastQueueInfo()
    | cooldown bila postsSinceCooldown >= cooldownEvery
    v
  scheduleNext(jeda acak / sisa cooldown) -> alarm berikutnya ...
    v
  antrean habis atau limit harian tercapai -> stopPosting(reason)
```

Semua langkah browser memakai satu tab FB biasa (unpinned) yang dipakai ulang. Fokus tab
hanya berpindah bila `ui.showFbTab` aktif; setelah tiap posting fokus kembali ke
dashboard.

## 6. Tanggung Jawab Modul

| Modul | Tanggung jawab | Tidak boleh |
|---|---|---|
| `shared/config.js` | nilai default, kunci storage, tipe pesan, batas, daftar file content script | mengakses `chrome.*` / DOM |
| `shared/random.js` | `randInt`, `gauss` | — |
| `shared/time.js` | `nowStamp`, `todayKey`, `sleep` | — |
| `shared/storage.js` | Promise wrapper storage | menyimpan state aplikasi |
| `shared/spintax.js` | parser `{a|b}` | — |
| `background/state.js` | objek `run` + `restoreState()` | logika posting |
| `background/power.js` | keep-awake | — |
| `background/messaging.js` | `log`, `setRunning`, `broadcastQueueInfo` | navigasi tab |
| `background/tabs.js` | tab FB/dashboard, injeksi content script, `sendToContent` | mengubah antrean |
| `background/scheduler.js` | antrean + alarm + `processNextPost` + `getStatus` (pemulihan status basi) + uji `openComposerFromHome` | akses DOM Facebook |
| `content/selectors.js` | konstanta selektor | logika |
| `content/dom.js` | penunggu & pencari elemen | klik aksi bisnis |
| `content/stealth.js` | humanizer input | selektor |
| `content/media.js` | data URL → File → input upload | — |
| `content/navigation.js` | alur home → grup | posting |
| `content/scraper.js` | scraper grup | posting |
| `content/posting.js` | `openComposer()` (buka composer) + eksekusi posting (termasuk flag DRY RUN) | navigasi |
| `dashboard/state.js` | state UI | DOM |
| `dashboard/ui.js` | `$`, `escapeHtml`, `addLog`, `setStatus` | data |
| `dashboard/materials.js` | import materi & media | kontrol running |
| `dashboard/settings.js` | form pengaturan | antrean |
| `dashboard/groups.js` | tabel & pencarian grup | antrean |
| `dashboard/controls.js` | tombol start/stop, uji buka composer, `syncStatus` awal, tab FB, event realtime | render tabel |
| `dashboard/main.js` | init + catch error global | logika fitur |

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

- **Workflow "Uji Post" & produksi = SATU inti bersama: media DULU, baru
  caption (GATE blob).** Temuan lapangan: attach media me-`re-render` composer
  Lexical sehingga caption yang diketik SEBELUM media ikut terhapus.
  `composeMediaAndCaption()` (`src/content/posting.js`) karena itu memaksa
  urutan `openComposer() → uploadMedia() → GATE preview blob (`video[blob]
  readyState>=2` / `img[blob]` baru muncul) → query editor ulang (scope preview
  media dulu, lalu dialog, lalu document) → `typeCaption()`. Dipakai dua jalur:
  `testCompose()` (tombol "Uji Post" — STOP tanpa submit) dan `postToGroup()`
  (tombol "Mulai Posting" — lanjut klik tombol Posting + **verifikasi
  pasca-submit**: composer & preview media harus hilang; bila tidak, klik
  diulang sekali lalu throw agar scheduler mencatat GAGAL, antrean tidak maju
  palsu). Selektor hanya `role`/`aria-label`/`aria-placeholder` (tanpa class
  `x…` FB); dialog composer asli dicari dari ISI (editor di dalamnya), bukan
  dari `aria-label` — dialog berlabel "Buat postingan" hanya kotak judul
  kosong. Ketik per-baris memakai `execCommand("insertText")` + fallback paste,
  verifikasi pertumbuhan teks ASYNC, dan anti-dobel (bersihkan & ketik ulang
  sekali bila teks terduplikasi). `uploadMedia()` punya fallback jalur lama
  `attachMedia()` bila konversi `fetch(dataURL)` gagal. Timeout `EXECUTE_POST`
  150s (upload + GATE 20s + caption + submit untuk materi besar). Dijaga check
  `checkTestPostWiring()` di `tools/verify.js` (urutan `uploadMedia` <
  `typeCaption`, satu inti bersama, verifikasi pasca-submit, tanpa submit di
  jalur uji).

- **Dua varian penulis storage.** `storage.set()` tidak pernah reject (dipakai alur
  kritis posting, sesuai perilaku lama background) sedangkan `storage.setStrict()`
  reject saat `chrome.runtime.lastError` (perilaku lama dashboard yang memang
  memasang `.catch()`/`try-catch`). Perbedaan ini dipertahankan agar tidak ada
  perubahan perilaku error.
- **Guard `content.routerReady`.** Content script bisa tersuntik dua kali (manifest
  + fallback `executeScript`). Guard ini mencegah listener `onMessage` ganda, yang
  akan membuat `sendResponse` dipanggil berulang.
- **Antrean dipersist sebelum alarm pertama** (`queue`, `cursor`, `materials`,
  `settings`) karena service worker MV3 dapat dimatikan dan dihidupkan ulang oleh
  alarm.
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

## 9. Verifikasi Otomatis

`node tools/verify.js` menjalankan 30 pemeriksaan: sintaks, kode mati,
id DOM dashboard ↔ HTML, sinkronisasi manifest, urutan `<script>`, konstanta
pesan, paritas nama fungsi & literal tipe pesan terhadap snapshot
`backups/pre-refactor/`, smoke test pemuatan modul (vm + stub `chrome` dan
`document`) untuk ketiga konteks, pemulihan status basi (`GET_STATUS`
mereset sesi yang sudah mati sehingga tombol **Mulai Posting** tetap bisa diklik),
serta uji rantai navigasi `home → grup → composer` di atas DOM Facebook tiruan
(urutan klik natural, grup pertama sidebar, dan editor composer terdeteksi).

