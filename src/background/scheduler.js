/* =========================================================
   FB Auto Poster - Background: Penjadwal Antrean Posting
   Antrean di-drive oleh chrome.alarms (satu alarm "post-tick"
   per langkah) supaya service worker tetap bisa tidur di
   antara dua posting.

   Alur: startPosting -> scheduleNext -> onAlarm ->
         processNextPost -> scheduleNext (berulang).
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
  const { run, FB_HOME } = background.state;
  const { keepAwakeOn, keepAwakeOff } = background.power;
  const { log, setRunning, broadcastQueueInfo } = background.messaging;
  const { ensurePostTab, waitTabLoaded, ensureContentScript, sendToContent, focusTab, focusDashboard } =
    background.tabs;

  const ALARM_NAME = "post-tick";

  /* ---------------- START / STOP ---------------- */
  async function startPosting(payload) {
    if (run.running) return { ok: false, error: "Posting sudah berjalan" };
    const materialList = (payload && payload.materials) || [];
    const settings = (payload && payload.settings) || {};
    if (!materialList.length) return { ok: false, error: "Tidak ada materi" };

    run.materials = materialList;
    run.settings = { ...DEFAULTS.settings, ...settings };
    run.showFbTab = !!(settings && settings.showFbTab);
    run.queue = materialList.map((_, i) => i);
    run.cursor = 0;
    run.postsSinceCooldown = 0;
    run.cooldownUntil = 0;
    run.groupUrl = null;
    run.groupName = null;
    run.postTabId = null;

    /* PENTING: persist antrean ke storage agar processNextPost (alarm)
       tidak membaca queue kosong dan langsung "Antrean selesai". */
    await storageSet({
      [STORAGE.QUEUE]: run.queue,
      [STORAGE.CURSOR]: 0,
      [STORAGE.MATERIALS]: run.materials,
      [STORAGE.SETTINGS]: run.settings
    });

    keepAwakeOn();
    await setRunning(true);
    await log(`Antrean dibangun: ${run.queue.length} materi. Mode: navigasi natural + input langsung. Tab FB: ${run.showFbTab ? "tampil di depan (fokus)" : "background (tetap di dashboard)"}.`, "info");
    await broadcastQueueInfo();
    /* Posting pertama LANGSUNG (tanpa alarm/jeda) — jeda acak hanya untuk
       antar materi berikutnya (diatur scheduleNext di processNextPost). */
    processNextPost().catch(() => {});
    return { ok: true };
  }

  async function stopPosting(reason) {
    chrome.alarms.clear(ALARM_NAME);
    await setRunning(false);
    keepAwakeOff();
    if (reason) await log(reason, "warn");
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
    if (run.running || run.busy) return { ok: true, running: true };
    const stored = (await storageGet([STORAGE.STATUS]))[STORAGE.STATUS];
    if (!(stored && stored.running)) return { ok: true, running: false };

    /* Sesi lama masih hidup: alarm langkah berikutnya masih terjadwal. */
    if (await alarmExists()) {
      run.running = true;
      keepAwakeOn();
      return { ok: true, running: true };
    }

    /* Sesi basi: tanpa alarm & tanpa proses -> bersihkan supaya tidak terkunci. */
    run.queue = [];
    run.cursor = 0;
    run.groupUrl = null;
    run.groupName = null;
    await storageSet({ [STORAGE.QUEUE]: [], [STORAGE.CURSOR]: 0 });
    await setRunning(false);
    await log("Status \"Berjalan\" warisan sesi lama dibersihkan (tidak ada alarm aktif) — siap memulai posting baru.", "warn");
    return { ok: true, running: false, recovered: true };
  }

  /** Jadwalkan langkah berikutnya (di-clamp agar alarm tetap wajar). */
  function scheduleNext(delayMs) {
    if (!run.running) return;
    const now = Date.now();
    const when = Math.max(
      now + Math.min(delayMs, LIMITS.MAX_ALARM_DELAY_MS),
      now + LIMITS.MIN_ALARM_DELAY_MS
    );
    chrome.alarms.create(ALARM_NAME, { when });
    const sec = Math.round((when - now) / 1000);
    log(`Jeda acak: aksi berikutnya dalam \u00b1${sec}s.`, "info");
  }

  /* ---------------- PROSES SATU LANGKAH ----------------
     Navigasi natural dilakukan sekali (run.groupUrl masih null),
     lalu tiap alarm berikutnya hanya memproses satu materi. */
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
    run.busy = true;
    try {
      const st = await storageGet([
        STORAGE.QUEUE,
        STORAGE.CURSOR,
        STORAGE.SETTINGS,
        STORAGE.MATERIALS,
        STORAGE.STATS
      ]);
      /* FALLBACK: bila storage kosong (mis. alarm fire sebelum persist),
         pakai state in-memory jangan overwrite dengan nilai kosong. */
      run.queue = (st[STORAGE.QUEUE] && st[STORAGE.QUEUE].length) ? st[STORAGE.QUEUE] : (run.queue || []);
      run.cursor = (st[STORAGE.CURSOR] != null) ? st[STORAGE.CURSOR] : run.cursor;
      run.settings = {
        ...DEFAULTS.settings,
        ...((st[STORAGE.SETTINGS] && Object.keys(st[STORAGE.SETTINGS]).length) ? st[STORAGE.SETTINGS] : run.settings)
      };
      run.materials = (st[STORAGE.MATERIALS] && st[STORAGE.MATERIALS].length) ? st[STORAGE.MATERIALS] : (run.materials || []);

      if (run.cursor >= run.queue.length) {
        await stopPosting("Antrean selesai. Semua materi telah diposting.");
        return;
      }

      const stats = st[STORAGE.STATS] || {};
      const today = todayKey();
      const todayCount = stats[today] || 0;
      if (todayCount >= run.settings.dailyLimit) {
        await stopPosting(`Batas harian tercapai (${todayCount}/${run.settings.dailyLimit}).`);
        return;
      }

      /* STEP 1-3: navigasi natural + buka composer (sekali saja).
         Memakai NAV_HOME_TO_COMPOSER — rantai yang sama dengan tombol
         "Uji Buka Composer" (terbukti berhasil di DOM nyata):
         home -> sidebar "Grup" -> grup teratas -> composer terbuka. */
      if (!run.groupUrl) {
        await log("Navigasi natural: home -> Grup -> sidebar -> grup teratas -> composer...", "info");
        const navTab = await ensurePostTab(FB_HOME);
        await waitTabLoaded(navTab.id, 45000);
        await ensureContentScript(navTab.id);
        const nav = await sendToContent(navTab.id, { type: MSG.NAV_HOME_TO_COMPOSER }, 120000);
        if (!nav || !nav.ok || !nav.groupUrl) {
          throw new Error(`Navigasi gagal: ${(nav && nav.error) || "grup tidak ditemukan"}`);
        }
        run.groupUrl = nav.groupUrl;
        run.groupName = nav.groupName || "(tanpa nama)";
        await log(`Grup terpilih otomatis: ${run.groupName} (${run.groupUrl})`, "ok");
      }

      /* STEP 4: posting materi ke grup terpilih */
      const idx = run.queue[run.cursor];
      const material = run.materials[idx] || run.materials[0];
      await log(`Memproses materi #${idx + 1} -> ${run.groupName} (${run.cursor + 1}/${run.queue.length})`, "info");

      const tab = await ensurePostTab(run.groupUrl);
      await waitTabLoaded(tab.id, 45000);
      await ensureContentScript(tab.id);
      const res = await sendToContent(tab.id, {
        type: MSG.EXECUTE_POST,
        caption: material.caption || "",
        mediaDataUrl: material.mediaDataUrl || null,
        mediaMime: material.mediaMime || "application/octet-stream",
        mediaName: material.mediaName || ""
      }, 150000);

      if (res && res.ok) {
        const statsNow = (await storageGet([STORAGE.STATS]))[STORAGE.STATS] || {};
        statsNow[today] = (statsNow[today] || 0) + 1;
        await storageSet({ [STORAGE.STATS]: statsNow });
        await log(`Sukses materi #${idx + 1} di ${run.groupName}`, "ok");
      } else {
        await log(`GAGAL posting di ${run.groupName}: ${(res && res.error) || "tidak ada respons"}`, "err");
      }

      /* Opsi C: setelah posting selesai, fokus balik ke dashboard */
      if (run.showFbTab) await focusDashboard();

      run.cursor++;
      await storageSet({ [STORAGE.CURSOR]: run.cursor });
      await broadcastQueueInfo();

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
      await log(`Error proses posting: ${err.message}`, "err");
      if (run.running) scheduleNext(randInt(run.settings.minDelay, run.settings.maxDelay) * 1000);
    } finally {
      run.busy = false;
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

  /* ---------------- UJI WORKFLOW POST: MEDIA+CAPTION DI COMPOSER ----------------
     Tombol "Uji Post" dashboard. TIDAK menyentuh antrean/cursor: pakai materi
     pertama yang media-nya tersedia dari storage. Rantai: home -> grup ->
     composer (NAV_HOME_TO_COMPOSER, terbukti), lalu EXECUTE_TEST_POST:
     uploadMedia DULU + GATE preview blob -> query editor ulang -> typeCaption
     -> STOP (user klik Posting manual). */
  async function testPostFirstMaterial() {
    if (run.busy) return { ok: false, error: "Background sedang memproses posting" };
    try {
      const st = await storageGet([STORAGE.MATERIALS]);
      const materials = st[STORAGE.MATERIALS] || [];
      const material = materials.find((m) => m.available && m.mediaDataUrl) || materials[0];
      if (!material) return { ok: false, error: "Tidak ada materi. Import Excel + media dulu." };

      await log(`Uji Post: navigasi home -> grup -> composer, lalu media+caption "${material.mediaName || "(tanpa media)"}"...`, "info");
      const tab = await ensurePostTab(FB_HOME);
      await focusTab(tab.id);
      await waitTabLoaded(tab.id, 45000);
      await ensureContentScript(tab.id);
      const nav = await sendToContent(tab.id, { type: MSG.NAV_HOME_TO_COMPOSER }, 120000);
      if (!nav || !nav.ok) {
        throw new Error(`Navigasi gagal: ${(nav && nav.error) || "tidak ada respons"}`);
      }
      const res = await sendToContent(tab.id, {
        type: MSG.EXECUTE_TEST_POST,
        caption: material.caption || "",
        mediaDataUrl: material.available ? material.mediaDataUrl : null,
        mediaMime: material.mediaMime || "application/octet-stream",
        mediaName: material.available ? (material.mediaName || "") : ""
      }, 120000);
      if (res && res.ok) {
        await log(`Uji Post sukses di ${nav.groupName || "(tanpa nama)"}: media ter-lampir (GATE lolos) + caption terisi. TOMBOL POSTING TIDAK DIKLIK — periksa composer.`, "ok");
      } else {
        await log(`Uji Post gagal: ${(res && res.error) || "tidak ada respons"}`, "err");
      }
      await focusDashboard();
      return res || { ok: false, error: "tidak ada respons" };
    } catch (err) {
      await focusDashboard();
      await log(`Error uji post: ${err.message}`, "err");
      return { ok: false, error: err.message };
    }
  }

  background.scheduler = { ALARM_NAME, startPosting, stopPosting, scheduleNext, processNextPost, getStatus, openComposerFromHome, testPostFirstMaterial };
})(globalThis);

