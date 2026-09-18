/* =========================================================
   FB Auto Poster - Content: Eksekusi Posting ke Grup
   Urutan: trigger composer -> editor -> LAMPIRKAN MEDIA DULU
           (GATE preview blob) -> tulis caption (Lexical-safe,
           anti-dobel) -> klik tombol Posting + verifikasi
           composer tertutup.
   openComposer() dipisah agar bisa dipakai ulang oleh pesan
   NAV_HOME_TO_COMPOSER (uji navigasi home -> grup -> composer).
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const content = (FBAP.content = FBAP.content || {});
  const { randInt } = FBAP.random;
  const { sleep } = FBAP.time;
  const { parse } = FBAP.spintax;
  const { CAPTION_EDITOR } = content.selectors;
  const { findEditor, findPostButton, waitForTextInTrigger, findComposerDialog, findMediaScope, waitFor } = content.dom;
  const { humanScrollToEl } = content.stealth;
  const { uploadMedia } = content.media;

  /* ---------------------------------------------------------
     FLAG DEVELOPMENT (DRY RUN)
     true  = isi caption+media tapi TIDAK klik tombol Posting.
     false = posting beneran (MODE PRODUKSI).
     --------------------------------------------------------- */
  const DRY_RUN_NO_SUBMIT = false;

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
     Dipakai oleh testCompose() (dry-run) DAN postToGroup() (produksi).
     ========================================================= */

  const normText = (s) => String(s || "").replace(/\s+/g, " ").trim();
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
        editor.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", bubbles: true, cancelable: true
        }));
        await sleep(120);
      }
      const line = lines[i];
      if (!line) continue;
      editor.focus();
      const beforeLen = getEditorText(editor).length;
      const ok = document.execCommand("insertText", false, line);
      await sleep(120); // Lexical commit async — JANGAN baca sinkron!
      const grew = getEditorText(editor).length > beforeLen;
      if (!ok || !grew) { // fallback paste
        const d = new DataTransfer();
        d.setData("text/plain", line);
        editor.dispatchEvent(new ClipboardEvent("paste", {
          clipboardData: d, bubbles: true, cancelable: true
        }));
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
    if (inserted.length < expected.length * 0.8)
      throw new Error(`Caption tidak penuh (${inserted.length}/${expected.length})`);
    const rest = inserted.slice(expected.length).trim();
    if (inserted.length > expected.length &&
        (rest === expected || (inserted.length >= expected.length * 1.9 && inserted.includes(expected)))) {
      await clearEditor(editor);
      await insertCaptionLines(editor, caption);
      const recheck = getEditorText(editor);
      if (recheck !== expected && recheck.length > expected.length * 1.4)
        throw new Error("Caption masih dobel setelah ketik ulang — stop.");
    }
  }

  /** Orkestrasi uji: composer -> uploadMedia DULU -> query editor ulang
      di scope preview -> typeCaption -> STOP (user klik Posting manual).
      Tidak menyentuh antrean / tombol Posting. */
  async function testCompose(caption, mediaDataUrl, mediaMime, mediaName) {
    const info = await composeMediaAndCaption(caption, mediaDataUrl, mediaMime, mediaName);
    // STOP di sini — user klik Posting manual (tanpa submit otomatis)
    return { dialog: info.dialog, editorText: info.editorText };
  }

  /* =========================================================
     INTI BERSAMA (eksekusi): composer -> media DULU + GATE ->
     query editor ulang -> typeCaption. Dipakai postToGroup &
     testCompose supaya urutan media-dulu hanya ditulis sekali.
     ========================================================= */
  async function composeMediaAndCaption(caption, mediaDataUrl, mediaMime, mediaName) {
    // 1. Buka composer (idempoten — reuse editor bila sudah terbuka)
    const editor0 = await openComposer();

    // 2. Dialog composer ASLI (dicari dari ISI, bukan aria-label)
    const dialog = findComposerDialog() ||
                   (editor0.closest('div[role="dialog"]') || null);

    // 3. MEDIA DULU + GATE preview blob (skip bila materi tanpa media)
    if (mediaDataUrl) {
      const ok = await uploadMedia(dialog, mediaDataUrl, mediaMime, mediaName);
      if (!ok) throw new Error("Gagal melampirkan media (GATE preview tidak lolos).");
    }

    // 4. Query editor SETELAH media — node fresh; scope preview media DULU
    const editor = await waitFor(() => {
      const ms = findMediaScope();
      if (ms && ms.querySelector(CAPTION_EDITOR)) return ms.querySelector(CAPTION_EDITOR);
      const live = dialog && document.contains(dialog) ? dialog : null;
      if (live && live.querySelector(CAPTION_EDITOR)) return live.querySelector(CAPTION_EDITOR);
      return document.querySelector(CAPTION_EDITOR);
    }, { label: "editor Lexical di scope preview media" });

    editor.scrollIntoView({ block: "center" });
    await sleep(300);

    // 5. Tulis caption (spintax di-resolve)
    const finalText = parse(caption || "");
    await typeCaption(editor, finalText);

    return { dialog, editor, editorText: getEditorText(editor) };
  }

  /** Posting satu materi: inti media-dulu + caption, LALU submit.
      Verifikasi pasca-submit: composer harus tertutup, bila tidak ->
      throw (scheduler mencatat GAGAL, antrean tidak maju palsu). */
  async function postToGroup(caption, mediaDataUrl, mediaMime, mediaName) {
    // 1-3. Media DULU (GATE) -> editor ulang -> caption Lexical anti-dobel
    const info = await composeMediaAndCaption(caption, mediaDataUrl, mediaMime, mediaName);

    // 4. Jeda baca manusiawi sebelum submit
    await sleep(randInt(800, 1600));

    // 5. Klik tombol Posting — KECUALI mode DRY RUN
    if (DRY_RUN_NO_SUBMIT) {
      console.log("[FB-AutoPoster][DRY-RUN] Skip klik tombol Posting. Media/caption sudah terisi.");
      return true;
    }
    const postBtn = await findPostButton(20000);
    if (!postBtn) throw new Error("Tombol Posting tidak ditemukan.");
    await humanScrollToEl(postBtn);
    postBtn.click();

    // 6. VERIFIKASI PASCA-SUBMIT: composer & preview media harus hilang.
    await waitFor(() => (findComposerDialog() || findMediaScope() ? null : true),
      { timeoutMs: 15000, label: "composer tertutup setelah klik Posting" }
    ).catch(async () => {
      /* Composer masih terbuka -> coba sekali lagi (kadang klik pertama
         nyangkut saat upload belum selesai), lalu gagal permanen. */
      const retry = await findPostButton(5000);
      if (retry) { await humanScrollToEl(retry); retry.click(); }
      await waitFor(() => (findComposerDialog() || findMediaScope() ? null : true),
        { timeoutMs: 15000, label: "composer tertutup (retry)" });
    });

    await sleep(randInt(1500, 2600));
    return true;
  }

  content.posting = { postToGroup, openComposer, typeCaption, testCompose, composeMediaAndCaption };
})(globalThis);
