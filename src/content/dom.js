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
  const { POST_BUTTON_SELECTORS, CAPTION_EDITOR, CAPTION_EDITOR_LOOSE, SYSTEM_GROUP_URL } = content.selectors;

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

  /** Elemen terlihat? (berbasis box model, bukan class). */
  function isElementVisible(el) {
    return Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  }

  /** Tunggu predicate() benar; kembalikan hasilnya, throw saat timeout. */
  async function waitFor(predicate, options) {
    const opts = options || {};
    const timeoutMs = opts.timeoutMs || 15000;
    const label = opts.label || "elemen";
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = predicate();
      if (result) return result;
      await sleep(250);
    }
    throw new Error(`Timeout menunggu ${label} (${timeoutMs}ms)`);
  }

  /* ---------- PENCARI DIALOG COMPOSER & SCOPE MEDIA (workflow posting) ---------- */

  /** Dialog composer ASLI: dicari dari ISI (editor), bukan aria-label.
      Temuan lapangan: composer asli = div[role="dialog"] TANPA label;
      yang berlabel "Buat postingan" hanya kotak judul kosong.
      Fallback loose: dialog berisi editor contenteditable + teks
      "Tambahkan grup" (aman untuk locale EN). */
  function findComposerDialog() {
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
    const withEditor = dialogs.filter((d) => d.querySelector(CAPTION_EDITOR));
    if (withEditor.length) return withEditor.find(isElementVisible) || withEditor[0];
    const loose = dialogs.filter((d) =>
      d.querySelector(CAPTION_EDITOR_LOOSE) &&
      Array.from(d.querySelectorAll("span")).some((s) => (s.textContent || "").trim() === "Tambahkan grup")
    );
    if (loose.length) return loose.find(isElementVisible) || loose[0];
    return null;
  }

  /** Scope yang berisi PREVIEW MEDIA aktif (bisa dialog lampiran terpisah). */
  function findMediaScope() {
    const candidates = new Set();
    for (const v of document.querySelectorAll('video[src^="blob:"]')) {
      const d = v.closest('div[role="dialog"]');
      if (d) candidates.add(d);
    }
    for (const b of document.querySelectorAll('div[role="button"][aria-label="Hapus lampiran postingan"]')) {
      const d = b.closest('div[role="dialog"]');
      if (d) candidates.add(d);
    }
    for (const d of candidates) if (isElementVisible(d)) return d;
    return null;
  }

  /** Hitung blob USER di scope (ikon static.xx.fbcdn.net TIDAK dihitung). */
  function findMediaBlobs(scope) {
    const live = scope && document.contains(scope) ? scope : findComposerDialog();
    const roots = live ? [live, document] : [document];
    const seen = new Set();
    const result = { videoBlob: 0, imgBlob: 0 };
    for (const root of roots) {
      for (const v of root.querySelectorAll('video[src^="blob:"]')) {
        if (seen.has(v)) continue;
        seen.add(v);
        if (v.readyState >= 2) result.videoBlob += 1;
      }
      for (const i of root.querySelectorAll('img[src^="blob:"]')) {
        if (!seen.has(i)) {
          seen.add(i);
          result.imgBlob += 1;
        }
      }
    }
    return result;
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

  /** Samakan ke format kanonis grup:
      "https://www.facebook.com/groups/{id}" (id angka ATAU slug teks).
      Potong query/hash/ekor path (/members, /about, ...). Kembalikan ""
      bila bukan URL grup valid (selain format itu jangan disimpan). */
  function normalizeUrl(href) {
    const raw = (href || "").trim();
    if (!raw) return "";
    let path = "";
    try {
      if (/^https?:\/\//i.test(raw)) {
        const u = new URL(raw);
        if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return "";
        path = u.pathname || "";
      } else if (raw.startsWith("/")) {
        path = raw.split("?")[0].split("#")[0];
      } else {
        return "";
      }
    } catch (e) { return ""; }
    const m = path.split("?")[0].split("#")[0].match(/^\/groups\/([A-Za-z0-9._-]+)\/?$/);
    if (!m) {
      /* Ada ekor path (/groups/{id}/members): ambil segmen id-nya saja. */
      const m2 = path.match(/^\/groups\/([A-Za-z0-9._-]+)\//);
      if (!m2) return "";
      const idOnly = m2[1];
      if (SYSTEM_GROUP_URL.test("/groups/" + idOnly)) return "";
      return "https://www.facebook.com/groups/" + idOnly;
    }
    if (SYSTEM_GROUP_URL.test("/groups/" + m[1])) return "";
    return "https://www.facebook.com/groups/" + m[1];
  }

  content.dom = {
    waitForSelectorAny,
    waitForSelector,
    waitForUrlContains,
    waitForTextInTrigger,
    isEditableVisible,
    isElementVisible,
    waitFor,
    findComposerDialog,
    findMediaScope,
    findMediaBlobs,
    findEditor,
    findPostButton,
    normalizeUrl
  };
})(globalThis);
