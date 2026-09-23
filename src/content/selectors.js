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
  const SYSTEM_GROUP_URL = /\/groups\/(feed|create|discover|events|joined|invited|joins|manage|member_requests|members|photos|videos|files|about|search|home|settings)/i;

  /** Menu "Grup" di sidebar kiri halaman utama Facebook. */
  const GRUP_LINK = 'a[role="link"][href*="/groups/?ref=bookmarks"]';

  /** Panel daftar grup di sisi kiri halaman /groups (ID & EN). */
  const SIDEBAR_NAV = 'div[role="navigation"][aria-label*="Daftar Grup"]';
  const SIDEBAR_NAV_EN = 'div[role="navigation"][aria-label*="list"]';

  /** Input file pada dialog composer. */
  const FILE_SELECTOR = 'input[type="file"][accept*="image"],input[type="file"][accept*="video"],input[type="file"]';

  /** Tombol submit postingan (ID & EN). */
  const POST_BUTTON_SELECTORS = ['div[role="button"][aria-label*="Posting"]', 'div[role="button"][aria-label*="Post"]'];

  /** TEMUAN LAPANGAN: selektor aria-label*="Posting" di atas JUGA mencocokkan
      toggle "Posting sebagai anonim" / "Post anonymously" di composer, sehingga
      findPostButton() kadang mengklik toggle anonim alih-alih tombol submit.
      POISON = kandidat yang mengandung kata-kata ini DITOLAK. */
  const POST_BUTTON_POISON_RE = /(anonim|anonymous|sebagai|switch|toggle|jadwal|schedule|draft)/i;
  /** Label submit yang sah (setelah normalisasi spasi+lowercase). */
  const POST_BUTTON_LABEL_RE = /(posting|post|kirim|bagikan|share)/i;

  /* ---------------- SELEKTOR COMPOSER (workflow uji media+caption) ----------------
     HANYA aria-label/role/placeholder — JANGAN class dinamis FB (x9f619 dst). */
  const COMPOSER_TRIGGER_TEXT = "Tulis sesuatu...";
  const CAPTION_EDITOR = 'div[contenteditable="true"][role="textbox"][aria-placeholder="Buat postingan publik..."]';
  const CAPTION_EDITOR_LOOSE = 'div[contenteditable="true"][role="textbox"]';
  /* Jangkar stabil Lexical: TIDAK tergantung teks aria-placeholder yang bisa
     berubah/hilang setelah media dilampirkan (FB mengganti placeholder saat
     composer berisi lampiran). Dipakai sebagai fallback pencarian editor. */
  const CAPTION_EDITOR_LEXICAL = 'div[contenteditable="true"][role="textbox"][data-lexical-editor="true"]';
  const FILE_INPUT = 'input[type="file"]';
  const COMPOSER_DIALOG_LABELED = 'div[role="dialog"][aria-label="Buat postingan"]';

  /* ---------------- PICKER "TAMBAHKAN GRUP" ----------------
     HANYA teks/role/placeholder — tanpa class dinamis FB.
     Semua keyword ID+EN, dipakai case-insensitive (guideline §10). */
  /** Tombol "+ Tambahkan grup ∨" di header composer. */
  const ADD_GROUPS_BUTTON_KW = ["tambahkan grup", "add groups", "tambah grup"];
  /** Judul dialog picker ("Tambahkan grup" / "Add groups"). */
  const GROUP_PICKER_TITLE_KW = ["tambahkan grup", "add groups", "tambah grup"];
  /** Kolom search di picker ("Cari grup" / "Search"). */

  const GROUP_PICKER_SEARCH_KW = ["cari grup", "search groups", "search"];

  /** Tombol tutup picker di bawah ("Selesai" / "Done"). */
  const GROUP_PICKER_DONE_KW = ["selesai", "done"];

  /* ---------------- GRUP JUAL-BELI (tanpa kolom posting) ----------------
     Beberapa grup tidak menyediakan trigger "Tulis sesuatu..." /
     "Write something..." — sebagai gantinya hanya ada tombol
     "Jual sesuatu" / "Sell something" (alur Marketplace). Grup seperti
     ini TIDAK BISA diposting alur ini -> dideteksi di openComposer()
     dan dilempar sebagai Error "SKIP_SELL_GROUP: ..." agar scheduler
     menandai, melabeli (STORAGE.SELL_GROUPS) & me-uncheck grupnya.
     Keyword penuh (bukan "jual" saja) supaya tidak false-positive pada
     teks "Jual" di nama grup/marketplace. ID & EN (guideline §10). */
  const SELL_ONLY_KW = ["jual sesuatu", "sell something"];

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
    CAPTION_EDITOR_LEXICAL,
    FILE_INPUT,
    COMPOSER_DIALOG_LABELED,
    ADD_GROUPS_BUTTON_KW,
    GROUP_PICKER_TITLE_KW,
    GROUP_PICKER_SEARCH_KW,
    GROUP_PICKER_DONE_KW,
    POST_BUTTON_POISON_RE,
    POST_BUTTON_LABEL_RE,
    SELL_ONLY_KW,
  };
})(globalThis);
