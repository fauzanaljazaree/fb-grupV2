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
  const { postToGroup, openComposer } = content.posting;
  const { getAccountName } = content.account;

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
          /* Rantai penuh: homepage -> sidebar "Grup" -> grup TARGET (bila
             msg.targetGroupUrl diisi) atau grup teratas (perilaku lama) ->
             composer terbuka. Timeout trigger lebih longgar karena halaman
             grup baru saja dimuat (SPA) setelah navHomeToGroup(). */
          const info = await navHomeToGroup(msg.targetGroupUrl || null);
          /* Jaring pengaman: pastikan URL tab kanonis /groups/{id} sebelum
             membuka composer (permalink postingan memunculkan kolom
             komentar, bukan trigger "Tulis sesuatu..."). SPA-safe. */
          await content.navigation.ensureCanonicalUrl();
          await openComposer(25000);
          sendResponse({ ok: true, url: location.href, groupUrl: info.groupUrl, groupName: info.groupName });
        } else if (msg.type === MSG.EXECUTE_POST) {
          /* msg.autoPost = checkbox "autoposting" dashboard. false ->
             postToGroup hanya menyiapkan media+caption lalu menunggu
             jendela manual (MANUAL_POST_WINDOW_MS) tanpa klik Posting.
             msg.extraGroups = mode batch (checkbox "Posting Batch");
             kosong di mode satuan (1 grup 1 submit, tanpa picker). */
          const r = await postToGroup(msg.caption, msg.mediaDataUrl, msg.mediaMime, msg.mediaName, msg.autoPost !== false, msg.extraGroups || []);
          sendResponse({
            ok: !!(r && r.ok),
            added: (r && r.added) || [],
            failed: (r && r.failed) || [],
            addedNames: (r && r.addedNames) || [],
            rowsSeen: (r && r.rowsSeen) || 0,
            error: r && r.ok ? null : "Posting gagal",
          });
        } else if (msg.type === MSG.GET_ACCOUNT_NAME) {
          /* Deteksi akun: dipanggil background di TAB DETEKSI SEMENTARA
             (halaman facebook.com). Murni baca DOM + polling internal
             (LIMITS.ACCOUNT_DETECT_*), name null = belum login / belum siap. */
          const name = await getAccountName();
          sendResponse({ ok: true, name: name || null });
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
