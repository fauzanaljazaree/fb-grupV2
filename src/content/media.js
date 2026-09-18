/* =========================================================
   FB Auto Poster - Content: Media (data URL -> File -> input)
   Materi dikirim background sebagai data URL, lalu diubah
   menjadi File dan ditempel ke input file composer.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const content = (FBAP.content = FBAP.content || {});
  const { FILE_SELECTOR, FILE_INPUT } = content.selectors;
  const { waitForSelectorAny, isElementVisible, waitFor, findMediaBlobs } = content.dom;

  function dataUrlToBlob(dataUrl, mime) {
    const [head, b64] = dataUrl.split(",");
    mime = mime || (head.match(/data:([^;]+)/) || [])[1] || "application/octet-stream";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function guessExt(mime) {
    return (mime.match(/\/(\w+)/) || [])[1] || "bin";
  }

  /** Cari input[type=file] paling akurat untuk composer:
      1. dialog yang memuat tombol "Foto/video" (jangkar terbaik)
      2. input di dalam dialog composer
      3. input visible di document
      4. input pertama di document (jaring pengaman) */
  function resolveFileInput(dialog) {
    const liveDialog = dialog && document.contains(dialog) ? dialog : null;
    if (liveDialog &&
        liveDialog.querySelector('div[role="button"][aria-label="Foto/video"]') &&
        liveDialog.querySelector(FILE_INPUT)) {
      return liveDialog.querySelector(FILE_INPUT);
    }
    if (liveDialog) {
      const inDialog = liveDialog.querySelector(FILE_INPUT);
      if (inDialog) return inDialog;
    }
    return Array.from(document.querySelectorAll(FILE_INPUT)).find(isElementVisible) ||
           Array.from(document.querySelectorAll(FILE_INPUT))[0] || null;
  }

  /** Lampirkan media ke input file composer dengan GATE preview blob.
      Urutan WAJIB: attach media harus selesai (preview ter-render) SEBELUM
      caption diketik — attach me-re-render composer Lexical sehingga caption
      yang sudah ada ikut terhapus. */
  async function attachMedia(dataUrl, mime, name) {
    const blob = dataUrlToBlob(dataUrl, mime);
    const file = new File([blob], name || "media_" + Date.now() + "." + guessExt(mime), { type: mime });
    const input = await waitForSelectorAny(FILE_SELECTOR.split(","), 15000);
    if (!input) return false;
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  /** Upload media via input[type=file] + GATE preview (workflow uji post).
      mediaDataUrl dikirim sebagai dataURL base64 dari background/dashboard,
      dikonversi ke File di sini (File tidak bisa lewat chrome messaging). */
  async function uploadMedia(dialog, mediaDataUrl, mediaMime, mediaName) {
    if (!mediaDataUrl || !mediaName) return false;

    const input = await waitFor(() => resolveFileInput(dialog), {
      label: 'input[type="file"] di composer'
    });

    let file;
    try {
      const blob = await (await fetch(mediaDataUrl)).blob();
      file = new File([blob], mediaName, { type: blob.type || mediaMime });
    } catch (e) {
      /* FALLBACK: fetch dataURL gagal (dataURL rusak/terpotong) ->
         jalur lama attachMedia (atob manual via dataUrlToBlob). */
      const ok = await attachMedia(mediaDataUrl, mediaMime, mediaName);
      if (!ok) throw new Error("Gagal mengonversi media menjadi File.");
    }
    const before = findMediaBlobs(dialog);
    const isVideo = /\.(mp4|mov|webm|m4v)$/i.test(mediaName) ||
                    (file && file.type || "").startsWith("video/");

    if (file) {
      /* React FB butuh NATIVE setter + dispatch input+change (bubbles). */
      const dt = new DataTransfer();
      dt.items.add(file);
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "files").set.call(input, dt.files);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    /* GATE MEDIA: jangan lanjut sebelum preview blob BARU ter-render.
       Video tunggu video[blob] readyState>=2, foto tunggu img[blob]. */
    await waitFor(() => {
      const now = findMediaBlobs(dialog);
      return isVideo ? now.videoBlob > before.videoBlob : now.imgBlob > before.imgBlob;
    }, { timeoutMs: 20000, label: `preview media "${mediaName}" muncul` });
    return true;
  }

  content.media = { dataUrlToBlob, guessExt, resolveFileInput, attachMedia, uploadMedia };
})(globalThis);
