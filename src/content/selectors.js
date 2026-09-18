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

  /* ---------------- SELEKTOR COMPOSER (workflow uji media+caption) ----------------
     HANYA aria-label/role/placeholder — JANGAN class dinamis FB (x9f619 dst). */
  const COMPOSER_TRIGGER_TEXT = "Tulis sesuatu...";
  const CAPTION_EDITOR =
    'div[contenteditable="true"][role="textbox"][aria-placeholder="Buat postingan publik..."]';
  const CAPTION_EDITOR_LOOSE = 'div[contenteditable="true"][role="textbox"]';
  const FILE_INPUT = 'input[type="file"]';
  const COMPOSER_DIALOG_LABELED = 'div[role="dialog"][aria-label="Buat postingan"]';

  content.selectors = {
    SYSTEM_GROUP_URL,
    GRUP_LINK,
    SIDEBAR_NAV,
    SIDEBAR_NAV_EN,
    FILE_SELECTOR,
    POST_BUTTON_SELECTORS,
    COMPOSER_TRIGGER_TEXT,
    CAPTION_EDITOR,
    CAPTION_EDITOR_LOOSE,
    FILE_INPUT,
    COMPOSER_DIALOG_LABELED
  };
})(globalThis);
