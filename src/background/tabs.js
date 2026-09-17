/* =========================================================
   FB Auto Poster - Background: Manajemen Tab
   Satu tab FB "postTab" dipakai ulang (pinned) untuk semua
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
    try { if (tabId) await chrome.tabs.update(tabId, { active: true }); } catch (e) { }
  }

  async function focusDashboard() {
    try { if (run.dashboardTabId) await chrome.tabs.update(run.dashboardTabId, { active: true }); } catch (e) { }
  }

  /* ---------------- TAB DASHBOARD ---------------- */
  async function openDashboard() {
    const tabs = await chrome.tabs.query({});
    const existing = tabs.find((t) => t.url && t.url.startsWith(DASH_URL));
    if (existing) {
      try { await chrome.tabs.remove(existing.id); } catch (e) { }
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
        chrome.tabs.get(tabId).then((t) => {
          if (done) return;
          if (t && t.url && t.url.includes("facebook.com")) finish(true);
        }).catch(() => {});
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
        chrome.tabs.get(tabId).then((t) => {
          if (done) return;
          if (t && t.status === "complete" && t.url && t.url.includes("facebook.com")) finish(true);
        }).catch(() => finish(false));
      }, 500);

      chrome.tabs.onUpdated.addListener(listener);

      /* Cek awal: bila tab sudah complete, selesai tanpa menunggu event. */
      chrome.tabs.get(tabId).then((t) => {
        if (!done && t && t.status === "complete" && t.url && t.url.includes("facebook.com")) finish(true);
      }).catch(() => {});
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

  /** Pakai ulang tab FB yang ada, atau buat baru (pinned). */
  async function ensurePostTab(url) {
    const active = !!run.showFbTab;
    if (run.postTabId) {
      try {
        await chrome.tabs.get(run.postTabId);
        await chrome.tabs.update(run.postTabId, { url, active, pinned: true });
        if (active) await focusTab(run.postTabId);
        /* Ambil snapshot TERBARU setelah update, bukan objek lama. */
        return await chrome.tabs.get(run.postTabId);
      } catch (e) { run.postTabId = null; }
    }
    const tab = await chrome.tabs.create({ url, active, pinned: true });
    run.postTabId = tab.id;
    if (active) await focusTab(run.postTabId);
    return tab;
  }

  /** Tombol "Lihat Tab FB": fokus tab FB bila ada, buat baru bila belum. */
  async function showFbTab() {
    try {
      if (!run.postTabId) {
        const tabs = await chrome.tabs.query({});
        const fb = tabs.find((t) => t.url && t.url.includes("facebook.com"));
        if (fb) run.postTabId = fb.id;
      }
      if (run.postTabId) {
        await focusTab(run.postTabId);
      } else {
        const tab = await chrome.tabs.create({ url: FB_HOME, active: true, pinned: true });
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
    showFbTab
  };
})(globalThis);
