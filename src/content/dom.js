/* =========================================================
   FB Auto Poster - Content: Penunggu & Pencari Elemen
   Semua fungsi di sini menunggu UI Facebook siap sebelum
   berinteraksi (menghindari klik pada elemen yang belum ada).
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const content = (FBAP.content = FBAP.content || {});
  const { sleep } = FBAP.time;
  const { POST_BUTTON_SELECTORS } = content.selectors;

  /* ---------- PENUNGGU (WAIT) ---------- */

  /** Kembalikan elemen pertama yang cocok dari daftar selektor. */
  async function waitForSelectorAny(selectors, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      await sleep(300);
    }
    return null;
  }

  /** Kembalikan elemen pertama yang cocok dengan satu selektor. */
  async function waitForSelector(sel, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(sel);
      if (el) return el;
      await sleep(300);
    }
    return null;
  }

  /** Tunggu sampai URL halaman memuat substring tertentu. */
  async function waitForUrlContains(sub, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (location.href.includes(sub)) return true;
      await sleep(400);
    }
    return false;
  }

  /** Cari tombol ber-role=button yang teksnya mengandung salah satu keyword. */
  async function waitForTextInTrigger(timeout, keywords) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const all = document.querySelectorAll('div[role="button"]');
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.width < 120 || el.offsetParent === null) continue;
        const t = (el.textContent || "").trim();
        if (t && keywords.some((k) => t.toLowerCase().includes(k))) return el;
      }
      await sleep(400);
    }
    return null;
  }

  /* ---------- PENCARI ELEMEN COMPOSER ---------- */

  function isEditableVisible(el) {
    if (!el || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    return r.width > 200 && r.height > 15 && r.width > 50;
  }

  async function findEditor(timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const editable = document.querySelectorAll('div[contenteditable="true"]');
      for (const el of editable) {
        if (!isEditableVisible(el)) continue;
        const fp = el.getAttribute("aria-placeholder") || "";
        if (fp && /(buat postingan|create|write|bagikan)/i.test(fp)) return el;
        if (el.hasAttribute("data-lexical-editor")) return el;
      }
      await sleep(400);
    }
    return null;
  }

  async function findPostButton(timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const nodes = document.querySelectorAll(POST_BUTTON_SELECTORS.join(","));
      for (const n of nodes) {
        if (n.getBoundingClientRect().width < 20 || n.offsetParent === null) continue;
        const label = (n.getAttribute && (n.getAttribute("aria-label") || "")) || "";
        const t = label || (n.textContent || "").trim();
        if (/(posting|kirim|post|bagikan|share)/i.test(t)) {
          if (/(media|foto|video|story|tag|feeling|aktivitas)/i.test(t) &&
              !/(post now|kirim posting|postingan|post aktivitas)/i.test(t)) continue;
          return n;
        }
      }
      await sleep(350);
    }
    return null;
  }

  /* ---------- URL ---------- */

  /** Samakan bentuk URL grup: absolut, tanpa query, tanpa trailing slash. */
  function normalizeUrl(href) {
    let h = (href || "").split("?")[0];
    if (h.startsWith("/")) h = "https://www.facebook.com" + h;
    return h.replace(/\/$/, "");
  }

  content.dom = {
    waitForSelectorAny,
    waitForSelector,
    waitForUrlContains,
    waitForTextInTrigger,
    isEditableVisible,
    findEditor,
    findPostButton,
    normalizeUrl
  };
})(globalThis);
