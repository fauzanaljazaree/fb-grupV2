/* =========================================================
   FB Auto Poster - Content: Entry Point (content.js)
   Hanya bertugas memasang message router ke background.
   Semua logika ada di modul src/content/*.

   Modul ini adalah file TERAKHIR pada
   manifest.json -> content_scripts[0].js.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const content = (FBAP.content = FBAP.content || {});
  const { MSG } = FBAP.config;
  const { scrapeGroups, scanGroups } = content.scraper;
  const { navHomeToGroup } = content.navigation;
  const { postToGroup, openComposer, testCompose } = content.posting;

  /* Lindungi dari injeksi ganda (manifest + fallback executeScript)
     supaya router tidak terpasang dua kali dan sendResponse tidak
     dipanggil berulang. */
  if (content.routerReady) return;
  content.routerReady = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;
    (async () => {
      try {
        if (msg.type === MSG.EXECUTE_SCRAPE) {
          const groups = await scrapeGroups();
          sendResponse({ ok: true, groups, count: groups.length });
        } else if (msg.type === MSG.SCAN_GROUPS) {
          /* Pola fb-grupV3: scan sidebar /groups/feed/ lalu kirim
             hasil mentah; penggabungan dilakukan background. */
          const result = await scanGroups();
          sendResponse({ ok: true, ...result });
        } else if (msg.type === MSG.NAV_HOME_TO_GROUP) {
          const info = await navHomeToGroup();
          sendResponse({ ok: true, url: location.href, groupUrl: info.groupUrl, groupName: info.groupName });
        } else if (msg.type === MSG.NAV_HOME_TO_COMPOSER) {
          /* Rantai penuh: homepage -> sidebar "Grup" -> grup teratas -> composer
             terbuka. Timeout trigger lebih longgar karena halaman grup baru
             saja dimuat (SPA) setelah navHomeToGroup(). */
          const info = await navHomeToGroup();
          await openComposer(25000);
          sendResponse({ ok: true, url: location.href, groupUrl: info.groupUrl, groupName: info.groupName });
        } else if (msg.type === MSG.EXECUTE_POST) {
          const ok = await postToGroup(msg.caption, msg.mediaDataUrl, msg.mediaMime, msg.mediaName);
          sendResponse({ ok, error: ok ? null : "Posting gagal" });
        } else if (msg.type === MSG.EXECUTE_TEST_POST) {
          /* Uji workflow: composer -> media DULU + GATE -> caption -> stop.
             Tidak pernah klik tombol Posting. */
          const info = await testCompose(msg.caption, msg.mediaDataUrl, msg.mediaMime, msg.mediaName);
          sendResponse({ ok: true, ...info });
        } else if (msg.type === MSG.PING) {
          sendResponse({ ok: true, pong: true });
        } else {
          sendResponse({ ok: false, error: "Perintah tidak dikenali" });
        }
      } catch (err) {
        sendResponse({ ok: false, error: (err && err.message) || String(err) });
      }
    })();
    return true; // async response
  });

  console.log("FB Auto Poster content script siap pada", location.href);
})(globalThis);
