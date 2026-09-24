/* =========================================================
   FB Auto Poster - Background: State Aktif (in-memory)
   Service worker MV3 bisa "tidur", jadi state penting selalu
   dipersist ke chrome.storage.local oleh modul lain.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const background = (FBAP.background = FBAP.background || {});
  const { DEFAULTS, PAGES, STORAGE } = FBAP.config;
  const { get: storageGet, set: storageSet } = FBAP.storage;

  const DASH_URL = chrome.runtime.getURL(PAGES.DASHBOARD);
  const FB_HOME = PAGES.FB_HOME;

  const run = {
    running: false,
    busy: false,
    queue: [],        // [{mi, gi}] pasangan materi x grup (materi-luar, grup-dalam)
    cursor: 0,
    materials: [],
    groups: [],       // [{name, url}] grup terpilih (urutan tabel)
    results: {},      // {groupUrl: {ok, materialIdx, at, error}}
    matrix: {},       // {materialKey: {groupUrl: {ok, mi, gi, at, error}}} — persisten (POST_MATRIX)
    settings: { ...DEFAULTS.settings },
    groupUrl: null,   // grup terakhir dipakai (info saja, bukan cache navigasi)
    groupName: null,
    postTabId: null,
    /* ID tab deteksi akun yang SEDANG berjalan (dibuat & ditutup
       background/account.js). Dipakai findExistingFbTab() sebagai pengecualian
       adopsi: tab deteksi berumur pendek dan PASTI ditutup lagi, jadi tidak
       boleh diadopsi menjadi postTab (posting bisa kehilangan tabnya). */
    detectTabId: null,
    /* Pool tab mode manual (ID array, FIFO maks LIMITS.MAX_MANUAL_TABS).
       Dipersist ke STORAGE.POST_TAB_MANUAL_IDS; diubah HANYA via helper
       rememberManualTabs/restoreManualTabs/ensureManualPostTab di tabs.js. */
    manualTabIds: [],
    dashboardTabId: null,
    /* Default selaras checkbox dashboard "Tampilkan tab FB saat posting"
       (tercentang). Selama sesi berjalan nilainya selalu ditimpa oleh
       startPosting()/SET_VIEW. */
    showFbTab: true,
    postsSinceCooldown: 0,
    cooldownUntil: 0,
    /* Epoch ms (Date.now) posting berikutnya — ditulis scheduleNext,
       dibaca dashboard untuk countdown "X mnt Y dtk". 0 = tak terjadwal.
       Dipersist ke STORAGE.NEXT_POST_AT agar tahan restart SW. */
    nextAt: 0
  };

  /** Pulihkan state dari storage (dipanggil pada onInstalled). */
  async function restoreState() {
    const data = await storageGet([STORAGE.SETTINGS, STORAGE.QUEUE, STORAGE.CURSOR, STORAGE.STATUS]);
    if (!data[STORAGE.SETTINGS]) await storageSet({ [STORAGE.SETTINGS]: DEFAULTS.settings });
    run.settings = { ...DEFAULTS.settings, ...(data[STORAGE.SETTINGS] || {}) };
    run.queue = data[STORAGE.QUEUE] || [];
    run.cursor = data[STORAGE.CURSOR] || 0;
    run.running = !!(data[STORAGE.STATUS] && data[STORAGE.STATUS].running);
    if (!run.running) {
      run.queue = [];
      run.cursor = 0;
      await storageSet({ [STORAGE.QUEUE]: [], [STORAGE.CURSOR]: 0 });
    }
  }

  background.state = { run, DASH_URL, FB_HOME, restoreState };
})(globalThis);
