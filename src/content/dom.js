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
  const { POST_BUTTON_SELECTORS, CAPTION_EDITOR, CAPTION_EDITOR_LOOSE, CAPTION_EDITOR_LEXICAL, SYSTEM_GROUP_URL, ADD_GROUPS_BUTTON_KW, GROUP_PICKER_TITLE_KW, GROUP_PICKER_SEARCH_KW, GROUP_PICKER_DONE_KW } = content.selectors;

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

  /** Dialog BENAR-BENAR terbuka? TEMUAN LAPANGAN #4: FB menutup dialog
      picker dengan animasi fade via visibility:hidden / opacity:0 —
      dialog itu TETAP berdimensi (offsetWidth/Height > 0) sehingga
      isElementVisible selalu true -> penantuan "popup tertutup"
      timeout walau mata melihat popup sudah hilang. Cek computed
      style dialog + beberapa ancestor. */
  function dialogIsOpen(d) {
    if (!d || !d.getBoundingClientRect) return false;
    if (!isElementVisible(d)) return false;
    const r = d.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    let node = d;
    for (let i = 0; i < 6 && node && node !== document.documentElement; i++) {
      const cs = root.getComputedStyle ? root.getComputedStyle(node) : null;
      if (!cs) break;
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      if (parseFloat(cs.opacity || "1") === 0) return false;
      node = node.parentElement;
    }
    return true;
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

  /** Editor komentar/balas (BUKAN composer). Ciri: aria-placeholder atau
      aria-label berisi "Balas sebagai…", "Reply as…", "komentar". Editor
      ini juga contenteditable + data-lexical-editor dan bisa berada di
      dialog pop-up komentar — wajib ditolak dari jalur composer. */
  const COMMENT_EDITOR_RE = /(balas|reply|komentar|comment)/i;
  function isCommentEditor(el) {
    if (!el || !el.getAttribute) return false;
    const fp = el.getAttribute("aria-placeholder") || "";
    const al = el.getAttribute("aria-label") || "";
    return COMMENT_EDITOR_RE.test(fp) || COMMENT_EDITOR_RE.test(al);
  }

  /** Dialog punya editor composer (ketat/Lexical) yang BUKAN editor komentar? */
  function dialogHasComposerEditor(d) {
    const cands = d.querySelectorAll(CAPTION_EDITOR + "," + CAPTION_EDITOR_LEXICAL);
    for (const el of cands) if (!isCommentEditor(el)) return true;
    return false;
  }

  /** Dialog composer ASLI: dicari dari ISI (editor), bukan aria-label.
      Setelah media dilampirkan, aria-placeholder editor bisa berubah/hilang,
      jadi filter menerima editor ketat ATAU Lexical (data-lexical-editor).
      Dialog yang hanya berisi editor komentar (pop-up "Balas sebagai…")
      DITOLAK. Fallback loose: dialog berisi editor contenteditable + teks
      "Tambahkan grup" (aman untuk locale EN). */
  function findComposerDialog() {
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
    const withEditor = dialogs.filter(dialogHasComposerEditor);
    if (withEditor.length) return withEditor.find(isElementVisible) || withEditor[0];
    const loose = dialogs.filter((d) => d.querySelector(CAPTION_EDITOR_LOOSE) && Array.from(d.querySelectorAll("span")).some((s) => (s.textContent || "").trim() === "Tambahkan grup"));
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

  /** Editor harus berada DI DALAM dialog composer (bukan editor komentar
      di feed maupun di dialog pop-up komentar — ketiganya sama-sama
      contenteditable + data-lexical-editor). Editor komentar
      ("Balas sebagai…") ditolak lebih dulu. */
  function isInComposerDialog(el) {
    if (!el || typeof el.closest !== "function") return false;
    if (isCommentEditor(el)) return false;
    const d = el.closest('div[role="dialog"]');
    return !!(d && isElementVisible(d) && dialogHasComposerEditor(d));
  }

  /** Cari editor caption composer. WAJIB di dalam dialog composer supaya
      tidak salah menangkap kolom komentar. Urutan: placeholder ketat ->
      jangkar Lexical, keduanya harus lolos isInComposerDialog. */
  async function findEditor(timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const editable = document.querySelectorAll('div[contenteditable="true"]');
      for (const el of editable) {
        if (!isEditableVisible(el)) continue;
        if (!isInComposerDialog(el)) continue;
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
          if (/(media|foto|video|story|tag|feeling|aktivitas)/i.test(t) && !/(post now|kirim posting|postingan|post aktivitas)/i.test(t)) continue;
          return n;
        }
      }
      await sleep(350);
    }
    return null;
  }

  /* ---------- PICKER "TAMBAHKAN GRUP" (workflow 1 posting -> 10 grup) ----------
     Semua finder di sini HANYA pembaca elemen (guideline §7): logika klik/
     urutan ada di posting.js. Baseline: teks dinormalisasi + case-insensitive. */

  /** Normalisasi teks untuk pencocokan nama/kata kunci (spasi tunggal, trim). */
  function normPickerText(s) {
    return String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  /** Normalisasi EXACT untuk pencocokan nama grup (trim + spasi tunggal,
      TANPA lowercase) — nama tersimpan di Manajemen Data Grup mempertahankan
      case asli FB, jadi tahap pencocokan pertama harus case-sensitive. */
  function normExactText(s) {
    return String(s || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Elemen diklik yang teks/aria-label-nya mengandung salah satu keyword.
      Leaf node (span/p) dipanjat ke induk div[role="button"] / div[tabindex="0"]
      sesuai guideline §10.3 — jangan pernah .click() pada leaf. */
  function findClickableByText(scope, keywords) {
    if (!scope || !scope.querySelectorAll) return null;
    const nodes = scope.querySelectorAll('div[role="button"], span, p, div[aria-label]');
    for (const n of nodes) {
      const label = (n.getAttribute && (n.getAttribute("aria-label") || "")) || "";
      const t = normPickerText((n.textContent || "") + " " + label);
      if (!t || t.length > 120) continue;
      if (!keywords.some((k) => t.includes(k))) continue;
      if (n.getBoundingClientRect && n.getBoundingClientRect().width < 2) continue;
      const btn = n.closest('div[role="button"]') || n.closest('div[tabindex="0"]') || (n.matches && n.matches('div[role="button"]') ? n : null);
      if (btn) return btn;
    }
    return null;
  }

  /** Tombol "+ Tambahkan grup" di header composer (bukan tombol lain).
      TEMUAN LAPANGAN #5: composer memuat BANYAK teks mengandung kata
      "grup" ("Posting hingga ke 9 grup yang ada Anda di dalamnya",
      panel "Tambahkan ke postingan Anda", dst.) sehingga ambil-kandidat-
      pertama sering mengklik tombol SALAH -> picker tidak pernah terbuka.
      Strategi: kumpulkan SEMUA kandidat, beri SKOR presisi, tolak kandidat
      beracun, pilih skor tertinggi (teks terpendek = paling spesifik). */
  const ADD_GROUPS_POISON_RE = /(pilih grup|hingga ke 9|tambahkan ke postingan|buat postingan|posting hingga)/i;
  function scoreAddGroupsCandidate(text) {
    const t = normPickerText(text);
    if (!t || t.length > 60 || ADD_GROUPS_POISON_RE.test(t)) return 0;
    if (t === "tambahkan grup" || t === "add groups") return 5;
    if (/^(\+\s*)?(tambahkan grup|add groups|tambah grup)\b/.test(t)) return 4;
    if (ADD_GROUPS_BUTTON_KW.some((k) => t.includes(k))) return 3;
    return 0;
  }
  function findAddGroupsButton(dialog) {
    const roots = [dialog && document.contains(dialog) ? dialog : null, document].filter(Boolean);
    let best = null;
    let bestScore = 0;
    for (const scope of roots) {
      if (!scope || !scope.querySelectorAll) continue;
      const nodes = scope.querySelectorAll('div[role="button"], span, p, div[aria-label]');
      for (const n of nodes) {
        const label = (n.getAttribute && n.getAttribute("aria-label")) || "";
        /* Skor dari aria-label lebih dipercaya (teks gabungan sering panjang). */
        let score = scoreAddGroupsCandidate(label);
        if (score < 5) score = Math.max(score, scoreAddGroupsCandidate(n.textContent || ""));
        if (score <= bestScore) continue;
        if (n.getBoundingClientRect && n.getBoundingClientRect().width < 2) continue;
        const btn = n.closest('div[role="button"]') || n.closest('div[tabindex="0"]') || (n.matches && n.matches('div[role="button"]') ? n : null);
        if (!btn || !isElementVisible(btn)) continue;
        best = btn;
        bestScore = score;
      }
      if (best) return best; /* prioritas scope dialog composer */
    }
    return best;
  }

  /** Judul picker dicek via TEKS heading (temuan lapangan: "Tambahkan grup"
      di header picker adalah teks biasa, BUKAN div[role="button"], sehingga
      findClickableByText selalu gagal menemukannya -> timeout popup).
      Ketat: elemen heading/teks pendek yang persis mengandung keyword. */
  function pickerHasTitleText(d) {
    if (!d || !d.querySelectorAll) return false;
    const nodes = d.querySelectorAll("h1, h2, h3, span, p, div[role='heading'], div[aria-label]");
    for (const n of nodes) {
      const t = normPickerText(n.textContent || "");
      if (!t || t.length > 40) continue;
      if (GROUP_PICKER_TITLE_KW.some((k) => t.includes(k))) return true;
    }
    return false;
  }

  /** Dialog picker "Tambahkan grup": dialog yang JUDULNYA cocok keyword
      picker (via TEKS, bukan tombol — lihat pickerHasTitleText) ATAU
      berisi kolom "Cari grup" (fallback bila judul berubah diksi).
      Dibedakan dari composer utama ("Buat postingan") supaya klik
      jangan nyasar ke tombol composer. PENTING: dialog composer JUGA
      memuat teks "Tambahkan grup" (di tombol header), jadi dialog
      composer WAJIB dikecualikan — kini via dialogHasComposerEditor
      (picker tidak punya editor caption) DAN identitas referensi. */
  function findGroupPicker() {
    const composer = findComposerDialog();
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
    for (const d of dialogs) {
      if (composer && d === composer) continue;
      if (!dialogIsOpen(d)) continue; /* bukan isElementVisible — dialog fade-out (visibility/opacity) bukan "terbuka" */
      if (dialogHasComposerEditor(d)) continue; /* composer utama, bukan picker */
      if (!pickerHasTitleText(d) && !findPickerSearch(d)) continue;
      return d;
    }
    return null;
  }

    /** Kolom "Cari grup" di picker (SEARCH-FIRST): input terlihat dengan
      placeholder/aria-label mengandung keyword (ID/EN), fallback input
      teks pertama yang terlihat di dalam dialog picker (JANGAN
      document-wide). */
  function findPickerSearch(picker) {
    if (!picker || !picker.querySelectorAll) return null;
    const inputs = Array.from(picker.querySelectorAll('input[type="text"], input[type="search"], input:not([type])')).filter(function (inp) { return isElementVisible(inp); });
    for (const inp of inputs) {
      const ph = normPickerText(inp.getAttribute("placeholder"));
      const al = normPickerText(inp.getAttribute("aria-label"));
      if (GROUP_PICKER_SEARCH_KW.some(function (k) { return ph.includes(k) || al.includes(k); })) return inp;
    }
    return inputs[0] || null;
  }

  /** Kosongkan kolom search picker (fokus + select-all + delete,
      fallback setter native + event input; React-safe). */
  function clearPickerSearch(search) {
    if (!search) return;
    try {
      search.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
    } catch (e) {
      /* clear via execCommand gagal, fallback setter di bawah */
    }
    if (search.value) {
      try {
        Object.getOwnPropertyDescriptor(root.HTMLInputElement.prototype, "value").set.call(search, "");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      } catch (e2) {
        /* abaikan */
      }
    }
  }


  /** Subtitle baris yang dibuang dari nama ("Anda terakhir berkunjung..."). */
  const ROW_SUBTITLE_RE = /(anda terakhir berkunjung|terakhir berkunjung|last visited|last interacted).*$/i;

  /** Semua baris grup yang ter-render di picker:
      { row, name (teks agregat tanpa subtitle, lowercase), checked }.
      Checkbox picker TIDAK selalu div[role="checkbox"] — kandidat
      diperluas ke [aria-checked] / input. Baris = ancestor TERKECIL yang
      masih memuat logo (img) DAN teks < 120 karakter (logo + nama +
      subtitle); ancestor berikutnya adalah kontainer daftar (teks panjang)
      dan di-skip agar tidak jadi "satu baris raksasa". */
  function rowOfCheckbox(picker, cb) {
    let node = cb.parentElement;
    let best = null;
    while (node && picker.contains(node)) {
      const t = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length > 120) break;
      if (node.querySelector("img") || node.querySelector('div[role="img"]')) best = node;
      node = node.parentElement;
    }
    return best || cb.parentElement;
  }

  /** Daftar baris fallback: checkbox GRUP di seluruh dokumen (PORTAL-SAFE).
      TEMUAN LAPANGAN #6 (adopsi tambahGrupFB): FB me-render daftar grup
      picker via React PORTAL di luar subtree dialog, sehingga query ketat
      di dalam `picker` menghasilkan 0 item. Filter 4 lapis agar TIDAK
      menyentuh toggle "Posting secara anonim":
      a) buang role="switch"   (toggle anonim punya role, checkbox grup tidak)
      b) buang disabled        (toggle anonim disabled, checkbox grup tidak)
      c) WAJIB ada foto di wrapper [role="button"] (svg/image/img)
      d) jaring pengaman: buang wrapper berteks "anonim/anonymous".
      Return [{ checkbox, row, name }] — row = wrapper klikable
      closest('[role="button"]'). */
  function isGroupCheckbox(checkbox) {
    if (!checkbox || checkbox.getAttribute("role") === "switch") return false;
    if (checkbox.disabled) return false;
    const wrapper = checkbox.closest('[role="button"]');
    if (!wrapper) return false;
    if (!wrapper.querySelector("svg, image, img")) return false;
    const text = (wrapper.innerText || wrapper.textContent || "").toLowerCase();
    if (text.includes("anonim") || text.includes("anonymous")) return false;
    return true;
  }
  function listGroupCheckboxesDocWide() {
    const out = [];
    for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
      if (!isGroupCheckbox(cb)) continue;
      const wrapper = cb.closest('[role="button"]') || cb;
      const name = normPickerText((wrapper.textContent || "").replace(ROW_SUBTITLE_RE, ""));
      const nameExact = normExactText((wrapper.textContent || "").replace(ROW_SUBTITLE_RE, ""));
      out.push({ checkbox: cb, row: wrapper, name, nameExact, checked: cb.checked || (cb.getAttribute("aria-checked") || "").toLowerCase() === "true" });
    }
    return out;
  }

  function listPickerRows(picker) {
    if (!picker || !picker.querySelectorAll) return [];
    const rows = [];
    const seen = new Set();
    const cbs = picker.querySelectorAll('div[role="checkbox"], input[type="checkbox"], [aria-checked]');
    /* FALLBACK (temuan lapangan): kotak centang picker FB kadang div polos
       tanpa role/aria-checked — kandidat checkbox kosong. Baris tetap
       dibangun dari logo grup (img) via rowOfCheckbox; klik fleksibel di
       posting.js mencentang lewat nama/logo/baris (sama sah dengan checkbox). */
    const anchors = cbs.length ? cbs : picker.querySelectorAll("img");
    for (const cb of anchors) {
      const row = cb.closest('div[role="button"]') || rowOfCheckbox(picker, cb);
      if (!row || seen.has(row) || !picker.contains(row)) continue;
      seen.add(row);
      if (!isElementVisible(row)) continue;
      const name = normPickerText((row.textContent || "").replace(ROW_SUBTITLE_RE, ""));
      if (!name) continue;
      rows.push({ row, name, nameExact: normExactText((row.textContent || "").replace(ROW_SUBTITLE_RE, "")), checked: isRowChecked(row) });
    }
    /* PORTAL-SAFE (adopsi tambahGrupFB): bila di dalam picker TIDAK ada
       baris sama sekali, kemungkinan besar FB me-render daftar grup via
       React PORTAL di luar subtree dialog -> enumerasi checkbox grup
       document-wide (filter 4 lapis isGroupCheckbox supaya toggle
       "Posting anonim" tidak pernah tersentuh). */
    if (!rows.length) {
      for (const item of listGroupCheckboxesDocWide()) {
        if (!item.name || seen.has(item.row)) continue;
        seen.add(item.row);
        rows.push({ row: item.row, name: item.name, nameExact: item.nameExact, checked: item.checked, checkbox: item.checkbox });
      }
    }
    return rows;
  }

  /** Kontainer scroll picker (guideline §10.6): overflowY auto/scroll +
      scrollHeight > clientHeight. Pilih yang paling tinggi (terbesar). */
  function pickerScroller(picker) {
    if (!picker || !picker.querySelectorAll) return null;
    let best = null;
    for (const d of picker.querySelectorAll("div")) {
      if (d.clientHeight < 100) continue;
      if ((d.scrollHeight || 0) <= (d.clientHeight || 0) + 8) continue;
      const cs = root.getComputedStyle ? root.getComputedStyle(d) : null;
      if (!cs || !/(auto|scroll)/i.test(cs.overflowY || "")) continue;
      if (!best || d.clientHeight > best.clientHeight) best = d;
    }
    return best;
  }

  /** Centang pada baris picker: role="checkbox" / [aria-checked] / input. */
  function rowCheckbox(row) {
    if (!row) return null;
    return (
      row.querySelector('div[role="checkbox"], input[type="checkbox"], [aria-checked]') || null
    );
  }

  /** Apakah baris sudah tercentang? TEMUAN LAPANGAN #3: checkbox picker FB
      adalah <input type="checkbox" aria-checked="..."> yang state-nya
      diatribut aria-checked, BUKAN properti .checked DOM — verifikasi
      hanya-`.checked` selalu membaca false walau klik berhasil
      (gejala "tanpa checklist 1 pun"). Cek keduanya. */
  function isRowChecked(row) {
    const cb = rowCheckbox(row);
    if (!cb) return false;
    if (cb.tagName === "INPUT") return !!cb.checked || (cb.getAttribute("aria-checked") || "").toLowerCase() === "true";
    return (cb.getAttribute("aria-checked") || "").toLowerCase() === "true";
  }

  /** Tombol tutup picker: "Selesai/Done" di bawah, fallback panah mundur.
      PORTAL-SAFE (adopsi tambahGrupFB): bila tombol tidak ada di dalam
      picker, cari document-wide [role="button"] dengan aria-label ATAU
      teks persis "Selesai/Done" (case-insensitive) — tombol bisa di-render
      React di luar subtree dialog. */
  function findPickerDone(picker) {
    if (!picker) return null;
    const inner = findClickableByText(picker, GROUP_PICKER_DONE_KW);
    if (inner) return inner;
    for (const btn of document.querySelectorAll('[role="button"]')) {
      const ariaLabel = normPickerText((btn.getAttribute && btn.getAttribute("aria-label")) || "");
      const textContent = normPickerText(btn.innerText || btn.textContent || "");
      if (GROUP_PICKER_DONE_KW.some((k) => (ariaLabel && ariaLabel === k) || (textContent && textContent === k))) {
        if (isElementVisible(btn)) return btn;
      }
    }
    return null;
  }

  /** Panah mundur picker (kiri atas, icon arrow) — fallback tutup bila
      tombol Selesai tidak ada. Dicari lewat aria-label umum. */
  function findPickerBack(picker) {
    if (!picker) return null;
    const nodes = picker.querySelectorAll('div[role="button"], i[aria-label], span[aria-label]');
    for (const n of nodes) {
      const al = normPickerText(n.getAttribute && (n.getAttribute("aria-label") || ""));
      if (/(kembali|mundur|back)/i.test(al) && isElementVisible(n)) return n.closest('div[role="button"]') || n;
    }
    /* Fallback: tombol pertama di header picker yang kosong teksnya (icon). */
    const btns = picker.querySelectorAll('div[role="button"]');
    for (const b of btns) {
      if (!isElementVisible(b)) continue;
      if (!(b.textContent || "").trim() && (b.getAttribute("aria-label") || "")) return b;
    }
    return null;
  }

  /** Berapa baris grup yang sudah tercentang di picker? Sama seperti
      isRowChecked: INPUT dicek via properti .checked ATAU atribut
      aria-checked (state picker FB ada di aria-checked). */
  function countCheckedRows(picker) {
    if (!picker) return 0;
    let n = 0;
    for (const el of picker.querySelectorAll('[aria-checked], input[type="checkbox"]')) {
      if (el.tagName === "INPUT") {
        if (el.checked || (el.getAttribute("aria-checked") || "").toLowerCase() === "true") n++;
      } else if ((el.getAttribute("aria-checked") || "").toLowerCase() === "true") n++;
    }
    return n;
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
    } catch (e) {
      return "";
    }
    const m = path
      .split("?")[0]
      .split("#")[0]
      .match(/^\/groups\/([A-Za-z0-9._-]+)\/?$/);
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
    isInComposerDialog,
    waitFor,
    findComposerDialog,
    findMediaScope,
    findMediaBlobs,
    findEditor,
    findPostButton,
    findAddGroupsButton,
    findGroupPicker,
    findPickerSearch,
    clearPickerSearch,
    listPickerRows,
    pickerScroller,
    rowCheckbox,
    findPickerDone,
    findPickerBack,
    isRowChecked,
    countCheckedRows,
    normExactText,
    isGroupCheckbox,
    listGroupCheckboxesDocWide,
    dialogIsOpen,
    normalizeUrl,
  };
})(globalThis);
