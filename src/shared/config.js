/* =========================================================
   FB Auto Poster - Shared: Konfigurasi & Konstanta
   Dimuat paling awal di SETIAP konteks (service worker,
   content script, dashboard). Tidak boleh bergantung pada
   modul lain.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});

  /* ---------------- NILAI DEFAULT PENGATURAN ANTI-BOT ---------------- */
  const DEFAULTS = {
    settings: {
      minDelay: 180,
      maxDelay: 300,
      dailyLimit: 20,
      cooldownEvery: 5,
      cooldownMinutes: 15
    }
  };

  /* ---------------- HALAMAN & URL ---------------- */
  const PAGES = {
    DASHBOARD: "dashboard.html",
    FB_HOME: "https://www.facebook.com/"
  };

  /* ---------------- KUNCI chrome.storage.local ----------------
     Dipusatkan agar tidak ada typo antar modul. */
  const STORAGE = {
    SETTINGS: "settings",
    QUEUE: "queue",
    CURSOR: "cursor",
    MATERIALS: "materials",
    STATS: "stats",
    STATUS: "status",
    UI: "ui",
    POSTING_LOGS: "postingLogs",
    GROUPS: "groups",
    SELECTED_GROUPS: "selectedGroups"
  };

  /* ---------------- TIPE PESAN ANTAR KONTEKS ----------------
     Nilai sengaja sama dengan nama kuncinya supaya mudah
     dilacak di DevTools saat chrome.runtime.sendMessage. */
  const MSG = {
    /* background -> dashboard */
    LOG: "LOG",
    STATE: "STATE",
    QUEUE_INFO: "QUEUE_INFO",
    /* dashboard -> background */
    START_POSTING: "START_POSTING",
    STOP_POSTING: "STOP_POSTING",
    GET_STATUS: "GET_STATUS",
    SET_VIEW: "SET_VIEW",
    VIEW_FB_TAB: "VIEW_FB_TAB",
    BACK_TO_DASHBOARD: "BACK_TO_DASHBOARD",
    /* background -> content script */
    PING: "PING",
    EXECUTE_SCRAPE: "EXECUTE_SCRAPE",
    NAV_HOME_TO_GROUP: "NAV_HOME_TO_GROUP",
    EXECUTE_POST: "EXECUTE_POST"
  };

  /* ---------------- BATAS OPERASIONAL ---------------- */
  const LIMITS = {
    MAX_LOG_ENTRIES: 500,                 /* baris log terakhir yang disimpan */
    MAX_ALARM_DELAY_MS: 12 * 3600 * 1000, /* jeda maksimum satu alarm */
    MIN_ALARM_DELAY_MS: 5000
  };

  /* ---------------- DAFTAR FILE CONTENT SCRIPT ----------------
     URUTAN PENTING: konfigurasi -> util -> modul -> entry.
     Dipakai background sebagai fallback chrome.scripting.executeScript.
     WAJIB identik & seurutan dengan manifest.json ->
     content_scripts[0].js (dijaga otomatis oleh tools/verify.js). */
  const CONTENT_SCRIPT_FILES = [
    "src/shared/config.js",
    "src/shared/random.js",
    "src/shared/time.js",
    "src/shared/spintax.js",
    "src/content/selectors.js",
    "src/content/dom.js",
    "src/content/stealth.js",
    "src/content/media.js",
    "src/content/navigation.js",
    "src/content/scraper.js",
    "src/content/posting.js",
    "src/content/content.js"
  ];

  FBAP.config = { DEFAULTS, PAGES, STORAGE, MSG, LIMITS, CONTENT_SCRIPT_FILES };
})(globalThis);
