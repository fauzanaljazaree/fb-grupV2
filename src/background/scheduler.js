/* =========================================================
   FB Auto Poster - Background: Penjadwal Antrean Posting
   Antrean di-drive oleh chrome.alarms (satu alarm "post-tick"
   per langkah) supaya service worker tetap bisa tidur di
   antara dua posting.

   Alur BARU (materi-luar x grup-dalam): startPosting -> scheduleNext ->
         onAlarm -> processNextPost -> scheduleNext (berulang).
   Tiap item antrean = {mi, gi, extras}. Checkbox "Posting Batch" dashboard:
     AKTIF   -> extras berisi s.d. 9 grup tambahan (1 submit -> 10 grup
                via picker "Tambahkan grup" di composer).
     NONAKTIF-> extras selalu kosong: 1 grup 1 submit, picker tidak dibuka.
   Navigasi natural dilakukan SETIAP langkah (cari grup target di sidebar
   -> klik), jeda acak setiap pindah grup.
   Gagal di 1 batch -> lanjut batch berikutnya + tandai ✅/❌ di tabel.
   Grup jual-beli (SKIP_SELL_GROUP dari openComposer) -> label permanen
   SELL_GROUPS + uncheck + lanjut antrean (bukan gagal teknis).
   Ketika antrean habis / limit harian tercapai -> stopPosting.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const background = (FBAP.background = FBAP.background || {});
  const { DEFAULTS, MSG, STORAGE, LIMITS } = FBAP.config;
  const { randInt, gauss } = FBAP.random;
  const { todayKey } = FBAP.time;
  const { get: storageGet, set: storageSet } = FBAP.storage;
  const { materialKey: calcKey } = FBAP.materialKey;
  const { run, FB_HOME } = background.state;
  const { keepAwakeOn, keepAwakeOff } = background.power;
  const { log, setRunning, broadcastQueueInfo } = background.messaging;
  const { ensurePostTab, restorePostTab, waitTabLoaded, ensureContentScript, sendToContent, focusTab, focusDashboard, forgetPostTab, ensureManualPostTab } = background.tabs;
  const { putAllMedia, hydrateMaterials } = background.mediaStore;

  const ALARM_NAME = "post-tick";

  /* ---------------- START / STOP ---------------- */
  async function startPosting(payload) {
    if (run.running) return { ok: false, error: "Posting sudah berjalan" };
    const materialList = (payload && payload.materials) || [];
    const groupList = (payload && payload.groups) || [];
    const settings = (payload && payload.settings) || {};
    if (!materialList.length) return { ok: false, error: "Tidak ada materi" };
    if (!groupList.length) return { ok: false, error: "Tidak ada grup yang dicentang. Centang dulu grup di tabel." };

    run.materials = materialList;
    run.groups = groupList.map((g) => ({ name: g.name || g.url, url: g.url }));
    /* GATE MEDIA START (jangan posting teks diam-diam): materi yang memakai
       media TAPI blob-nya tidak terbawa (folder media belum dimuat / user
       menekan Mulai meski ada badge "✗ Tidak Ada") -> tolak mulai + pesan
       jelas. Materi "Tanpa Media" (memang tanpa kolom Media_Name) tetap
       boleh berjalan sebagai posting teks. */
    const missingBlobs = materialList.filter((m) => m.mediaName && !m.mediaDataUrl);
    if (missingBlobs.length) {
      const names = [...new Set(missingBlobs.map((m) => m.mediaName))].slice(0, 5).join(", ");
      return {
        ok: false,
        error: `Media tidak tersedia untuk ${missingBlobs.length} materi (${names}${missingBlobs.length > 5 ? ", ..." : ""}). Muat ulang folder media di dashboard lalu mulai lagi — sesi tidak boleh jalan bila ada media yang akan hilang (posting bisa jadi teks saja).`,
      };
    }
    /* PERSIST BLOB MEDIA KE INDEXEDDB: chrome.storage.local tidak muat blob
       (kuota ~5MB) dan memori service worker MV3 hilang saat worker tidur
       (inilah akar bug "media hilang di grup ke-4+"). IndexedDB bertahan
       lintas restart worker/browser; processNextPost mengisi ulang blob dari
       sini setiap langkah via hydrateMaterials. Kunci store dibersihkan tiap
       sesi baru (satu sesi = satu isi store). Bila IndexedDB gagal (mode
       privasi dsb.) sesi TIDAK dimulai — lebih aman daripada media hilang
       di tengah jalan. */
    let storedBlobs = 0;
    try {
      storedBlobs = await putAllMedia(
        materialList.filter((m) => m.mediaName && m.mediaDataUrl).map((m) => ({ name: m.mediaName, dataUrl: m.mediaDataUrl, mime: m.mediaMime })),
      );
      if (storedBlobs) {
        await log(`${storedBlobs} file media disimpan ke penyimpanan sesi (IndexedDB, tahan restart service worker/browser).`, "ok");
      }
    } catch (e) {
      return { ok: false, error: `Gagal menyimpan media ke IndexedDB (${e.message}). Sesi tidak dimulai — coba muat ulang folder media, atau jalankan tanpa mode penyamaran.` };
    }
    /* Grup berlabel jual-beli (pernah terdeteksi hanya punya tombol
       "Jual sesuatu", STORAGE.SELL_GROUPS) DILEWATI sejak awal: tidak
       masuk antrean, tidak dinavigasi sia-sia. Label menang atas centang
       — bila user meng-centang ulang grup jual-beli, tetap difilter
       (hapus labelnya via tombol dashboard "Hapus label jual-beli"
       untuk mencoba lagi). */
    const sellMap = (await storageGet([STORAGE.SELL_GROUPS]))[STORAGE.SELL_GROUPS] || {};
    const skippedSell = run.groups.filter((g) => sellMap[g.url]);
    if (skippedSell.length) {
      run.groups = run.groups.filter((g) => !sellMap[g.url]);
      await log(`Melewati ${skippedSell.length} grup jual-beli (tanpa kolom posting): ${skippedSell.map((g) => g.name || g.url).join(", ")}.`, "warn");
    }
    if (!run.groups.length) {
      return { ok: false, error: "Semua grup terpilih berlabel jual-beli (tanpa kolom posting). Hapus labelnya di dashboard bila ingin mencoba lagi." };
    }
    run.settings = { ...DEFAULTS.settings, ...settings };
    /* Default "Tampilkan tab FB saat posting" = AKTIF (checkbox dashboard
       tercentang secara default); hanya dimatikan bila eksplisit false. */
    run.showFbTab = settings.showFbTab !== false;
    /* BATCH 1+9 (checkbox "Posting Batch" dashboard): saat batchPost aktif,
       1 submit menjangkau s.d. 10 grup — grup pertama batch = grup utama
       (dinavigasi natural via sidebar), sisanya (s.d. 9) = grup tambahan
       yang dicentang via picker "Tambahkan grup" di composer (fitur
       bawaan FB). Saat NONAKTIF, tiap grup = batch satuan tanpa extras:
       posting 1 grup 1 submit, picker tidak pernah dibuka (aman bila
       picker sering gagal). Loop luar = materi, loop dalam = batch grup. */
    run.batchPost = settings.batchPost !== false;
    run.queue = [];
    const step = run.batchPost ? 1 + LIMITS.EXTRA_GROUPS_PER_POST : 1;
    for (let mi = 0; mi < materialList.length; mi++) {
      for (let gi = 0; gi < run.groups.length; gi += step) {
        run.queue.push({
          mi,
          gi,
          extras: run.batchPost
            ? run.groups.slice(gi + 1, gi + step).map((g) => ({ name: g.name, url: g.url }))
            : [],
        });
      }
    }
    run.cursor = 0;
    run.postsSinceCooldown = 0;
    run.cooldownUntil = 0;
    run.groupUrl = null;
    run.groupName = null;
    run.results = {};
    /* Muat matriks status lama (persisten) — TIDAK direset tiap sesi.
       Caption sama -> materialKey sama -> status ✅/❌ lama tetap tercocokkan
       walau ekstensi ditutup dan materi di-import ulang. */
    run.matrix = (await storageGet([STORAGE.POST_MATRIX]))[STORAGE.POST_MATRIX] || {};
    /* Tab FB tidak dibuang saat mulai: ID postTab terakhir dipulihkan dari
       storage dan tabnya DIPAKAI ULANG untuk sesi ini (anti tab numpuk).
       Jika tab sudah ditutup user, ensurePostTab mengadopsi tab FB lain /
       membuat baru dan mencatat ID-nya kembali. */
    await restorePostTab();

    /* PENTING: persist antrean ke storage agar processNextPost (alarm)
       tidak membaca queue kosong dan langsung "Antrean selesai". */
    await storageSet({
      [STORAGE.QUEUE]: run.queue,
      [STORAGE.CURSOR]: 0,
      [STORAGE.MATERIALS]: run.materials.map((m) => ({ account: m.account || "", caption: m.caption || "", mediaName: m.mediaName || "" })),
      [STORAGE.SETTINGS]: run.settings,
      [STORAGE.GROUPS_SNAPSHOT]: run.groups,
      [STORAGE.GROUP_RESULTS]: {},
    });

    keepAwakeOn();
    await setRunning(true);
    await log(
      `Antrean dibangun: ${materialList.length} materi x ${run.groups.length} grup = ${run.queue.length} ${run.batchPost ? `batch (1 grup utama + s.d. ${LIMITS.EXTRA_GROUPS_PER_POST} tambahan via "Tambahkan grup" per submit)` : `posting satuan (1 grup 1 submit, tanpa picker "Tambahkan grup")`}. Tab FB: ${run.showFbTab ? "tampil di depan (fokus)" : "background (tetap di dashboard)"}.`,
      "info",
    );
    await broadcastQueueInfo();
    /* Posting pertama LANGSUNG (tanpa alarm/jeda) — jeda acak hanya untuk
       antar posting berikutnya (diatur scheduleNext di processNextPost). */
    processNextPost().catch(() => {});
    return { ok: true };
  }

  async function stopPosting(reason) {
    chrome.alarms.clear(ALARM_NAME);
    run.nextAt = 0;
    try {
      await storageSet({ [STORAGE.NEXT_POST_AT]: 0 });
    } catch (e) { /* abaikan: countdown cukup berhenti via STATE */ }
    await setRunning(false);
    keepAwakeOff();
    if (reason) await log(reason, "warn");
    /* Sesi berakhir: lupakan ID postTab (storage + memori). Tabnya sengaja
       TIDAK ditutup — dipakai ulang sesi berikutnya via restorePostTab +
       guard sameGroupUrl di ensurePostTab (anti tab numpuk antar sesi). */
    await forgetPostTab();
    await broadcastQueueInfo();
  }

  /* ---------------- STATUS SEBENARNYA (PEMULIHAN STATUS BASI) ----------------
     Sumber kebenaran status adalah MEMORI + ALARM, bukan kunci `status` di
     storage. Worker MV3 bisa dimatikan kapan saja sehingga `run.running`
     hilang, sementara kunci `status` tetap `{running:true}` bila sesi berakhir
     tanpa stopPosting() (browser/ekstensi ditutup saat posting berjalan).
     Status basi itulah yang membuat dashboard mengunci tombol "Mulai Posting",
     jadi status dibandingkan dengan alarm yang benar-benar terjadwal. */
  function alarmExists() {
    return new Promise((resolve) => {
      try {
        chrome.alarms.get(ALARM_NAME, (a) => resolve(!!a));
      } catch (e) {
        resolve(false);
      }
    });
  }

  /** Status sebenarnya: pulihkan sesi yang masih terjadwal, buang yang basi. */
  async function getStatus() {
    let nextAt = run.nextAt || 0;
    try {
      const savedNext = (await storageGet([STORAGE.NEXT_POST_AT]))[STORAGE.NEXT_POST_AT];
      if (typeof savedNext === "number" && savedNext > 0) {
        nextAt = savedNext;
        if (!run.nextAt) run.nextAt = savedNext;
      }
    } catch (e) { /* abaikan: countdown default 0 */ }
    if (run.running || run.busy) return { ok: true, running: true, nextAt };
    const stored = (await storageGet([STORAGE.STATUS]))[STORAGE.STATUS];
    if (!(stored && stored.running)) return { ok: true, running: false, nextAt: 0 };

    /* Sesi lama masih hidup: alarm langkah berikutnya masih terjadwal. */
    if (await alarmExists()) {
      run.running = true;
      keepAwakeOn();
      return { ok: true, running: true, nextAt };
    }

    /* Sesi basi: tanpa alarm & tanpa proses -> bersihkan supaya tidak terkunci. */
    run.queue = [];
    run.cursor = 0;
    run.groupUrl = null;
    run.groupName = null;
    run.nextAt = 0;
    await storageSet({ [STORAGE.QUEUE]: [], [STORAGE.CURSOR]: 0, [STORAGE.NEXT_POST_AT]: 0 });
    await setRunning(false);
    await log('Status "Berjalan" warisan sesi lama dibersihkan (tidak ada alarm aktif) — siap memulai posting baru.', "warn");
    return { ok: true, running: false, recovered: true, nextAt: 0 };
  }

  /** Jadwalkan langkah berikutnya (di-clamp agar alarm tetap wajar). */
  function scheduleNext(delayMs) {
    if (!run.running) return;
    const now = Date.now();
    const when = Math.max(now + Math.min(delayMs, LIMITS.MAX_ALARM_DELAY_MS), now + LIMITS.MIN_ALARM_DELAY_MS);
    chrome.alarms.create(ALARM_NAME, { when });
    /* Countdown dashboard: persist epoch posting berikutnya (tahan restart
       SW & reload dashboard) lalu siarkan via QUEUE_INFO. Fire-and-forget
       agar timing alarm tidak berubah (fungsi tetap sinkron). */
    run.nextAt = when;
    try {
      storageSet({ [STORAGE.NEXT_POST_AT]: when }).catch(() => {});
    } catch (e) { /* abaikan */ }
    try {
      broadcastQueueInfo().catch(() => {});
    } catch (e) { /* abaikan */ }
    const sec = Math.round((when - now) / 1000);
    log(`Jeda acak: aksi berikutnya dalam \u00b1${sec}s.`, "info");
  }

  /* ---------------- PROSES SATU LANGKAH ----------------
     Navigasi natural dilakukan sekali (run.groupUrl masih null),
     lalu tiap alarm berikutnya hanya memproses satu materi. */
  /** Fingerprint materi ke-m (dipakai sebagai kunci matriks status). */
  function keyOfMaterial(mi) {
    const m = run.materials && run.materials[mi];
    return m ? calcKey(m) : null;
  }

  /** Index grup di tabel run.groups berdasarkan URL (-1 bila tidak ada). */
  function giOf(url) {
    return (run.groups || []).findIndex((g) => g.url === url);
  }

  /** Tandai hasil 1 grup (utama maupun tambahan): persist GROUP_RESULTS +
      POST_MATRIX + kirim GROUP_RESULT ke dashboard agar tabel update realtime.
      Matriks = {materialKey: {groupUrl: {ok, mi, gi, at, error}}} — persisten
      lintas sesi; dipakai dashboard untuk menampilkan ✅/❌ per materi (M1, M2, …). */
  async function markGroup(url, ok, mi, gi, error) {
    if (!url) return;
    run.results[url] = error ? { ok, mi, at: Date.now(), error } : { ok, mi, at: Date.now() };
    const key = keyOfMaterial(mi);
    if (key) {
      run.matrix[key] = run.matrix[key] || {};
      run.matrix[key][url] = { ok: !!ok, mi: mi || 0, gi: typeof gi === "number" ? gi : -1, at: Date.now(), error: error || "" };
    }
    await storageSet({ [STORAGE.GROUP_RESULTS]: run.results, [STORAGE.POST_MATRIX]: run.matrix });
    chrome.runtime.sendMessage({ type: MSG.GROUP_RESULT, url, ok, mi, error: error || "" }).catch(() => {});
  }

  /** Pesan error content script menandakan grup jual-beli (tanpa kolom
      posting)? Prefix SKIP_SELL_GROUP dilempar openComposer(); pesan bisa
      terbungkus "Navigasi ke ... gagal: ..." sehingga pakai includes(). */
  function isSkipSellError(msg) {
    return typeof msg === "string" && msg.includes("SKIP_SELL_GROUP");
  }

  /** Grup terdeteksi jual-beli: tandai ❌ dengan alasan jual-beli (bukan
      gagal teknis), tulis label permanen STORAGE.SELL_GROUPS, uncheck dari
      SELECTED_GROUPS, beri tahu dashboard via MSG.SELL_GROUP_MARKED.
      Hanya grup UTAMA batch yang dilabeli (deteksi terjadi di halamannya);
      grup tambahan hanya ❌ untuk batch ini dan akan dicoba di batch lain.
      Pemanggil yang melanjutkan antrean (cursor++, scheduleNext). */
  async function handleSkipSellGroup(group, extraUrls, mi, gi) {
    const why = 'Grup jual-beli — hanya ada tombol "Jual sesuatu" (tanpa kolom posting)';
    await markGroup(group.url, false, mi, gi, why);
    for (const url of extraUrls) await markGroup(url, false, mi, giOf(url), "Dilewati: grup utama batch jual-beli");
    const sell = (await storageGet([STORAGE.SELL_GROUPS]))[STORAGE.SELL_GROUPS] || {};
    sell[group.url] = { at: Date.now(), name: group.name || group.url };
    await storageSet({ [STORAGE.SELL_GROUPS]: sell });
    const sel = (await storageGet([STORAGE.SELECTED_GROUPS]))[STORAGE.SELECTED_GROUPS] || [];
    const drop = new Set([group.url, ...extraUrls]);
    const nextSel = sel.filter((u) => !drop.has(u));
    if (nextSel.length !== sel.length) await storageSet({ [STORAGE.SELECTED_GROUPS]: nextSel });
    chrome.runtime.sendMessage({ type: MSG.SELL_GROUP_MARKED, url: group.url, name: group.name || group.url }).catch(() => {});
    await log(`⏭️ Dilewati ${group.name || group.url}: grup jual-beli (tanpa kolom posting). Ditandai 🏷️ & centangnya dilepas — lanjut batch berikutnya.`, "warn");
  }

  async function processNextPost() {
    if (run.busy) return;
    if (!run.running) {
      /* Worker MV3 bisa mati di antara dua alarm: `run.running` hilang dari
         memori padahal sesi masih terjadwal. Pulihkan dari storage agar sesi
         panjang tetap lanjut (bukan berhenti diam-diam). */
      const saved = (await storageGet([STORAGE.STATUS]))[STORAGE.STATUS];
      if (!(saved && saved.running)) return;
      run.running = true;
      keepAwakeOn();
    }
    /* stopSession (media hilang -> stop total) dan failedBatch (batch gagal
       -> lanjut antrean) dideklarasikan DI LUAR try/catch/finally supaya
       keputusan penjadwalan setelah finally tetap melihatnya. */
    let stopSession = false;
    let failedBatch = false;
    run.busy = true;
    try {
      const st = await storageGet([STORAGE.QUEUE, STORAGE.CURSOR, STORAGE.SETTINGS, STORAGE.MATERIALS, STORAGE.STATS, STORAGE.GROUPS_SNAPSHOT, STORAGE.GROUP_RESULTS, STORAGE.POST_MATRIX, STORAGE.POST_TAB_ID, STORAGE.NEXT_POST_AT]);
      /* Countdown: posting sedang dieksekusi -> jadwal lama basi. Nol-kan
         dulu (persist + siarkan) agar dashboard tidak menghitung mundur ke
         waktu yang sudah lewat; scheduleNext di akhir langkah menulis lagi. */
      run.nextAt = 0;
      storageSet({ [STORAGE.NEXT_POST_AT]: 0 }).catch(() => {});
      broadcastQueueInfo().catch(() => {});
      /* Worker MV3 bisa bangun dengan memori kosong: pulihkan ID tab posting
         dari storage agar tab FB lama DIPAKAI ULANG (bukan buka tab baru
         tiap batch — anti tab numpuk). Bila ID basi, ensurePostTab yang
         mengurus adopsi/pembuatan tab. */
      await restorePostTab();
      /* FALLBACK: bila storage kosong (mis. alarm fire sebelum persist),
         pakai state in-memory jangan overwrite dengan nilai kosong. */
      run.queue = st[STORAGE.QUEUE] && st[STORAGE.QUEUE].length ? st[STORAGE.QUEUE] : run.queue || [];
      run.cursor = st[STORAGE.CURSOR] != null ? st[STORAGE.CURSOR] : run.cursor;
      run.settings = {
        ...DEFAULTS.settings,
        ...(st[STORAGE.SETTINGS] && Object.keys(st[STORAGE.SETTINGS]).length ? st[STORAGE.SETTINGS] : run.settings),
      };
      /* Materi: ambil versi ringan dari storage, lalu merge blob media dari
         state in-memory (urutan sama dalam satu sesi). Sisanya diisi ulang
         dari IndexedDB via hydrateMaterials — inilah perbaikan bug "media
         hilang di grup ke-4+": memori service worker hilang saat worker
         tidur di jeda antar posting, tapi blob di IndexedDB tetap ada dan
         tiap langkah kembali terpasang. */
      const storedMaterials = st[STORAGE.MATERIALS] && st[STORAGE.MATERIALS].length ? st[STORAGE.MATERIALS] : null;
      if (storedMaterials) {
        run.materials = storedMaterials.map((m, i) => {
          const mem = (run.materials || [])[i];
          const same = mem && (mem.caption || "") === (m.caption || "") && (mem.mediaName || "") === (m.mediaName || "");
          return {
            ...m,
            mediaDataUrl: m.mediaDataUrl || (same && mem.mediaDataUrl) || null,
            mediaMime: m.mediaMime || (same && mem.mediaMime) || null,
            available: m.available != null ? m.available : (same ? !!mem.available : false)
          };
        });
        await hydrateMaterials(run.materials).catch(async (e) => {
          /* IndexedDB gagal dibaca (mode privasi, kuota, dsb.): JANGAN
             gagalkan batch — blob di memori masih mungkin hidup (worker
             belum restart). Bila dua-duanya kosong, gate media per-langkah
             di bawah yang akan menghentikan sesi total. */
          await log(`Peringatan: gagal membaca penyimpanan media (IndexedDB): ${e.message} — memakai blob di memori bila masih ada.`, "warn");
        });
      }
      /* GATE MEDIA PER-LANGKAH (jangan posting teks diam-diam): antrean butuh
         media tapi blob tidak ketemu di memori MAUPUN IndexedDB -> jangan
         navigasi. stopSession disetel; stop total dijalankan di bawah setelah
         finally (run.busy wajib turun lebih dulu agar stopPosting bersih). */
      const item0 = run.queue[run.cursor];
      const mi0 = item0 && item0.mi != null ? item0.mi : run.cursor;
      const needMedia0 = run.materials[mi0] || null;
      if (needMedia0 && needMedia0.mediaName && !needMedia0.mediaDataUrl) {
        await log(`MEDIA HILANG untuk materi #${mi0 + 1} (${needMedia0.mediaName}): tidak ditemukan di memori maupun IndexedDB — sesi dihentikan sebelum posting jadi teks saja. Muat ulang folder media di dashboard lalu mulai ulang.`, "err");
        stopSession = true;
      }
      if (stopSession) return;
      run.groups = st[STORAGE.GROUPS_SNAPSHOT] && st[STORAGE.GROUPS_SNAPSHOT].length ? st[STORAGE.GROUPS_SNAPSHOT] : run.groups || [];
      run.results = st[STORAGE.GROUP_RESULTS] || run.results || {};
      run.matrix = st[STORAGE.POST_MATRIX] || run.matrix || {};

      if (run.cursor >= run.queue.length) {
        await stopPosting("Antrean selesai. Semua materi telah diposting ke semua grup.");
        return;
      }

      const stats = st[STORAGE.STATS] || {};
      const today = todayKey();
      const todayCount = stats[today] || 0;
      if (todayCount >= run.settings.dailyLimit) {
        await stopPosting(`Batas harian tercapai (${todayCount}/${run.settings.dailyLimit}).`);
        return;
      }

      /* STEP 1-3: navigasi natural SETIAP langkah ke grup TARGET.
         1 materi ke semua grup (klik natural sidebar tiap grup),
         memakai NAV_HOME_TO_COMPOSER + targetGroupUrl. */
      const item = run.queue[run.cursor] || {};
      const mi = typeof item === "object" && item.mi != null ? item.mi : run.cursor;
      const gi = typeof item === "object" && item.gi != null ? item.gi : 0;
      const material = run.materials[mi] || run.materials[0];
      const group = run.groups[gi] || null;
      if (!material) throw new Error("Materi tidak ditemukan di antrean.");
      if (!group || !group.url) throw new Error("Grup target tidak ditemukan di antrean.");
      /* Grup tambahan batch ini (s.d. 9): dikirim ke content script untuk
         dicentang via picker "Tambahkan grup". Urut sesuai tabel.
         Mode satuan (checkbox "Posting Batch" nonaktif): extras selalu
         kosong -> picker tidak pernah dibuka, posting benar-benar
         1 grup 1 submit. */
      const extras = run.batchPost && item && Array.isArray(item.extras)
        ? item.extras
            .map((g) => ({ name: g.name || g.url, url: g.url }))
            .filter((g) => g.url)
        : [];
      /* Mode posting ditentukan SEBELUM tab batch dibuat:
         - autoposting -> postTab (1 tab FB dipakai ulang, kontrak bagian 5);
         - manual -> tab BARU tiap batch via ensureManualPostTab (pool FIFO
           maks LIMITS.MAX_MANUAL_TABS; tab manual tertua ditutup otomatis
           saat pool penuh — tanpa timing khusus, tab tidak pernah numpuk). */
      const autoPost = run.settings.autoPost !== false;
      /* MODE MANUAL WAJIB TAB TERLIHAT: user butuh melihat & mengklik
         tombol Posting sendiri selama jendela 10 detik. Abaikan
         run.showFbTab untuk langkah ini — tab FB selalu diaktifkan +
         difokuskan (mode autoposting tetap menghormati showFbTab).
         Dipaksa SEBELUM tab batch dibuat agar tab manual baru langsung
         aktif & terfokus. */
      if (!autoPost && !run.showFbTab) {
        run.showFbTab = true;
        await log("Mode manual: tab FB difokuskan agar Anda bisa klik Posting sendiri.", "info");
      }
      await log(`Navigasi natural ke grup: ${group.name || group.url}...`, "info");
      const navTab = autoPost
        ? await ensurePostTab(FB_HOME)
        : await ensureManualPostTab(FB_HOME);
      await waitTabLoaded(navTab.id, 45000);
      await ensureContentScript(navTab.id);
      const nav = await sendToContent(navTab.id, { type: MSG.NAV_HOME_TO_COMPOSER, targetGroupUrl: group.url }, 120000);
      if (!nav || !nav.ok || !nav.groupUrl) {
        throw new Error(`Navigasi ke "${group.name}" gagal: ${(nav && nav.error) || "grup tidak ditemukan"}`);
      }
      run.groupUrl = nav.groupUrl;
      run.groupName = nav.groupName || group.name || "(tanpa nama)";
      await log(`Grup target: ${run.groupName} (${run.groupUrl})`, "ok");

      /* STEP 4: posting materi ke grup target.
         run.settings.autoPost = checkbox "autoposting" dashboard:
           true  -> content script klik tombol Posting otomatis.
           false -> content script berhenti setelah media+caption terisi,
                    beri user MANUAL_POST_WINDOW_MS untuk klik Posting
                    sendiri; setelah itu alur lanjut tanpa memedulikan.
         Nilai autoPost sudah dibaca SEBELUM tab batch dibuat (lihat blok
         mode manual vs autoposting sebelum navigasi natural di atas). */
      await log(
        `Memproses materi #${mi + 1} -> ${run.groupName} (${run.cursor + 1}/${run.queue.length}) — mode: ${autoPost ? "autoposting (klik Posting otomatis)" : "manual (jendela " + LIMITS.MANUAL_POST_WINDOW_MS / 1000 + "s untuk klik Posting sendiri)"}${run.batchPost ? ` + ${extras.length} grup tambahan via picker` : " (tanpa grup tambahan)"}`,
        "info",
      );

      /* Pemilihan tab EXECUTE_POST:
         - autoposting -> postTab (1 tab FB dipakai ulang; guard
           sameGroupUrl & kontrak anti-reload tetap berlaku).
         - manual -> pakai tab YANG SAMA dengan navTab batch ini:
           composer yang dibuka NAV_HOME_TO_COMPOSER harus tetap utuh di
           situ. Memanggil jalur postTab kedua di mode manual bisa
           menabrak tab lain dan menghancurkan composer yang menunggu
           klik user. */
      const tab = autoPost ? await ensurePostTab(run.groupUrl) : navTab;
      /* Kontrak: ensurePostTab TIDAK me-reload tab bila sudah di grup target
         (sameGroupUrl) — reload menghancurkan composer modal yang dibuka
         NAV_HOME_TO_COMPOSER. waitTabLoaded di sini hanya jaring pengaman
         (no-op bila tab sudah complete). */
      await waitTabLoaded(tab.id, 45000);
      await ensureContentScript(tab.id);
      const res = await sendToContent(
        tab.id,
        {
          type: MSG.EXECUTE_POST,
          autoPost,
          caption: material.caption || "",
          mediaDataUrl: material.mediaDataUrl || null,
          mediaMime: material.mediaMime || "application/octet-stream",
          mediaName: material.mediaName || "",
          extraGroups: extras,
        },
        LIMITS.EXECUTE_POST_TIMEOUT_MS,
      );

      if (res && res.ok) {
        const statsNow = (await storageGet([STORAGE.STATS]))[STORAGE.STATS] || {};
        /* 1x submit = +1 statistik harian (bukan +jumlah grup). */
        statsNow[today] = (statsNow[today] || 0) + 1;
        await storageSet({ [STORAGE.STATS]: statsNow });
        /* Grup utama: posting pasti terkirim bila res.ok. */
        await markGroup(group.url, true, mi, gi);
        /* Grup tambahan: ✅ bila masuk res.added, ❌ bila masuk res.failed
           (dengan alasan), agar tabel dashboard update per baris. */
        const addedSet = new Set(res.added || []);
        const failedMap = {};
        for (const f of res.failed || []) failedMap[f] = f;
        for (const ex of extras) {
          const exGi = giOf(ex.url);
          if (addedSet.has(ex.url) || addedSet.has(ex.name)) await markGroup(ex.url, true, mi, exGi);
          else if (failedMap[ex.url] || failedMap[ex.name]) await markGroup(ex.url, false, mi, exGi, "Grup tidak ditemukan di picker Tambahkan grup");
          else await markGroup(ex.url, false, mi, exGi, (res && res.error) || "Tidak terkonfirmasi di picker");
        }
        /* Log NAMA grup yang benar-benar tercentang di picker (bukan hanya
           jumlah): addedNames[{url,name,how}] dari content script, fallback
           nama tersimpan. how = exact (case-sensitive) / fuzzy. */
        const nameByUrl = new Map((res.addedNames || []).map((n) => [n.url, n]));
        const checkedList = extras.filter((ex) => addedSet.has(ex.url) || addedSet.has(ex.name))
          .map((ex) => {
            const n = nameByUrl.get(ex.url);
            return `"${(n && n.name) || ex.name}"${n && n.how === "fuzzy" ? " (fuzzy)" : ""}`;
          });
        const failedList = extras.filter((ex) => !(addedSet.has(ex.url) || addedSet.has(ex.name)))
          .map((ex) => `"${ex.name}"`);
        await log(
          `Sukses materi #${mi + 1} di ${run.groupName} — tambahan tercentang (${checkedList.length}/${extras.length}): ${checkedList.join(", ") || "-"}` +
          (failedList.length ? ` — GAGAL centang (${failedList.length}): ${failedList.join(", ")}` : "") +
          `${autoPost ? "" : " — mode manual, hasil klik Posting user tidak diperiksa"}`,
          "ok",
        );
      } else {
        const msg = (res && res.error) || "tidak ada respons";
        if (isSkipSellError(msg)) {
          /* SKIP_SELL_GROUP: grup jual-beli — label + uncheck + lanjut. */
          await handleSkipSellGroup(group, extras.map((ex) => ex.url).filter(Boolean), mi, gi);
        } else {
          /* Batch gagal total: tandai grup utama + semua tambahan ❌. */
          await markGroup(group.url, false, mi, gi, msg);
          for (const ex of extras) await markGroup(ex.url, false, mi, giOf(ex.url), msg);
          await log(`GAGAL materi #${mi + 1} di ${run.groupName}: ${msg} — lanjut batch berikutnya.`, "err");
        }
      }

      /* Opsi C: setelah posting selesai, fokus balik ke dashboard */
      if (run.showFbTab) await focusDashboard();

      run.cursor++;
      await storageSet({ [STORAGE.CURSOR]: run.cursor });
      await broadcastQueueInfo();

      /* ANTREAN HABIS: selesai sekarang, tanpa alarm/jeda tersisa.
         Sebelumnya di sini selalu scheduleNext() -> setelah posting grup
         terakhir masih ada satu jeda acak penuh yang sia-sia sebelum
         alarm fire dan stopPosting dipanggil. */
      if (run.cursor >= run.queue.length) {
        await stopPosting("Antrean selesai. Semua materi telah diposting ke semua grup.");
        return;
      }

      /* Batas harian tercapai tepat setelah posting ini -> berhenti tanpa jeda. */
      const statsAfter = (await storageGet([STORAGE.STATS]))[STORAGE.STATS] || {};
      if ((statsAfter[today] || 0) >= run.settings.dailyLimit) {
        await stopPosting(`Batas harian tercapai (${statsAfter[today]}/${run.settings.dailyLimit}).`);
        return;
      }

      /* Cooldown: setelah N posting istirahat M menit */
      run.postsSinceCooldown = (run.postsSinceCooldown || 0) + 1;
      if (run.postsSinceCooldown >= run.settings.cooldownEvery) {
        run.postsSinceCooldown = 0;
        run.cooldownUntil = Date.now() + run.settings.cooldownMinutes * 60000;
        await log(`Cooldown aktif: istirahat ${run.settings.cooldownMinutes} menit.`, "warn");
      }

      let delayMs;
      if (run.cooldownUntil && Date.now() < run.cooldownUntil) {
        delayMs = run.cooldownUntil - Date.now() + gauss(2000, 600);
      } else {
        delayMs = randInt(run.settings.minDelay, run.settings.maxDelay) * 1000;
      }
      if (run.running) scheduleNext(delayMs);
    } catch (err) {
      /* Gagal navigasi/posting di 1 grup -> tandai ❌, majukan cursor,
         lanjut grup berikutnya (jangan berhenti total). */
      try {
        const item = run.queue[run.cursor] || {};
        const mi = typeof item === "object" && item.mi != null ? item.mi : run.cursor;
        const gi = typeof item === "object" && item.gi != null ? item.gi : 0;
        const group = (run.groups && run.groups[gi]) || null;
        const extras = (item && Array.isArray(item.extras) ? item.extras : []).map((g) => g.url).filter(Boolean);
        const errMsg = (err && err.message) || String(err);
        if (group && group.url && isSkipSellError(errMsg)) {
          /* SKIP_SELL_GROUP: bukan gagal teknis — label + uncheck + lanjut. */
          await handleSkipSellGroup(group, extras, mi, gi);
        } else if (group && group.url) {
          /* Batch gagal total: grup utama + semua tambahan ditandai ❌. */
          await markGroup(group.url, false, mi, gi, errMsg);
          for (const url of extras) await markGroup(url, false, mi, giOf(url), errMsg);
          await log(`GAGAL materi #${mi + 1} di ${group.name}: ${errMsg} — lanjut batch berikutnya.`, "err");
        } else {
          await log(`Error proses posting: ${errMsg}`, "err");
        }
        run.cursor++;
        await storageSet({ [STORAGE.CURSOR]: run.cursor });
        await broadcastQueueInfo();
        /* ANTREAN HABIS setelah batch gagal: berhenti sekarang tanpa jeda. */
        if (run.cursor >= run.queue.length) {
          await stopPosting("Antrean selesai. Semua materi telah diposting ke semua grup.");
          return;
        }
      } catch (e) {
        /* abaikan */
      }
      /* Batch gagal tapi antrean masih ada: jadwalkan batch berikutnya
         SETELAH finally (lihat blok failedBatch di bawah). */
      failedBatch = true;
    } finally {
      run.busy = false;
    }
    /* MEDIA HILANG = STOP TOTAL (keputusan desain: jangan pernah posting
       teks diam-diam). Dijalankan SETELAH finally karena stopPosting
       menolak saat run.busy masih true. Bila blob media wajib tidak ketemu
       di memori maupun IndexedDB (store rusak / dibersihkan eksternal /
       browser dibuka sangat lama), SELURUH SESI dihentikan — bukan lanjut
       tanpa media. */
    if (stopSession) {
      await log("Sesi DIHENTIKAN: media materi tidak tersedia (memori & IndexedDB). Muat ulang folder media di dashboard lalu mulai ulang — sisa antrean tidak diposting agar tidak jadi teks saja.", "err");
      await stopPosting("Sesi dihentikan: media materi tidak tersedia.");
      return;
    }
    /* Lanjut antrean setelah batch gagal (di luar try/catch/finally agar
       penjadwalan berikutnya selalu terjadi dengan state bersih; jalur
       sukses di dalam try menjadwalkan dirinya sendiri via scheduleNext). */
    if (failedBatch && run.running) {
      scheduleNext(randInt(run.settings.minDelay, run.settings.maxDelay) * 1000);
    }
  }

  /* ---------------- UJI JALUR NAVIGASI: HOME -> GRUP -> COMPOSER ----------------
     Dipakai tombol "Uji Buka Composer" di dashboard. Berbeda dari alur posting,
     fungsi ini TIDAK menyentuh antrean/cursor: hanya membuktikan rantai navigasi
     natural (homepage -> sidebar "Grup" -> grup teratas -> composer terbuka)
     berjalan. Karena dipicu manual, tab FB difokuskan selama proses (biar user
     melihat langkahnya), lalu fokus dikembalikan ke dashboard. */
  async function openComposerFromHome() {
    if (run.busy) return { ok: false, error: "Background sedang memproses posting" };
    try {
      const tab = await ensurePostTab(FB_HOME);
      await focusTab(tab.id);
      await waitTabLoaded(tab.id, 45000);
      await ensureContentScript(tab.id);
      const res = await sendToContent(tab.id, { type: MSG.NAV_HOME_TO_COMPOSER }, 120000);
      if (res && res.ok) {
        await log(`Composer terbuka. Grup: ${res.groupName || "(tanpa nama)"} (${res.groupUrl || "-"}).`, "ok");
      } else {
        await log(`Gagal membuka composer: ${(res && res.error) || "tidak ada respons"}`, "err");
      }
      await focusDashboard();
      return res || { ok: false, error: "tidak ada respons" };
    } catch (err) {
      await focusDashboard();
      await log(`Error uji buka composer: ${err.message}`, "err");
      return { ok: false, error: err.message };
    }
  }

  background.scheduler = { ALARM_NAME, startPosting, stopPosting, scheduleNext, processNextPost, getStatus, openComposerFromHome };
})(globalThis);
