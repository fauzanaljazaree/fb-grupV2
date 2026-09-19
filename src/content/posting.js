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
  const { MANUAL_POST_WINDOW_MS } = FBAP.config.LIMITS;
  const { randInt } = FBAP.random;
  const { sleep } = FBAP.time;
  const { parse } = FBAP.spintax;
  const { CAPTION_EDITOR } = content.selectors;
  const { findEditor, findPostButton, waitForTextInTrigger, findComposerDialog, findMediaScope, waitFor } = content.dom;
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
      `autoPost` (checkbox "autoposting" dashboard):
        true  -> klik tombol Posting otomatis + VERIFIKASI composer tertutup
                 (bila tidak tertutup -> throw, scheduler mencatat GAGAL).
        false -> cukup sampai media dimuat & caption tertulis; beri user
                 MANUAL_POST_WINDOW_MS untuk klik Posting sendiri. Setelah
                 jendela berakhir, alur tetap lanjut apa pun yang terjadi
                 (hasil klik user tidak diperiksa — draft dibiarkan apa adanya). */
  async function postToGroup(caption, mediaDataUrl, mediaMime, mediaName, autoPost = true) {
    // 1-3. Media DULU (GATE) -> editor ulang -> caption Lexical anti-dobel
    await composeMediaAndCaption(caption, mediaDataUrl, mediaMime, mediaName);

    // 4. Jeda baca manusiawi sebelum submit
    await sleep(randInt(800, 1600));

    // 5. MODE MANUAL: jangan klik Posting — beri user jendela waktu.
    if (!autoPost) {
      console.log(`[FB-AutoPoster] Mode manual: media+caption siap di editor. Menunggu ${MANUAL_POST_WINDOW_MS / 1000}s agar user klik Posting sendiri.`);
      await sleep(MANUAL_POST_WINDOW_MS);
      return true;
    }

    // 6. MODE AUTOPOSTING: klik tombol Posting
    const postBtn = await findPostButton(20000);
    if (!postBtn) throw new Error("Tombol Posting tidak ditemukan.");
    await humanScrollToEl(postBtn);
    postBtn.click();

    // 7. VERIFIKASI PASCA-SUBMIT: composer & preview media harus hilang.
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

  content.posting = { postToGroup, openComposer, typeCaption, composeMediaAndCaption };
})(globalThis);
