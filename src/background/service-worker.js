/* =========================================================
   FB Auto Poster - Background: Entry Point (service worker)
   File ini HANYA memuat modul lalu memasang listener chrome.*.
   Tidak ada logika bisnis di sini.

   MV3 classic worker -> memakai importScripts (bukan ESM) agar
   util yang sama bisa dipakai juga oleh content script &
   dashboard yang tidak mendukung import.

   Alur singkat:
   dashboard --START_POSTING--> scheduler --EXECUTE_POST-->
   content script (tab FB) -> hasil dikirim balik sebagai log.
   ========================================================= */

"use strict";

importScripts(
  "../shared/config.js",
  "../shared/random.js",
  "../shared/time.js",
  "../shared/storage.js",
  "state.js",
  "power.js",
  "messaging.js",
  "tabs.js",
  "scan.js",
  "scheduler.js"
);

(function () {
  const FBAP = globalThis.FBAP;
  const { MSG, STORAGE } = FBAP.config;
  const { set: storageSet } = FBAP.storage;

  const { run, restoreState } = FBAP.background.state;
  const { keepAwakeOn } = FBAP.background.power;
  const { startPosting, stopPosting, processNextPost, getStatus, openComposerFromHome, ALARM_NAME } = FBAP.background.scheduler;
  const { openDashboard, focusDashboard, showFbTab } = FBAP.background.tabs;
  const { runScan, isScanActive } = FBAP.background.scan;

  /* =========================================================
     MESSAGE ROUTER (dari dashboard)
     ========================================================= */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;
    (async () => {
      switch (msg.type) {
        case MSG.START_POSTING:
          if (sender.tab && sender.tab.id) run.dashboardTabId = sender.tab.id;
          sendResponse(await startPosting(msg.payload));
          break;
        case MSG.STOP_POSTING:
          await stopPosting();
          sendResponse({ ok: true });
          break;
        case MSG.GET_STATUS:
          /* Status dihitung dari memori + alarm (bukan hanya kunci storage)
             agar tombol "Mulai Posting" tidak terkunci status basi. */
          sendResponse(await getStatus());
          break;
        case MSG.SET_VIEW:
          run.showFbTab = !!msg.showFbTab;
          if (sender.tab && sender.tab.id) run.dashboardTabId = sender.tab.id;
          await storageSet({ [STORAGE.UI]: { showFbTab: run.showFbTab } });
          sendResponse({ ok: true, showFbTab: run.showFbTab });
          break;
        case MSG.VIEW_FB_TAB:
          if (sender.tab && sender.tab.id) run.dashboardTabId = sender.tab.id;
          sendResponse(await showFbTab());
          break;
        case MSG.OPEN_COMPOSER:
          if (sender.tab && sender.tab.id) run.dashboardTabId = sender.tab.id;
          sendResponse(await openComposerFromHome());
          break;
        case MSG.START_SCAN:
          /* Guard anti-dobel: tolak bila scan masih aktif. runScan
             fire-and-forget — hasil dibaca dashboard via storage.onChanged. */
          if (sender.tab && sender.tab.id) run.dashboardTabId = sender.tab.id;
          if (await isScanActive()) {
            sendResponse({ ok: false, accepted: false, error: "Scan sedang berjalan." });
            break;
          }
          runScan().catch(() => {});
          sendResponse({ ok: true, accepted: true });
          break;
        case MSG.BACK_TO_DASHBOARD:
          if (sender.tab && sender.tab.id) run.dashboardTabId = sender.tab.id;
          await focusDashboard();
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: "Unknown message" });
      }
    })();
    return true;
  });

  /* =========================================================
     EVENT chrome.*
     ========================================================= */
  chrome.action.onClicked.addListener(() => {
    openDashboard().catch(() => {});
  });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_NAME) {
      await processNextPost();
    }
  });

  chrome.runtime.onInstalled.addListener(async () => {
    keepAwakeOn();
    await restoreState();
  });

  keepAwakeOn();
  console.log("FB Auto Poster background active (direct-input mode).");
})();
