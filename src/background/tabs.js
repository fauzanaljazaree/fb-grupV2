/* =========================================================
   FB Auto Poster - Background: Manajemen Tab
   Satu tab FB "postTab" biasa (unpinned) dipakai ulang untuk semua
   navigasi & posting; tab dashboard dibedakan tersendiri.

   ID postTab dipersist ke chrome.storage.local (STORAGE.POST_TAB_ID)
   supaya service worker MV3 yang bangun lagi dari tidur tetap memakai
   ulang tab lama — bukan membuat tab baru tiap batch (bug "tab FB
   menumpuk satu per satu postingan"). Bila ID basi (tab ditutup user),
   tab FB facebook.com yang sudah terbuka diadopsi sebelum membuat baru;
   saat create terpaksa perlu, tab lama milik sesi ditutup.

   MODE MANUAL (checkbox "autoposting" tidak dicentang) memakai pool
   terpisah: tiap batch tabs.create BARU via ensureManualPostTab, ID masuk
   STORAGE.POST_TAB_MANUAL_IDS (FIFO maks LIMITS.MAX_MANUAL_TABS = 3);
   tab manual tertua ditutup otomatis saat pool penuh (tanpa timing
   khusus, tanpa tab menumpuk). findExistingFbTab mengecualikan pool ini —
   postTab tidak boleh membajak composer manual yang masih menunggu klik.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const background = (FBAP.background = FBAP.background || {});
  const { MSG, STORAGE, LIMITS, CONTENT_SCRIPT_FILES } = FBAP.config;
  const { get: storageGet, set: storageSet } = FBAP.storage;
  const { DASH_URL, FB_HOME, run } = background.state;
  const { log } = background.messaging;

  /* ---------------- PERSIST ID TAB POSTING ----------------
     Sumber kebenaran tunggal ID postTab: tulis selalu lewat
     rememberPostTab (memori + storage), hapus lewat forgetPostTab.
     Tulis best-effort: kegagalan storage tidak boleh menggagalkan
     navigasi posting (sesuai kontrak storage.set yang tak pernah reject). */
  async function rememberPostTab(tabId) {
    run.postTabId = tabId || null;
    try {
      await storageSet({ [STORAGE.POST_TAB_ID]: run.postTabId });
    } catch (e) {}
  }

  async function forgetPostTab() {
    await rememberPostTab(null);
  }

  /** Pulihkan ID postTab dari storage (dipanggil scheduler saat worker MV3
      bangun dari tidur dengan memori kosong). Bila ID basi / tidak ada,
      dibiarkan null — ensurePostTab akan mengadopsi tab FB eksisting atau
      membuat baru. */
  async function restorePostTab() {
    if (run.postTabId) return run.postTabId;
    try {
      const saved = (await storageGet([STORAGE.POST_TAB_ID]))[STORAGE.POST_TAB_ID];
      if (saved) run.postTabId = saved;
    } catch (e) {}
    return run.postTabId;
  }

  /* ---------------- POOL TAB MODE MANUAL ----------------
     Mode manual (autoposting TIDAK dicentang): tiap batch membuka tab BARU
     yang dibiarkan terbuka agar user punya waktu klik Posting sendiri.
     ID-nya dipersist ke STORAGE.POST_TAB_MANUAL_IDS (array FIFO) dengan
     batas LIMITS.MAX_MANUAL_TABS: saat pool penuh, tab manual TERTUA milik
     sesi ditutup otomatis SEBELUM tab baru dibuka — tanpa timing khusus,
     tanpa tab menumpuk, tanpa deteksi klik user (mustahil dilakukan
     background: EXECUTE_POST manual selalu membalas ok tanpa verifikasi).
     Tab autoposting (postTab) TIDAK termasuk pool & tidak pernah ditutup
     oleh mekanisme ini. */
  async function rememberManualTabs() {
    try {
      await storageSet({ [STORAGE.POST_TAB_MANUAL_IDS]: run.manualTabIds.slice() });
    } catch (e) {}
  }

  /** Pulihkan pool tab manual dari storage bila memori kosong (worker MV3
      bangun dari tidur) — dipanggil sebelum pool dipakai/difilter. */
  async function restoreManualTabs() {
    if (run.manualTabIds && run.manualTabIds.length) return run.manualTabIds;
    try {
      const saved = (await storageGet([STORAGE.POST_TAB_MANUAL_IDS]))[STORAGE.POST_TAB_MANUAL_IDS];
      if (Array.isArray(saved) && saved.length) run.manualTabIds = saved.slice();
    } catch (e) {}
    return run.manualTabIds;
  }

  /** Batch manual: buka tab BARU di `url` (SELALU create — tidak reuse,
      tidak adopsi), setelah membuang ID basi dan menutup tab manual
      TERTUA bila pool penuh (FIFO maks LIMITS.MAX_MANUAL_TABS). Tab baru
      mengikuti run.showFbTab (scheduler memaksa showFbTab=true sebelum
      dipanggil, sehingga tab manual baru selalu aktif & terfokus). */
  async function ensureManualPostTab(url) {
    const active = !!run.showFbTab;
    await restoreManualTabs();
    /* Buang ID basi (tab sudah ditutup user) supaya eviction hanya
       menyentuh tab yang benar-benar masih hidup. */
    const alive = [];
    for (const id of run.manualTabIds || []) {
      try {
        await chrome.tabs.get(id);
        alive.push(id);
      } catch (e) {}
    }
    run.manualTabIds = alive;
    /* FIFO: pool penuh -> tutup tab manual TERTUA milik sesi lebih dulu. */
    while (run.manualTabIds.length >= LIMITS.MAX_MANUAL_TABS) {
      const oldest = run.manualTabIds.shift();
      try { await chrome.tabs.remove(oldest); } catch (e) {}
    }
    const tab = await chrome.tabs.create({ url, active, pinned: false });
    run.manualTabIds.push(tab.id);
    await rememberManualTabs();
    if (active) await focusTab(tab.id);
    return tab;
  }

  /* ---------------- FOKUS TAB ---------------- */
  async function focusTab(tabId) {
    try {
      if (tabId) await chrome.tabs.update(tabId, { active: true });
    } catch (e) {}
  }

  async function focusDashboard() {
    try {
      if (run.dashboardTabId) await chrome.tabs.update(run.dashboardTabId, { active: true });
    } catch (e) {}
  }

  /* ---------------- TAB DASHBOARD ---------------- */
  async function openDashboard() {
    const tabs = await chrome.tabs.query({});
    const existing = tabs.find((t) => t.url && t.url.startsWith(DASH_URL));
    if (existing) {
      try {
        await chrome.tabs.remove(existing.id);
      } catch (e) {}
    }
    await chrome.tabs.create({ url: DASH_URL, pinned: true, active: true });
  }

  /* ---------------- TAB FACEBOOK ---------------- */
  function waitTabLoaded(tabId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      let done = false;
      const listener = (id, info) => {
        if (done || id !== tabId) return;
        /* PENTING: saat status "complete", event onUpdated TIDAK selalu
           membawa field `url` (url hanya ada saat URL berubah). Jadi jangan
           andalkan info.url — verifikasi URL via chrome.tabs.get. */
        if (info.status !== "complete") return;
        chrome.tabs
          .get(tabId)
          .then((t) => {
            if (done) return;
            if (t && t.url && t.url.includes("facebook.com")) finish(true);
          })
          .catch(() => {});
      };

      function finish(ok) {
        if (done) return;
        done = true;
        chrome.tabs.onUpdated.removeListener(listener);
        clearInterval(pollTimer);
        clearTimeout(timer);
        /* Jeda kecil agar render/DOM stabil sebelum content script dieksekusi. */
        setTimeout(() => (ok ? resolve() : reject(new Error("Timeout menunggu halaman dimuat"))), 1500);
      }

      const timer = setTimeout(() => finish(false), timeoutMs);

      /* FALLBACK polling: onUpdated bisa terlewat (mis. service worker
         tidur / navigasi sama-origin SPA). Cek kondisi tab tiap 500ms. */
      const pollTimer = setInterval(() => {
        if (done) return;
        chrome.tabs
          .get(tabId)
          .then((t) => {
            if (done) return;
            if (t && t.status === "complete" && t.url && t.url.includes("facebook.com")) finish(true);
          })
          .catch(() => finish(false));
      }, 500);

      chrome.tabs.onUpdated.addListener(listener);

      /* Cek awal: bila tab sudah complete, selesai tanpa menunggu event. */
      chrome.tabs
        .get(tabId)
        .then((t) => {
          if (!done && t && t.status === "complete" && t.url && t.url.includes("facebook.com")) finish(true);
        })
        .catch(() => {});
    });
  }

  /* Fallback inject content script bila belum terpasang di tab tsb */
  async function ensureContentScript(tabId) {
    const pong = await sendToContent(tabId, { type: MSG.PING }, 3000);
    if (pong && pong.ok) return true;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES });
      await new Promise((r) => setTimeout(r, 800));
      return true;
    } catch (e) {
      await log(`Gagal inject content script ke tab ${tabId}: ${e.message}`, "err");
      return false;
    }
  }

  function sendToContent(tabId, msg, timeoutMs = 60000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ ok: false, error: "Timeout menunggu content script" });
      }, timeoutMs);
      try {
        chrome.tabs.sendMessage(tabId, msg, (resp) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { ok: false, error: "Respons kosong" });
          }
        });
      } catch (err) {
        clearTimeout(timer);
        resolve({ ok: false, error: err.message });
      }
    });
  }

  /** Bandingkan dua URL ke format kanonis /groups/{id} (slug ATAU numerik).
      Strip query/hash/trailing slash; hanya hostname facebook.com.
      Kembalikan false bila salah satu bukan URL grup valid — dalam hal
      keraguan, pemanggil harus memilih perilaku lama (tetap navigasi). */
  function sameGroupUrl(a, b) {
    const canon = (u) => {
      const raw = (u || "").trim();
      if (!raw) return "";
      let path = "";
      try {
        if (/^https?:\/\//i.test(raw)) {
          const p = new URL(raw);
          if (!/(^|\.)facebook\.com$/i.test(p.hostname)) return "";
          path = p.pathname || "";
        } else if (raw.startsWith("/")) {
          path = raw;
        } else return "";
      } catch (e) {
        return "";
      }
      const m = path
        .split("?")[0]
        .split("#")[0]
        .match(/^\/groups\/([A-Za-z0-9._-]+)\/?$/);
      if (!m) {
        const m2 = path.match(/^\/groups\/([A-Za-z0-9._-]+)\//);
        return m2 ? m2[1] : "";
      }
      return m[1];
    };
    const ca = canon(a);
    const cb = canon(b);
    return !!ca && !!cb && ca === cb;
  }

  /** Cari tab facebook.com yang sudah terbuka (di window mana pun), kandidat
      untuk diadopsi jadi postTab bila ID tersimpan basi. Dashboard tab ikut
      ter-query karena startswith(DASH_URL); difilter di sini. Tab yang masuk
      pool manual JANGAN diadopsi — composer manual yang menunggu klik user
      tidak boleh dibajak/di-navigasi-ulang oleh mode autoposting. Tab deteksi
      akun (`run.detectTabId`) juga dikecualikan karena tab itu berumur pendek
      dan SELALU ditutup `background/account.js` — kalau diadopsi, tab posting
      yang sedang dipakai bisa ikut tertutup. */
  async function findExistingFbTab() {
    try {
      await restoreManualTabs();
      const manualIds = new Set(run.manualTabIds || []);
      const tabs = await chrome.tabs.query({});
      return (
        tabs.find(
          (t) =>
            t &&
            t.url &&
            t.url.includes("facebook.com") &&
            !t.url.startsWith(DASH_URL) &&
            !manualIds.has(t.id) &&
            t.id !== run.detectTabId,
        ) || null
      );
    } catch (e) {
      return null;
    }
  }

  /** Pakai ulang tab FB yang ada, atau buat baru (tab biasa, bukan pinned).
      `pinned: false` saat update juga melepas pin pada tab lama yang masih
      pinned dari versi sebelumnya (migrasi otomatis).
      PENTING: bila tab sudah berada di grup target (URL kanonis sama),
      JANGAN navigasi ulang — chrome.tabs.update({url}) me-reload tab dan
      menghancurkan composer modal yang sedang terbuka. Cukup lepas pin,
      fokus bila perlu, lalu pakai tabnya apa adanya.
      ANTI-TAB-NUMPUK: ID postTab dipersist (STORAGE.POST_TAB_ID) agar tetap
      dikenal walau service worker MV3 tidur/bangun di antara alarm. Bila ID
      basi, tab FB yang sudah terbuka diadopsi dulu sebelum membuat tab baru;
      create terpaksa perlu menutup tab lama milik sesi agar tidak menumpuk. */
  async function ensurePostTab(url) {
    const active = !!run.showFbTab;
    let prevTabId = run.postTabId || null;
    if (prevTabId) {
      try {
        const cur = await chrome.tabs.get(prevTabId);
        if (sameGroupUrl(cur && cur.url, url)) {
          await chrome.tabs.update(prevTabId, { active, pinned: false });
          if (active) await focusTab(prevTabId);
          return await chrome.tabs.get(prevTabId);
        }
        await chrome.tabs.update(prevTabId, { url, active, pinned: false });
        if (active) await focusTab(prevTabId);
        /* Ambil snapshot TERBARU setelah update, bukan objek lama. */
        return await chrome.tabs.get(prevTabId);
      } catch (e) {
        /* ID basi (tab ditutup user / worker restart): lepas dari memori,
           lanjut adopsi/create di bawah. */
        prevTabId = null;
        await forgetPostTab();
      }
    }
    /* Adopsi tab FB yang sudah terbuka — tidak membuat tab baru bila tidak perlu. */
    const existing = await findExistingFbTab();
    if (existing && existing.id != null) {
      try {
        if (sameGroupUrl(existing.url, url)) {
          await chrome.tabs.update(existing.id, { active, pinned: false });
          if (active) await focusTab(existing.id);
          await rememberPostTab(existing.id);
          return await chrome.tabs.get(existing.id);
        }
        await chrome.tabs.update(existing.id, { url, active, pinned: false });
        if (active) await focusTab(existing.id);
        await rememberPostTab(existing.id);
        return await chrome.tabs.get(existing.id);
      } catch (e) {
        /* Adopsi gagal (tab ditutup di tengah jalan): jatuh ke create di bawah. */
      }
    }
    /* Bila adopsi gagal (tab lama tertutup di tengah jalan), tutup tab lama
       milik sesi sebelum membuat baru — supaya sesi panjang tidak meninggalkan
       tab FB lama satu per satu batch. */
    if (existing && existing.id != null) {
      try { await chrome.tabs.remove(existing.id); } catch (e) {}
    }
    const tab = await chrome.tabs.create({ url, active, pinned: false });
    await rememberPostTab(tab.id);
    if (active) await focusTab(tab.id);
    return tab;
  }

  /** Tombol "Lihat Tab FB": fokus tab FB bila ada, buat baru bila belum.
      Tab FB yang ditemukan selalu dilepas pin-nya agar jadi tab biasa.
      Selaras dengan ensurePostTab: tab FB yang diadopsi tercatat sebagai
      postTab (memori + storage) agar pemakaian-ulang konsisten. */
  async function showFbTab() {
    try {
      if (!run.postTabId) await restorePostTab();
      if (run.postTabId) {
        const known = await chrome.tabs.get(run.postTabId).catch(() => null);
        if (!known) await forgetPostTab();
      }
      if (!run.postTabId) {
        const fb = await findExistingFbTab();
        if (fb) await rememberPostTab(fb.id);
      }
      if (run.postTabId) {
        await chrome.tabs.update(run.postTabId, { pinned: false }).catch(() => {});
        await focusTab(run.postTabId);
      } else {
        const tab = await chrome.tabs.create({ url: FB_HOME, active: true, pinned: false });
        await rememberPostTab(tab.id);
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  background.tabs = {
    focusTab,
    focusDashboard,
    openDashboard,
    waitTabLoaded,
    ensureContentScript,
    sendToContent,
    ensurePostTab,
    rememberPostTab,
    restorePostTab,
    forgetPostTab,
    ensureManualPostTab,
    restoreManualTabs,
    sameGroupUrl,
    showFbTab,
  };
})(globalThis);
