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

| Tipe                           | Arah                   | Payload                                                 | Efek                                                                                                                                                                                                                                                  |
| ------------------------------ | ---------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PING`                         | background → content   | –                                                       | Cek content script terpasang (`{ok:true,pong:true}`)                                                                                                                                                                                                  |
| `NAV_HOME_TO_GROUP`            | background → content   | –                                                       | Navigasi natural, balas `{groupUrl, groupName}`                                                                                                                                                                                                       |
| `NAV_HOME_TO_COMPOSER`         | background → content   | –                                                       | Navigasi natural + buka composer, balas `{groupUrl, groupName, url}`                                                                                                                                                                                  |
| `EXECUTE_POST`                 | background → content   | `autoPost, caption, mediaDataUrl, mediaMime, mediaName` | `postToGroup()`: inti media-dulu+caption → (mode autoposting) klik Posting + verifikasi composer tertutup / (mode manual) tunggu `LIMITS.MANUAL_POST_WINDOW_MS` lalu lanjut tanpa klik — balas `{ok, error}`                                          |
| `EXECUTE_SCRAPE`               | background → content   | –                                                       | Scraper daftar grup mode lama (scroll window)                                                                                                                                                                                                         |
| `START_SCAN`                   | dashboard → background | –                                                       | Mulai scan sidebar /groups/feed/ pada tab sementara. Guard `scanStatus` anti-dobel; balas `{ok, accepted}` tanpa menunggu hasil — hasil dibaca dashboard via `storage.onChanged` pada kunci `scanStatus`/`groups`. Orkestrasi di `background/scan.js` |
| `SCAN_GROUPS`                  | background → content   | –                                                       | `scanGroups()`: loop scroll sidebar (maks 80 pass) + kumpulkan `a[href*="/groups/"]`, balas `{ok, sourceUrl, scannedAt, groups}`                                                                                                                      |
| `START_POSTING`                | dashboard → background | `{materials, settings}`                                 | Bangun antrean + mulai alarm                                                                                                                                                                                                                          |
| `STOP_POSTING`                 | dashboard → background | –                                                       | Hentikan antrean & lepas keep-awake                                                                                                                                                                                                                   |
| `GET_STATUS`                   | dashboard → background | –                                                       | `{ok, running, recovered?}` — status dihitung dari memori + alarm; status basi dibersihkan                                                                                                                                                            |
| `SET_VIEW`                     | dashboard → background | `showFbTab`                                             | Set mode tampilan tab FB                                                                                                                                                                                                                              |
| `VIEW_FB_TAB`                  | dashboard → background | –                                                       | Fokus/buka tab FB                                                                                                                                                                                                                                     |
| `OPEN_COMPOSER`                | dashboard → background | –                                                       | Uji jalur navigasi home → grup → composer (tab FB difokuskan selama proses, lalu fokus balik ke dashboard)                                                                                                                                            |
| `BACK_TO_DASHBOARD`            | dashboard → background | –                                                       | Fokus balik ke tab dashboard                                                                                                                                                                                                                          |
| `LOG` / `STATE` / `QUEUE_INFO` | background → dashboard | teks log / running / sisa antrean                       | Update UI realtime                                                                                                                                                                                                                                    |

Nilai setiap konstanta sengaja identik dengan namanya agar mudah dilacak di
DevTools. `tools/verify.js` memastikan tidak ada konstanta yang menganggur dan
tidak ada tipe pesan lama yang hilang.

## 4. Kunci `chrome.storage.local` (`FBAP.config.STORAGE`)

| Kunci                       | Isi                                                                                                                                          | Ditulis oleh                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `settings`                  | `{minDelay,maxDelay,dailyLimit,cooldownEvery,cooldownMinutes,autoPost}`                                                                      | dashboard (settings, controls), background (startPosting) |
| `materials`                 | daftar materi `{caption,mediaName,available,mediaDataUrl,mediaMime}`                                                                         | dashboard, background                                     |
| `queue` / `cursor`          | indeks materi & posisi berjalan                                                                                                              | background (scheduler)                                    |
| `stats`                     | `{"YYYY-MM-DD": jumlah}` untuk batas harian                                                                                                  | background (scheduler)                                    |
| `status`                    | `{running}` — dipulihkan/dibersihkan oleh `scheduler.getStatus()`, karena kunci ini bisa tertinggal bila sesi berakhir tanpa `stopPosting()` | background (messaging.setRunning, scheduler.getStatus)    |
| `postingLogs`               | maksimal 500 baris log terakhir                                                                                                              | background (messaging.log)                                |
| `ui`                        | `{showFbTab}`                                                                                                                                | dashboard & background                                    |
| `groups` / `selectedGroups` | data grup (fitur scraping nonaktif)                                                                                                          | dashboard (groups)                                        |

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
    | cooldown bila postsSinceCooldown >= cooldownEvery
    v
  scheduleNext(jeda acak / sisa cooldown) -> alarm berikutnya ...
    v
  antrean habis atau limit harian tercapai -> stopPosting(reason)
```

Semua langkah browser memakai satu tab FB biasa (unpinned) yang dipakai ulang. Fokus tab
hanya berpindah bila `ui.showFbTab` aktif; setelah tiap posting fokus kembali ke
dashboard. **Kontrak navigasi: `ensurePostTab(url)` DILARANG me-reload tab yang sudah
berada di grup target** — `chrome.tabs.update({url})` pada tab yang sama memicu full
page reload yang menghancurkan composer modal yang baru dibuka `NAV_HOME_TO_COMPOSER`.
Karena itu `ensurePostTab` memakai `sameGroupUrl()` (bandingkan URL kanonis
`/groups/{id}`) dan bila sama hanya melepas pin + fokus tanpa navigasi. Bila ragu
(URL tidak kanonis), pilih aman: tetap navigasi (perilaku lama).
Bila `settings.autoPost` **tidak aktif**, langkah `EXECUTE_POST`
berhenti setelah media+caption terisi dan menunggu `MANUAL_POST_WINDOW_MS`
(10 detik) untuk klik Posting oleh user; setelah jendela itu antrean lanjut
tanpa memeriksa hasil klik (tetap dihitung 1 posting), jadi mode manual
membutuhkan tab FB terlihat agar user bisa mengklik.

## 6. Tanggung Jawab Modul

| Modul                     | Tanggung jawab                                                                                         | Tidak boleh                |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------- | --- |
| `shared/config.js`        | nilai default, kunci storage, tipe pesan, batas, daftar file content script                            | mengakses `chrome.*` / DOM |
| `shared/random.js`        | `randInt`, `gauss`                                                                                     | —                          |
| `shared/time.js`          | `nowStamp`, `todayKey`, `sleep`                                                                        | —                          |
| `shared/storage.js`       | Promise wrapper storage                                                                                | menyimpan state aplikasi   |
| `shared/spintax.js`       | parser `{a                                                                                             | b}`                        | —   |
| `background/state.js`     | objek `run` + `restoreState()`                                                                         | logika posting             |
| `background/power.js`     | keep-awake                                                                                             | —                          |
| `background/messaging.js` | `log`, `setRunning`, `broadcastQueueInfo`                                                              | navigasi tab               |
| `background/tabs.js`      | tab FB/dashboard, injeksi content script, `sendToContent`                                              | mengubah antrean           |
| `background/scheduler.js` | antrean + alarm + `processNextPost` + `getStatus` (pemulihan status basi) + uji `openComposerFromHome` | akses DOM Facebook         |
| `content/selectors.js`    | konstanta selektor                                                                                     | logika                     |
| `content/dom.js`          | penunggu & pencari elemen                                                                              | klik aksi bisnis           |
| `content/stealth.js`      | humanizer input                                                                                        | selektor                   |
| `content/media.js`        | data URL → File → input upload                                                                         | —                          |
| `content/navigation.js`   | alur home → grup                                                                                       | posting                    |
| `content/scraper.js`      | scraper grup                                                                                           | posting                    |
| `content/posting.js`      | `openComposer()` (buka composer) + eksekusi posting (mode autoposting/manual via parameter `autoPost`) | navigasi                   |
| `dashboard/state.js`      | state UI                                                                                               | DOM                        |
| `dashboard/ui.js`         | `$`, `escapeHtml`, `addLog`, `setStatus`                                                               | data                       |
| `dashboard/materials.js`  | import materi & media                                                                                  | kontrol running            |
| `dashboard/settings.js`   | form pengaturan                                                                                        | antrean                    |
| `dashboard/groups.js`     | tabel & pencarian grup                                                                                 | antrean                    |
| `dashboard/controls.js`   | tombol start/stop, checkbox autoposting, uji buka composer, `syncStatus` awal, tab FB, event realtime  | render tabel               |
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
  - `autoPost === false`: STOP setelah media+caption terisi, tunggu
    `LIMITS.MANUAL_POST_WINDOW_MS` (10 detik) memberi user kesempatan klik
    Posting sendiri, lalu `return true` **tanpa memedulikan** apakah user
    mengklik atau tidak — hasilnya tetap dihitung 1 posting sukses oleh
    scheduler (cursor maju, statistik harian +1) agar loop tidak macet.
    Selektor hanya `role`/`aria-label`/`aria-placeholder` (tanpa class `x…` FB);
    dialog composer asli dicari dari ISI (editor di dalamnya), bukan dari
    `aria-label` — dialog berlabel "Buat postingan" hanya kotak judul kosong.
    Ketik per-baris memakai `execCommand("insertText")` + fallback paste,
    verifikasi pertumbuhan teks ASYNC, dan anti-dobel (bersihkan & ketik ulang
    sekali bila teks terduplikasi). `uploadMedia()` punya fallback jalur lama
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

## 9. Verifikasi Otomatis

`node tools/verify.js` menjalankan 56 pemeriksaan: sintaks, kode mati,
id DOM dashboard ↔ HTML, sinkronisasi manifest, urutan `<script>`, konstanta
pesan, wiring checkbox **autoposting** (HTML → `controls.js` → `payload.settings`
→ scheduler → `EXECUTE_POST.autoPost` → `postToGroup()`: cabang manual menunggu
`LIMITS.MANUAL_POST_WINDOW_MS` sebelum `findPostButton`, jadi mode manual tidak
mungkin men-submit), paritas nama fungsi & literal tipe pesan terhadap snapshot
`backups/pre-refactor/`, smoke test pemuatan modul (vm + stub `chrome` dan
`document`) untuk ketiga konteks, pemulihan status basi (`GET_STATUS`
mereset sesi yang sudah mati sehingga tombol **Mulai Posting** tetap bisa diklik),
serta uji rantai navigasi `home → grup → composer` di atas DOM Facebook tiruan
(urutan klik natural, grup pertama sidebar, dan editor composer terdeteksi).

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
