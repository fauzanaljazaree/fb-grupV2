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
      cooldownMinutes: 15,
      autoPost: true,
      /* Posting Batch: true = 1 submit -> s.d. 10 grup via picker
         "Tambahkan grup" (perilaku 1+9); false = 1 grup 1 submit,
         picker tidak pernah dibuka. Default: true (kompatibel lama). */
      batchPost: true
    }
  };

  /* ---------------- HALAMAN & URL ---------------- */
  const PAGES = {
    DASHBOARD: "dashboard.html",
    FB_HOME: "https://www.facebook.com/",
    GROUPS_FEED: "https://www.facebook.com/groups/feed/"
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
    SELECTED_GROUPS: "selectedGroups",
    GROUP_RESULTS: "groupResults",
    POST_MATRIX: "postMatrix",
    GROUPS_SNAPSHOT: "groupsSnapshot",
    /* Tab FB "postTab" yang dipakai ulang antar langkah posting. ID tab
       dipersist agar service worker MV3 yang bangun lagi dari tidur tetap
       menemukan tab lama (bukan membuat tab baru tiap batch). */
    POST_TAB_ID: "postTabId",
    /* Pool tab mode MANUAL (checkbox "autoposting" tidak dicentang): tiap
       batch membuka tab baru yang dibiarkan terbuka untuk klik user. Array
       ID tab dipersist agar service worker yang bangun lagi tetap bisa
       men-evict tab tertua saat pool penuh (FIFO, lihat LIMITS.MAX_MANUAL_TABS). */
    POST_TAB_MANUAL_IDS: "postTabManualIds",
    SCAN_STATUS: "scanStatus",
    LAST_SCAN: "lastScan",
    ACCOUNT_NAME: "accountName",
    /* Label permanen "grup jual-beli": {groupUrl: {at, name}}. Diisi
       background saat content script mendeteksi grup hanya menyediakan
       tombol "Jual sesuatu" (tanpa kolom posting) — grup berlabel
       dilewati di startPosting & di-uncheck otomatis. Dihapus hanya
       via tombol "Hapus label jual-beli" dashboard. */
    SELL_GROUPS: "sellGroups"
  };

  /* ---------------- TIPE PESAN ANTAR KONTEKS ----------------
     Nilai sengaja sama dengan nama kuncinya supaya mudah
     dilacak di DevTools saat chrome.runtime.sendMessage. */
  const MSG = {
    /* background -> dashboard */
    LOG: "LOG",
    STATE: "STATE",
    QUEUE_INFO: "QUEUE_INFO",
    GROUP_RESULT: "GROUP_RESULT",
    /* dashboard -> background */
    START_POSTING: "START_POSTING",
    STOP_POSTING: "STOP_POSTING",
    GET_STATUS: "GET_STATUS",
    SET_VIEW: "SET_VIEW",
    VIEW_FB_TAB: "VIEW_FB_TAB",
    BACK_TO_DASHBOARD: "BACK_TO_DASHBOARD",
    OPEN_COMPOSER: "OPEN_COMPOSER",
    /* dashboard -> background: deteksi nama akun FB yang sedang login
       (background membuka tab deteksi sementara lalu menutupnya kembali).
       Tipe yang sama dipakai background -> content script untuk membaca
       DOM Facebook (lihat src/background/account.js & src/content/account.js). */
    GET_ACCOUNT_NAME: "GET_ACCOUNT_NAME",
    /* dashboard -> background: mulai scan daftar grup (tab sementara) */
    START_SCAN: "START_SCAN",
    /* background -> content script: jalankan scanGroups() di sidebar */
    SCAN_GROUPS: "SCAN_GROUPS",
    /* background -> content script */
    PING: "PING",
    EXECUTE_SCRAPE: "EXECUTE_SCRAPE",
    NAV_HOME_TO_GROUP: "NAV_HOME_TO_GROUP",
    NAV_HOME_TO_COMPOSER: "NAV_HOME_TO_COMPOSER",
    EXECUTE_POST: "EXECUTE_POST",
    /* background -> dashboard: 1 grup baru terdeteksi jual-beli (tanpa
       kolom posting) -> dashboard meng-uncheck barisnya realtime */
    SELL_GROUP_MARKED: "SELL_GROUP_MARKED"
  };

  /* ---------------- BATAS OPERASIONAL ---------------- */
  const LIMITS = {
    MAX_LOG_ENTRIES: 500,                 /* baris log terakhir yang disimpan */
    MAX_ALARM_DELAY_MS: 12 * 3600 * 1000, /* jeda maksimum satu alarm */
    MIN_ALARM_DELAY_MS: 5000,
    /* Scan daftar grup (START_SCAN) */
    SCAN_TAB_TIMEOUT_MS: 90000,           /* tunggu tab /groups/feed "complete" */
    SCAN_SETTLE_MS: 2000,                 /* jeda render React FB sebelum scan */
    SCAN_MAX_PASSES: 80,                  /* batas loop scroll sidebar */
    SCAN_MSG_TIMEOUT_MS: 120000,          /* timeout chrome.tabs.sendMessage scan */
    /* Deteksi akun FB yang sedang login (dashboard -> background):
       tab deteksi SEMENTARA (active:false, selalu ditutup lagi).
       - ACCOUNT_TAB_TIMEOUT_MS : tunggu tab FB berstatus "complete"
       - ACCOUNT_SETTLE_MS      : jeda render React FB sebelum baca DOM
       - ACCOUNT_MSG_TIMEOUT_MS : timeout GET_ACCOUNT_NAME ke content script
         (polling di content s.d. TRIES x INTERVAL = 10s, jadi timeout ini
         harus lebih longgar dari itu)
       - ACCOUNT_DETECT_TRIES/_INTERVAL_MS : polling DOM di content script */
    ACCOUNT_TAB_TIMEOUT_MS: 60000,
    ACCOUNT_SETTLE_MS: 1200,
    ACCOUNT_MSG_TIMEOUT_MS: 30000,
    ACCOUNT_DETECT_TRIES: 20,
    ACCOUNT_DETECT_INTERVAL_MS: 500,
    /* Mode manual (checkbox "autoposting" TIDAK dicentang): jendela waktu
       bagi user untuk klik tombol Posting sendiri sebelum alur lanjut. */
    MANUAL_POST_WINDOW_MS: 10000,
    /* Tambahan grup via picker "Tambahkan grup" composer: FB membatasi
       "Posting hingga ke 9 grup yang ada Anda di dalamnya" per submit. */
    EXTRA_GROUPS_PER_POST: 9,
    /* Timeout EXECUTE_POST naik: batch 1+9 butuh 9x (search + centang)
       di picker + verifikasi caption setelah re-render Lexical. */
    EXECUTE_POST_TIMEOUT_MS: 240000,
    /* Picker "Tambahkan grup": tunggu dialog + kolom search.
       SEARCH-FIRST (user): ketik nama grup KARAKTER-PER-KARAKTER di kolom
       "Cari grup" (set-value sekaligus tidak memicu filter React).
       Fallback enumerasi baris + scroll lazy-render. */
    ADD_GROUPS_TIMEOUT_MS: 15000,
    PICKER_SEARCH_TIMEOUT_MS: 8000,
    PICKER_SCROLL_PASSES: 15,
    PICKER_STUCK_LIMIT: 3,
    /* Mode manual (autoposting tidak dicentang): jumlah maksimum tab FB yang
       dibiarkan terbuka untuk klik user. Batch manual baru menutup tab manual
       TERTUA milik sesi saat pool penuh (FIFO, tanpa timing khusus). Tab
       autoposting tidak termasuk pool ini (1 tab reuse terpisah). */
    MAX_MANUAL_TABS: 3
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
    "src/content/account.js",
    "src/content/content.js"
  ];

  FBAP.config = { DEFAULTS, PAGES, STORAGE, MSG, LIMITS, CONTENT_SCRIPT_FILES };
})(globalThis);
