/* =========================================================
   FB Auto Poster - Content: Eksekusi Posting ke Grup
   Urutan: trigger composer -> editor -> tulis caption ->
           lampirkan media -> klik tombol Posting.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const content = (FBAP.content = FBAP.content || {});
  const { randInt } = FBAP.random;
  const { sleep } = FBAP.time;
  const { parse } = FBAP.spintax;
  const { findEditor, findPostButton, waitForTextInTrigger } = content.dom;
  const { humanScrollToEl, typeLikeHuman } = content.stealth;
  const { attachMedia } = content.media;

  /* ---------------------------------------------------------
     FLAG DEVELOPMENT (DRY RUN)
     true  = isi caption+media tapi TIDAK klik tombol Posting.
     false = posting beneran (MODE PRODUKSI).
     --------------------------------------------------------- */
  const DRY_RUN_NO_SUBMIT = false;

  async function postToGroup(caption, mediaDataUrl, mediaMime, mediaName) {
    // 1. Trigger composer: klik "Tulis sesuatu..." / "Write something..."
    const trigger = await waitForTextInTrigger(15000, ["tulis sesuatu", "write something", "buat postingan"]);
    if (trigger) {
      await humanScrollToEl(trigger);
      trigger.click();
      await sleep(randInt(1200, 2400));
    }

    // 2. Editor contenteditable
    const editor = await findEditor(30000);
    if (!editor) throw new Error("Editor postingan tidak ditemukan.");

    // 3. Ketik caption (spintax di-resolve)
    const finalText = parse(caption || "");
    if (finalText) {
      await sleep(randInt(400, 900));
      await typeLikeHuman(editor, finalText);
      await sleep(randInt(300, 700));
    }

    // 4. Attach media bila ada
    if (mediaDataUrl) {
      const ok = await attachMedia(mediaDataUrl, mediaMime, mediaName);
      if (!ok) throw new Error("Gagal melampirkan media.");
      await sleep(randInt(2500, 4000)); // tunggu upload
    }

    // 5. Klik tombol Posting — KECUALI mode DRY RUN
    if (DRY_RUN_NO_SUBMIT) {
      console.log("[FB-AutoPoster][DRY-RUN] Skip klik tombol Posting. Media/caption sudah terisi.");
      return true;
    }
    const postBtn = await findPostButton(20000);
    if (!postBtn) throw new Error("Tombol Posting tidak ditemukan.");
    await humanScrollToEl(postBtn);
    postBtn.click();
    await sleep(randInt(1500, 2600));
    return true;
  }

  content.posting = { postToGroup };
})(globalThis);
