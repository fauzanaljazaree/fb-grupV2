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
             → state → power → messaging → tabs → scheduler   (via importScripts)

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
| `EXECUTE_POST` | background → content | `caption, mediaDataUrl, mediaMime, mediaName` | Isi composer & submit, balas `{ok, error}` |
| `EXECUTE_SCRAPE` | background → content | – | Scraper daftar grup (fitur nonaktif) |
| `START_POSTING` | dashboard → background | `{materials, settings}` | Bangun antrean + mulai alarm |
| `STOP_POSTING` | dashboard → background | – | Hentikan antrean & lepas keep-awake |
| `GET_STATUS` | dashboard → background | – | `{ok, running, recovered?}` — status dihitung dari memori + alarm; status basi dibersihkan |
| `SET_VIEW` | dashboard → background | `showFbTab` | Set mode tampilan tab FB |
| `VIEW_FB_TAB` | dashboard → background | – | Fokus/buka tab FB |
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

Semua langkah browser memakai satu tab FB (pinned) yang dipakai ulang. Fokus tab
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
| `background/scheduler.js` | antrean + alarm + `processNextPost` + `getStatus` (pemulihan status basi) | akses DOM Facebook |
| `content/selectors.js` | konstanta selektor | logika |
| `content/dom.js` | penunggu & pencari elemen | klik aksi bisnis |
| `content/stealth.js` | humanizer input | selektor |
| `content/media.js` | data URL → File → input upload | — |
| `content/navigation.js` | alur home → grup | posting |
| `content/scraper.js` | scraper grup | posting |
| `content/posting.js` | eksekusi posting (termasuk flag DRY RUN) | navigasi |
| `dashboard/state.js` | state UI | DOM |
| `dashboard/ui.js` | `$`, `escapeHtml`, `addLog`, `setStatus` | data |
| `dashboard/materials.js` | import materi & media | kontrol running |
| `dashboard/settings.js` | form pengaturan | antrean |
| `dashboard/groups.js` | tabel & pencarian grup | antrean |
| `dashboard/controls.js` | tombol start/stop, `syncStatus` awal, tab FB, event realtime | render tabel |
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

## 9. Verifikasi Otomatis

`node tools/verify.js` menjalankan 25 pemeriksaan: sintaks, kode mati,
id DOM dashboard ↔ HTML, sinkronisasi manifest, urutan `<script>`, konstanta
pesan, paritas nama fungsi & literal tipe pesan terhadap snapshot
`backups/pre-refactor/`, smoke test pemuatan modul (vm + stub `chrome` dan
`document`) untuk ketiga konteks, serta pemulihan status basi (`GET_STATUS`
mereset sesi yang sudah mati sehingga tombol **Mulai Posting** tetap bisa diklik).

