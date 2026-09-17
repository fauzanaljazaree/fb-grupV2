/* =========================================================
   FB Auto Poster - Content: Selektor DOM
   Hanya selektor berbasis role/aria (stabil) supaya tidak
   rusak saat Facebook mengganti nama class dinamis.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const content = (FBAP.content = FBAP.content || {});

  /** Halaman sistem /groups/... yang bukan grup milik user. */
  const SYSTEM_GROUP_URL =
    /\/groups\/(feed|create|discover|events|joined|invited|joins|manage|member_requests|members|photos|videos|files|about|search|home|settings)/i;

  /** Menu "Grup" di sidebar kiri halaman utama Facebook. */
  const GRUP_LINK = 'a[role="link"][href*="/groups/?ref=bookmarks"]';

  /** Panel daftar grup di sisi kiri halaman /groups (ID & EN). */
  const SIDEBAR_NAV = 'div[role="navigation"][aria-label*="Daftar Grup"]';
  const SIDEBAR_NAV_EN = 'div[role="navigation"][aria-label*="list"]';

  /** Input file pada dialog composer. */
  const FILE_SELECTOR =
    'input[type="file"][accept*="image"],input[type="file"][accept*="video"],input[type="file"]';

  /** Tombol submit postingan (ID & EN). */
  const POST_BUTTON_SELECTORS = [
    'div[role="button"][aria-label*="Posting"]',
    'div[role="button"][aria-label*="Post"]'
  ];

  content.selectors = {
    SYSTEM_GROUP_URL,
    GRUP_LINK,
    SIDEBAR_NAV,
    SIDEBAR_NAV_EN,
    FILE_SELECTOR,
    POST_BUTTON_SELECTORS
  };
})(globalThis);
