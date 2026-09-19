/* =========================================================
   FB Auto Poster - Background: Manajemen Tab
   Satu tab FB "postTab" biasa (unpinned) dipakai ulang untuk semua
   navigasi & posting; tab dashboard dibedakan tersendiri.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const background = (FBAP.background = FBAP.background || {});
  const { MSG, CONTENT_SCRIPT_FILES } = FBAP.config;
  const { DASH_URL, FB_HOME, run } = background.state;
  const { log } = background.messaging;

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

  /** Pakai ulang tab FB yang ada, atau buat baru (tab biasa, bukan pinned).
      `pinned: false` saat update juga melepas pin pada tab lama yang masih
      pinned dari versi sebelumnya (migrasi otomatis).
      PENTING: bila tab sudah berada di grup target (URL kanonis sama),
      JANGAN navigasi ulang — chrome.tabs.update({url}) me-reload tab dan
      menghancurkan composer modal yang sedang terbuka. Cukup lepas pin,
      fokus bila perlu, lalu pakai tabnya apa adanya. */
  async function ensurePostTab(url) {
    const active = !!run.showFbTab;
    if (run.postTabId) {
      try {
        const cur = await chrome.tabs.get(run.postTabId);
        if (sameGroupUrl(cur && cur.url, url)) {
          await chrome.tabs.update(run.postTabId, { active, pinned: false });
          if (active) await focusTab(run.postTabId);
          return await chrome.tabs.get(run.postTabId);
        }
        await chrome.tabs.update(run.postTabId, { url, active, pinned: false });
        if (active) await focusTab(run.postTabId);
        /* Ambil snapshot TERBARU setelah update, bukan objek lama. */
        return await chrome.tabs.get(run.postTabId);
      } catch (e) {
        run.postTabId = null;
      }
    }
    const tab = await chrome.tabs.create({ url, active, pinned: false });
    run.postTabId = tab.id;
    if (active) await focusTab(run.postTabId);
    return tab;
  }

  /** Tombol "Lihat Tab FB": fokus tab FB bila ada, buat baru bila belum.
      Tab FB yang ditemukan selalu dilepas pin-nya agar jadi tab biasa. */
  async function showFbTab() {
    try {
      if (!run.postTabId) {
        const tabs = await chrome.tabs.query({});
        const fb = tabs.find((t) => t.url && t.url.includes("facebook.com"));
        if (fb) run.postTabId = fb.id;
      }
      if (run.postTabId) {
        await chrome.tabs.update(run.postTabId, { pinned: false }).catch(() => {});
        await focusTab(run.postTabId);
      } else {
        const tab = await chrome.tabs.create({ url: FB_HOME, active: true, pinned: false });
        run.postTabId = tab.id;
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
    sameGroupUrl,
    showFbTab,
  };
})(globalThis);
