/* =========================================================
   FB Auto Poster - Content: Eksekusi Posting ke Grup
   Urutan: trigger composer -> editor -> LAMPIRKAN MEDIA DULU
           (GATE preview blob) -> tulis caption (Lexical-safe,
           anti-dobel) -> SUBMIT sesuai mode:
             • autoposting ON  : klik tombol Posting + verifikasi
                                 composer tertutup.
             • autoposting OFF : berhenti setelah media+caption
                                 terisi, beri user MANUAL_POST_WINDOW_MS
                                 untuk klik Posting sendiri, lalu
                                 lanjut tanpa memedulikan hasilnya.
   openComposer() dipisah agar bisa dipakai ulang oleh pesan
   NAV_HOME_TO_COMPOSER (uji navigasi home -> grup -> composer).
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const content = (FBAP.content = FBAP.content || {});
  const { MANUAL_POST_WINDOW_MS, ADD_GROUPS_TIMEOUT_MS, PICKER_SEARCH_TIMEOUT_MS, PICKER_SCROLL_PASSES, PICKER_STUCK_LIMIT } = FBAP.config.LIMITS;
  const { EXTRA_GROUPS_PER_POST } = FBAP.config.LIMITS;
  const { randInt } = FBAP.random;
  const { sleep } = FBAP.time;
  const { parse } = FBAP.spintax;
  const { CAPTION_EDITOR, CAPTION_EDITOR_LEXICAL } = content.selectors;
  const {
    findEditor,
    findPostButton,
    waitForTextInTrigger,
    findComposerDialog,
    findMediaScope,
    waitFor,
    isEditableVisible,
    isElementVisible,
    isInComposerDialog,
    findAddGroupsButton,
    findGroupPicker,
    listPickerRows,
    pickerScroller,
    findPickerSearch,
    clearPickerSearch,
    rowCheckbox,
    findPickerDone,
    findPickerBack,
    isRowChecked,
    countCheckedRows,
    dialogIsOpen,
  } = content.dom;
  const { humanScrollToEl } = content.stealth;
  const { uploadMedia } = content.media;

  /** Kata kunci trigger composer di halaman grup (ID & EN). */
  const COMPOSER_TRIGGERS = ["tulis sesuatu", "write something", "buat postingan"];

  /* ---------------------------------------------------------
     BUKA COMPOSER (halaman grup -> editor siap)
     1. Klik trigger "Tulis sesuatu..." / "Write something..."
     2. Tunggu editor contenteditable muncul (bukti composer terbuka)
     Dipakai dua jalur: postToGroup() dan pesan NAV_HOME_TO_COMPOSER.
     --------------------------------------------------------- */
  async function openComposer(triggerTimeout = 15000) {
    /* Idempoten: bila composer sudah terbuka (mis. dibuka oleh langkah
       navigasi NAV_HOME_TO_COMPOSER sebelum EXECUTE_POST tiba), jangan
       klik trigger lagi — cukup pakai editornya. */
    const existing = await findEditor(3000);
    if (existing) return existing;

    const trigger = await waitForTextInTrigger(triggerTimeout, COMPOSER_TRIGGERS);
    if (trigger) {
      await humanScrollToEl(trigger);
      trigger.click();
      await sleep(randInt(1200, 2400));
    }

    const editor = await findEditor(30000);
    if (!editor) throw new Error("Editor postingan tidak ditemukan.");
    return editor;
  }

  /* =========================================================
     INTI BERSAMA: MEDIA DULU -> CAPTION (Lexical-safe)
     Temuan lapangan: attach media me-re-render composer Lexical,
     sehingga caption yang diketik SEBELUM media ikut terhapus.
     Aturan: caption & grup tambahan tidak disentuh sebelum
     GATE MEDIA (preview blob baru ter-render) lolos.
     Dipakai oleh postToGroup() untuk kedua mode (autoposting & manual).
     ========================================================= */

  const normText = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .trim();
  const getEditorText = (editor) => normText(editor ? editor.textContent : "");

  /** Kosongkan editor Lexical (focus + select all + delete). */
  async function clearEditor(editor) {
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("delete", false, null);
    await sleep(150);
  }

  /** Ketik caption per-baris: insertText, fallback paste, Enter via keydown.
      Verifikasi pertumbuhan teks ASYNC (Lexical commit tidak sinkron). */
  async function insertCaptionLines(editor, caption) {
    const lines = String(caption).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        editor.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        );
        await sleep(120);
      }
      const line = lines[i];
      if (!line) continue;
      editor.focus();
      const beforeLen = getEditorText(editor).length;
      const ok = document.execCommand("insertText", false, line);
      await sleep(120); // Lexical commit async — JANGAN baca sinkron!
      const grew = getEditorText(editor).length > beforeLen;
      if (!ok || !grew) {
        // fallback paste
        const d = new DataTransfer();
        d.setData("text/plain", line);
        editor.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: d,
            bubbles: true,
            cancelable: true,
          }),
        );
        await sleep(200);
      }
      await sleep(150);
    }
  }

  /** Tulis caption ke editor Lexical, anti-dobel:
      - sudah persis -> tidak mengetik ulang (idempoten)
      - sisa draft -> dibersihkan dulu supaya tidak append
      - hasil < 80% panjang target -> gagal
      - dobel (teks berulang) -> bersihkan & ketik ulang SEKALI, stop bila masih dobel */
  async function typeCaption(editor, caption) {
    editor.focus();
    await sleep(300);
    const expected = normText(caption);
    const existing = getEditorText(editor);
    if (existing && existing === expected) return;
    if (existing) {
      await clearEditor(editor);
      if (getEditorText(editor)) throw new Error("Gagal membersihkan editor — stop anti-dobel.");
    }
    await insertCaptionLines(editor, caption);
    const inserted = getEditorText(editor);
    if (inserted.length < expected.length * 0.8) throw new Error(`Caption tidak penuh (${inserted.length}/${expected.length})`);
    const rest = inserted.slice(expected.length).trim();
    if (inserted.length > expected.length && (rest === expected || (inserted.length >= expected.length * 1.9 && inserted.includes(expected)))) {
      await clearEditor(editor);
      await insertCaptionLines(editor, caption);
      const recheck = getEditorText(editor);
      if (recheck !== expected && recheck.length > expected.length * 1.4) throw new Error("Caption masih dobel setelah ketik ulang — stop.");
    }
  }

  /* Catatan: tidak ada lagi fungsi "uji tanpa submit" tersendiri —
     mode manual di postToGroup() sudah mencakup alur itu (media+caption
     terisi, tombol Posting tidak diklik otomatis). */

  /* =========================================================
     INTI BERSAMA (eksekusi): composer -> media DULU + GATE ->
     query editor ulang -> typeCaption. Dipakai postToGroup
     supaya urutan media-dulu hanya ditulis sekali.
     ========================================================= */
  async function composeMediaAndCaption(caption, mediaDataUrl, mediaMime, mediaName) {
    // 1. Buka composer (idempoten — reuse editor bila sudah terbuka)
    const editor0 = await openComposer();

    // 2. Dialog composer ASLI (dicari dari ISI, bukan aria-label)
    const dialog = findComposerDialog() || editor0.closest('div[role="dialog"]') || null;

    // 3. MEDIA DULU + GATE preview blob (skip bila materi tanpa media)
    if (mediaDataUrl) {
      const ok = await uploadMedia(dialog, mediaDataUrl, mediaMime, mediaName);
      if (!ok) throw new Error("Gagal melampirkan media (GATE preview tidak lolos).");
    }

    // 4. Query editor SETELAH media — node fresh; scope preview media DULU.
    //    PENTING: jangan pakai referensi `dialog` dari step 2 (bisa STALE
    //    karena composer Lexical di-re-render setelah attach media), dan
    //    jangan hanya andalkan aria-placeholder (berubah/hilang saat ada
    //    lampiran). WAJIB editor di dalam dialog composer (isInComposerDialog)
    //    supaya tidak salah menangkap kolom komentar. TIDAK ada fallback
    //    document-wide — bila tidak ketemu, gagal (jangan ketik ke komentar).
    const pickEditorIn = (root) => {
      if (!root || !root.querySelector) return null;
      const strict = root.querySelector(CAPTION_EDITOR);
      if (strict && isEditableVisible(strict) && isInComposerDialog(strict)) return strict;
      const lexical = root.querySelector(CAPTION_EDITOR_LEXICAL);
      if (lexical && isEditableVisible(lexical) && isInComposerDialog(lexical)) return lexical;
      return null;
    };
    const editor = await waitFor(
      () => {
        const ms = findMediaScope();
        const inMedia = ms && pickEditorIn(ms);
        if (inMedia) return inMedia;
        const freshDialog = findComposerDialog();
        const inDialog = freshDialog && pickEditorIn(freshDialog);
        if (inDialog) return inDialog;
        return null;
      },
      { label: "editor Lexical di scope preview media" },
    );

    editor.scrollIntoView({ block: "center" });
    await sleep(300);

    // 5. Tulis caption (spintax di-resolve)
    const finalText = parse(caption || "");
    await typeCaption(editor, finalText);

    return { dialog, editor, editorText: getEditorText(editor) };
  }

  /* =========================================================
     TAMBAHAN GRUP (picker "Tambahkan grup"): 1 posting -> 10 grup.
     Alur: klik tombol "+ Tambahkan grup" di header composer ->
     popup picker muncul -> ENUMERASI baris yang ter-render ->
     cocokkan nama grup langsung (skor: persis > contains > kata
     kunci) -> klik fleksibel (WRAPPER [role="button"] dulu —
     adopsi tambahGrupFB, lalu checkbox/teks/logo/baris) ->
     verifikasi aria-checked -> scroll lazy-render untuk baris
     berikutnya -> tutup dengan "Selesai" (fallback panah mundur
     dan pencarian document-wide — React PORTAL, adopsi
     tambahGrupFB).
     TANPA search: input "Cari grup" FB adalah controlled input React
     yang tidak andal dipicu event sintetis (temuan lapangan).
     Return { added: [url...], failed: [url...] }.
     Yang tidak ketemu TIDAK menggagalkan batch (ditandai ❌ di
     tabel dashboard oleh scheduler).
     ========================================================= */

  /** Skor kecocokan nama target vs nama baris picker (keduanya sudah
      lowercase/spasi tunggal). 3 = persis, 2 = contains dua arah,
      1 = semua kata kunci (2+ huruf) ada, 0 = tidak cocok. */
  function matchScore(want, have) {
    if (!want || !have) return 0;
    if (want === have) return 3;
    if (have.includes(want) || want.includes(have)) return 2;
    const words = want.split(" ").filter((w) => w.length > 2);
    if (words.length && words.every((w) => have.includes(w))) return 1;
    return 0;
  }

  /** Ritme klik manusia antar checklist (adopsi tambahGrupFB / KLM):
      dominan ritmis-cepat (70%), sesekali berhenti membaca (30%). */
  async function humanClickDelay() {
    await sleep(Math.random() < 0.7 ? randInt(600, 1400) : randInt(1400, 2600));
  }

  /** Klik fleksibel 1 baris (info user: checkbox / teks / logo sama-sama
      mencentang). Adopsi tambahGrupFB: klik WAJIB di WRAPPER
      [role="button"] dulu (klik langsung ke <input> sering tidak memicu
      state React FB), lalu fallback chain + verifikasi aria-checked tiap
      tahap: 1) wrapper baris 2) checkbox 3) node teks nama 4) logo
      (img, dipanjat ke klikable). Return true bila baris jadi tercentang. */
  async function clickRowFlexible(row, checkedBefore) {
    const cb = rowCheckbox(row);
    const nameEl = Array.from(row.querySelectorAll("span, p, div")).find((el) => !el.children.length && (el.textContent || "").trim());
    const imgEl = row.querySelector("img");
    const clickableRow = row.matches && row.matches('div[role="button"], div[tabindex="0"]') ? row : row.closest('div[role="button"]');
    const candidates = [clickableRow, cb, nameEl && nameEl.closest('div[role="button"], div[tabindex="0"]') ? nameEl : null, imgEl && (imgEl.closest('div[role="button"], div[tabindex="0"]') || imgEl)].filter(Boolean);
    for (const c of candidates) {
      try {
        c.click();
      } catch (e) {
        continue;
      }
      await sleep(randInt(400, 800));
      if (isRowChecked(row) || countCheckedRows(row.closest('div[role="dialog"]') || row) > checkedBefore) return true;
    }
    return isRowChecked(row) || countCheckedRows(row.closest('div[role="dialog"]') || row) > checkedBefore;
  }

  /** Pilih sekumpulan grup target di picker TANPA search, DUA PASS:
      PASS 1 (exact): nama tersimpan === nama baris picker, case-sensitive
      (keduanya via normExactText — nama storage mempertahankan case asli FB).
      PASS 2 (fuzzy): matchScore (persis-lowercase > contains > kata kunci)
      hanya untuk target yang belum ketemu di pass 1.
      TANPA fallback baris sembarang (temuan lapangan: fallback lama
      mencentang baris teratas mana pun sehingga grup salah). Target yang
      tidak ketemu di kedua pass = failed -> ditandai ❌ di tabel dashboard.
      Return { added: Set<index>, matched: Map<index, namaBaris>,
               rowsSeen: jumlah nama baris unik terbaca }. */
  async function pickGroupsByRows(picker, targets) {
    const added = new Set();
    const matched = new Map();
    const seenNames = new Set();
    let scroller = pickerScroller(picker);
    for (const pass of ["exact", "fuzzy"]) {
      if (added.size >= targets.length) break;
      const usedThisPass = new Set();
      let stuck = 0;
      for (let p = 0; p < PICKER_SCROLL_PASSES; p++) {
        for (const { row, name, nameExact, checked } of listPickerRows(picker)) {
          seenNames.add(name);
          if (usedThisPass.has(row)) continue;
          let bestI = -1;
          if (pass === "exact") {
            bestI = targets.findIndex((t, i) => !added.has(i) && nameExact && nameExact === t.keyExact);
          } else {
            let bestScore = 0;
            targets.forEach((t, i) => {
              if (added.has(i)) return;
              const s = matchScore(t.key, name);
              if (s > bestScore) {
                bestScore = s;
                bestI = i;
              }
            });
          }
          if (bestI < 0) continue;
          usedThisPass.add(row);
          if (checked) {
            added.add(bestI);
            matched.set(bestI, nameExact || name);
            continue;
          }
          /* Node bisa stale setelah re-render FB (scroll/centang) — cek ulang. */
          if (!document.contains(row)) continue;
          try {
            await humanScrollToEl(row);
          } catch (e) {
            /* scroll gagal, langsung coba klik */
          }
          if (!document.contains(row)) continue;
          if (await clickRowFlexible(row, countCheckedRows(picker))) {
            added.add(bestI);
            matched.set(bestI, nameExact || name);
          }
          await humanClickDelay();
        }
        if (added.size >= targets.length) break;
        /* Scroll 1 langkah signifikan + jeda render (lazy-render FB). */
        if (scroller) {
          const top = scroller.scrollTop || 0;
          scroller.scrollTop = top + Math.max(400, Math.floor((scroller.clientHeight || 600) * 0.7));
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
          await sleep(randInt(700, 1100));
          const moved = (scroller.scrollTop || 0) - top;
          const bottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
          stuck = moved <= 2 && !bottom ? stuck + 1 : 0;
          if (bottom) stuck++;
          if (stuck >= PICKER_STUCK_LIMIT) break;
        } else {
          await sleep(randInt(700, 1100));
          stuck++;
          if (stuck >= PICKER_STUCK_LIMIT + 2) break;
        }
      }
    }
    return { added, matched, rowsSeen: seenNames.size };
  }

  /** Ketik teks di kolom search picker KARAKTER-PER-KARAKTER (human-like).
      Set-value sekaligus TIDAK memicu filter React controlled input FB.
      Verifikasi search.value benar-benar berisi teks; ulangi maks 2x. */
  async function typePickerSearch(search, text) {
    const want = String(text || "");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        search.focus();
      } catch (e) {
        /* fokus gagal tetap lanjut */
      }
      try {
        document.execCommand("selectAll", false, null);
        document.execCommand("delete", false, null);
      } catch (e2) {
        /* clear gagal, fallback setter di bawah */
      }
      if (search.value) {
        try {
          Object.getOwnPropertyDescriptor(root.HTMLInputElement.prototype, "value").set.call(search, "");
          search.dispatchEvent(new Event("input", { bubbles: true }));
        } catch (e3) {
          /* abaikan */
        }
      }
      let ok = true;
      for (const ch of Array.from(want)) {
        search.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
        let inserted = false;
        try {
          inserted = document.execCommand("insertText", false, ch);
        } catch (e4) {
          inserted = false;
        }
        if (!inserted) {
          try {
            Object.getOwnPropertyDescriptor(root.HTMLInputElement.prototype, "value").set.call(search, (search.value || "") + ch);
            search.dispatchEvent(new Event("input", { bubbles: true }));
          } catch (e5) {
            ok = false;
          }
        }
        search.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true, cancelable: true }));
        await sleep(randInt(40, 90));
      }
      search.dispatchEvent(new Event("change", { bubbles: true }));
      if (ok && normText(search.value) === normText(want)) return true;
      await sleep(400);
    }
    return normText(search.value) === normText(want);
  }

  /** Satu grup via kolom search picker: ketik nama -> tunggu hasil
      menyempit -> cocokkan baris (matchScore) -> klik fleksibel ->
      verifikasi tercentang -> kosongkan search. Return { ok }. */
  async function pickOneGroupBySearch(picker, search, target) {
    const before = countCheckedRows(picker);
    /* Diagnostik: isi picker terbaca + hasil pencocokan nama, supaya
       kegagalan "baris tidak terbaca" vs "nama tidak cocok" langsung
       terlihat dari console tanpa inspeksi DOM manual. */
    const seen = listPickerRows(picker);
    const exactSeen = seen.some((r) => r.nameExact && r.nameExact === target.keyExact);
    console.log(`[FB-AutoPoster] Picker: ${seen.length} baris ter-render${exactSeen ? " (nama EXACT ada)" : ""}. Contoh: ${seen.slice(0, 3).map((r) => `"${r.name.slice(0, 40)}"${r.checked ? " ✔" : ""}`).join(", ") || "(kosong)"}. Target: "${target.keyExact.slice(0, 40)}" (skor terbaik: ${Math.max(0, ...seen.map((r) => matchScore(target.key, r.name)))}).`);
    if (!(await typePickerSearch(search, target.key))) {
      console.log(`[FB-AutoPoster] Search "${target.key}" tidak terketik penuh (value="${search.value}") - tetap dicoba.`);
    }
    const found = await waitFor(
      function () {
        /* TAHAP 1: exact case-sensitive (nama storage === nama baris). */
        for (const r of listPickerRows(picker)) {
          if (r.nameExact && r.nameExact === target.keyExact) return { row: r, how: "exact" };
        }
        /* TAHAP 2: fuzzy (persis-lowercase > contains > kata kunci). */
        for (const r of listPickerRows(picker)) {
          if (matchScore(target.key, r.name) > 0) return { row: r, how: "fuzzy" };
        }
        return null;
      },
      { timeoutMs: PICKER_SEARCH_TIMEOUT_MS, label: `hasil search "${target.key}"` }
    ).catch(function () { return null; });
    if (!found) {
      clearPickerSearch(search);
      return { ok: false };
    }
    if (found.row.checked) {
      clearPickerSearch(search);
      return { ok: true, name: found.row.nameExact || found.row.name, how: found.how };
    }
    try {
      await humanScrollToEl(found.row.row);
    } catch (e6) {
      /* scroll gagal, langsung coba klik */
    }
    const okClick = await clickRowFlexible(found.row.row, before);
    clearPickerSearch(search);
    return { ok: okClick, name: found.row.nameExact || found.row.name, how: found.how };
  }

  /** Tutup picker: tombol "Selesai/Done" dulu, fallback panah mundur,
      fallback terakhir tombol Escape.
      TEMUAN LAPANGAN: referensi picker bisa STALE (menghapus search /
      mencentang baris me-re-render dialog FB), jadi setiap percobaan
      tutup WAJIB re-query picker fresh dari findGroupPicker() — jangan
      percaya sub-pohon `picker` lama yang sudah terlepas dari DOM. */
  async function closeGroupPicker(picker) {
    const pressEscape = async () => {
      const p = findGroupPicker() || picker;
      const target = (p && document.contains(p) ? p : null) || document.activeElement || document.body;
      for (const type of ["keydown", "keyup"]) {
        target.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      }
    };
    const tryClose = async () => {
      const fresh = findGroupPicker();
      const p = fresh && document.contains(fresh) ? fresh : (document.contains(picker) ? picker : null);
      if (!p) return "sudah-tutup";
      const done = findPickerDone(p);
      const back = done ? null : findPickerBack(p);
      const closer = done || back;
      if (!closer) return "tanpa-tombol";
      try {
        await humanScrollToEl(closer);
      } catch (e) {
        /* scroll gagal tetap coba klik */
      }
      closer.click();
      return done ? "selesai" : "mundur";
    };

    const how = await tryClose();
    console.log(`[FB-AutoPoster] Tutup picker: ${how}.`);
    const closedLabel = 'popup "Tambahkan grup" tertutup';
    /* dialogIsOpen: dialog fade-out (visibility/opacity) dianggap tertutup. */
    const isOpen = () => {
      const p = findGroupPicker();
      return p && dialogIsOpen(p);
    };
    await waitFor(() => (isOpen() ? null : true), { timeoutMs: 10000, label: closedLabel }).catch(async () => {
      await tryClose();
      await sleep(600);
      await waitFor(() => (isOpen() ? null : true), { timeoutMs: 8000, label: `${closedLabel} (retry)` }).catch(async () => {
        /* FALLBACK terakhir: Escape (temuan lapangan: klik Selesai kadang
           tidak ditangani FB bila fokus berada di kolom search). */
        console.log("[FB-AutoPoster] Tutup picker: klik gagal, coba tombol Escape.");
        await pressEscape();
        await sleep(600);
        await pressEscape();
        await waitFor(() => (isOpen() ? null : true), { timeoutMs: 8000, label: `${closedLabel} (Escape)` });
      });
    });
  }

  /** Klik tombol FB dengan rangkaian event React-realistis (temuan
      lapangan #5): .click() polos sering tidak memicu handler React FB
      (pointer/mouse level rendah). Semua event bubbles ke atas. */
  async function clickButtonRealistic(el) {
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: root,
    };
    if (rect) {
      opts.clientX = Math.round(rect.left + rect.width / 2);
      opts.clientY = Math.round(rect.top + rect.height / 2);
      opts.screenX = opts.clientX;
      opts.screenY = opts.clientY;
    }
    const Pointer = root.PointerEvent || root.MouseEvent;
    const Mouse = root.MouseEvent;
    try { el.dispatchEvent(new Pointer("pointerover", { ...opts, pointerType: "mouse" })); } catch (e) { /* abaikan */ }
    try { el.dispatchEvent(new Mouse("mouseover", opts)); } catch (e2) { /* abaikan */ }
    try { el.dispatchEvent(new Pointer("pointerdown", { ...opts, pointerType: "mouse", buttons: 1 })); } catch (e3) { /* abaikan */ }
    try { el.dispatchEvent(new Mouse("mousedown", { ...opts, buttons: 1 })); } catch (e4) { /* abaikan */ }
    try { if (typeof el.focus === "function") el.focus(); } catch (e5) { /* abaikan */ }
    try { el.dispatchEvent(new Pointer("pointerup", { ...opts, pointerType: "mouse", buttons: 1 })); } catch (e6) { /* abaikan */ }
    try { el.dispatchEvent(new Mouse("mouseup", { ...opts, buttons: 1 })); } catch (e7) { /* abaikan */ }
    try { el.click(); } catch (e8) { /* abaikan */ }
  }

  async function addExtraGroups(dialog, extraGroups) {
    const added = [];
    const failed = [];
    const list = (extraGroups || []).slice(0, EXTRA_GROUPS_PER_POST);
    if (!list.length) return { added, failed };

    const btn = await waitFor(() => findAddGroupsButton(dialog), { timeoutMs: ADD_GROUPS_TIMEOUT_MS, label: 'tombol "Tambahkan grup" di composer' });
    const btnLabel = normText((btn.getAttribute && btn.getAttribute("aria-label")) || btn.textContent || "").slice(0, 60);

    /* Klik + verifikasi picker muncul; ulangi maks 3x (temuan #5:
       klik polos kadang tidak ditangani handler React FB). */
    let picker = null;
    for (let attempt = 1; attempt <= 3 && !picker; attempt++) {
      try {
        await humanScrollToEl(btn);
      } catch (e) {
        /* scroll gagal, tetap coba klik */
      }
      await clickButtonRealistic(btn);
      await sleep(randInt(700, 1300));
      picker = findGroupPicker();
      console.log(`[FB-AutoPoster] Klik tombol "${btnLabel}" (percobaan ${attempt}/3): picker ${picker ? "MUNCUL" : "belum muncul"}.`);
    }
    if (!picker) {
      const vis = Array.from(document.querySelectorAll('div[role="dialog"]')).filter(isElementVisible);
      const titles = vis.map((d) => {
        const t = normText((d.textContent || "").slice(0, 120));
        return t ? `"${t}..."` : "(tanpa teks)";
      });
      throw new Error(`Tombol "${btnLabel}" tidak membuka popup setelah 3 percobaan. Dialog terlihat: ${vis.length} ${titles.join(" | ")}`);
    }

    await sleep(randInt(600, 1100));

    /* SEARCH-FIRST (user): ketik nama grup target di kolom "Cari grup"
       (ketikan natural per karakter - set-value sekaligus TIDAK memicu
       filter React controlled input). Fallback enumerasi+scroll hanya
       bila kolom search tidak ditemukan.
       Pencocokan nama DUA TAHAP: exact case-sensitive dulu (keyExact,
       nama storage === nama baris picker), lalu fuzzy (matchScore).
       TANPA fallback baris sembarang. addedNames = nama baris picker
       yang benar-benar tercentang (untuk log background). */
    const targets = list.map((g) => ({ url: g.url || g.name, key: normText(g.name || g.url || ""), keyExact: normText(g.name || g.url || "") }));
    const addedNames = [];
    const search = findPickerSearch(picker);
    if (search) {
      for (const t of targets) {
        const r = await pickOneGroupBySearch(picker, search, t);
        if (r.ok) {
          added.push(t.url);
          addedNames.push({ url: t.url, name: r.name || t.keyExact, how: r.how || "?" });
        } else {
          failed.push(t.url);
        }
      }
      console.log(`[FB-AutoPoster] Picker tambah-grup (search): ${added.length}/${targets.length} tercentang.`);
      if (failed.length) console.log(`[FB-AutoPoster] Search gagal untuk: ${failed.join(", ")}`);
      await closeGroupPicker(picker);
      return { added, failed, addedNames, rowsSeen: -1 };
    }
    /* FALLBACK: searchbox tidak ada -> enumerasi baris + scroll. */
    const { added: addedIdx, matched, rowsSeen } = await pickGroupsByRows(picker, targets);
    targets.forEach((t, i) => {
      if (addedIdx.has(i)) {
        added.push(t.url);
        addedNames.push({ url: t.url, name: matched.get(i) || t.keyExact, how: matched.get(i) === t.keyExact ? "exact" : "fuzzy" });
      } else {
        failed.push(t.url);
      }
    });
    console.log(`[FB-AutoPoster] Picker tambah-grup (fallback enumerasi): ${rowsSeen} baris terbaca, ${added.length}/${targets.length} tercentang.`);
    if (failed.length) console.log(`[FB-AutoPoster] Grup tambahan tidak ditemukan di picker: ${failed.join(", ")}`);
    /* Jeda "cek ulang sudah cukup belum ya" sebelum menutup picker
       (adopsi tambahGrupFB: M penuh + visual check manusia). */
    await sleep(randInt(1500, 3500));
    await closeGroupPicker(picker);
    return { added, failed, addedNames, rowsSeen };
  }

  /** Posting satu materi: media-dulu + caption + TAMBAHAN GRUP, lalu submit.
      `autoPost`: true -> klik Posting otomatis + verifikasi composer
      tertutup; false -> jendela manual MANUAL_POST_WINDOW_MS (tambah grup
      TETAP otomatis, hanya klik Posting akhir yang manual).
      `extraGroups`: array {name,url} maks EXTRA_GROUPS_PER_POST, dicentang
      via picker "Tambahkan grup". Return { ok, added, failed, addedNames,
      rowsSeen } — addedNames = [{url, name, how}] nama baris picker yang
      tercentang (untuk log background). */
  async function postToGroup(caption, mediaDataUrl, mediaMime, mediaName, autoPost = true, extraGroups = []) {
    // 1-3. Media DULU (GATE) -> editor ulang -> caption Lexical anti-dobel
    await composeMediaAndCaption(caption, mediaDataUrl, mediaMime, mediaName);

    // 3b. TAMBAHAN GRUP (selalu otomatis): picker "Tambahkan grup"
    let added = [];
    let failed = [];
    let addedNames = [];
    let rowsSeen = 0;
    if (extraGroups && extraGroups.length) {
      const res = await addExtraGroups(findComposerDialog(), extraGroups);
      added = res.added;
      failed = res.failed;
      addedNames = res.addedNames || [];
      rowsSeen = res.rowsSeen || 0;
      /* Picker bisa me-re-render composer Lexical (sama seperti attach
         media): pastikan caption masih utuh, ketik ulang bila berubah. */
      const editor = await findEditor(8000);
      if (!editor) throw new Error("Editor caption hilang setelah menutup popup Tambahkan grup.");
      const expected = normText(parse(caption || ""));
      if (expected && getEditorText(editor) !== expected) await typeCaption(editor, expected);
    }

    // 4. Jeda baca manusiawi sebelum submit
    await sleep(randInt(800, 1600));

    // 5. MODE MANUAL: jangan klik Posting — beri user jendela waktu.
    if (!autoPost) {
      console.log(`[FB-AutoPoster] Mode manual: media+caption+${added.length} grup tambahan siap di editor. Menunggu ${MANUAL_POST_WINDOW_MS / 1000}s agar user klik Posting sendiri.`);
      await sleep(MANUAL_POST_WINDOW_MS);
      return { ok: true, added, failed, addedNames, rowsSeen };
    }

    // 6. MODE AUTOPOSTING: klik tombol Posting
    const postBtn = await findPostButton(20000);
    if (!postBtn) throw new Error("Tombol Posting tidak ditemukan.");
    await humanScrollToEl(postBtn);
    postBtn.click();

    // 7. VERIFIKASI PASCA-SUBMIT: composer & preview media harus hilang.
    await waitFor(() => (findComposerDialog() || findMediaScope() ? null : true), { timeoutMs: 15000, label: "composer tertutup setelah klik Posting" }).catch(async () => {
      /* Composer masih terbuka -> coba sekali lagi (kadang klik pertama
         nyangkut saat upload belum selesai), lalu gagal permanen. */
      const retry = await findPostButton(5000);
      if (retry) {
        await humanScrollToEl(retry);
        retry.click();
      }
      await waitFor(() => (findComposerDialog() || findMediaScope() ? null : true), { timeoutMs: 15000, label: "composer tertutup (retry)" });
    });

    await sleep(randInt(1500, 2600));
    return { ok: true, added, failed, addedNames, rowsSeen };
  }

  content.posting = { postToGroup, openComposer, typeCaption, composeMediaAndCaption, addExtraGroups };
})(globalThis);
