/* =========================================================
   FB Auto Poster - Content: Media (data URL -> File -> input)
   Materi dikirim background sebagai data URL, lalu diubah
   menjadi File dan ditempel ke input file composer.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const content = (FBAP.content = FBAP.content || {});
  const { FILE_SELECTOR } = content.selectors;
  const { waitForSelectorAny } = content.dom;

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

  /** Lampirkan media ke dialog composer. */
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

  content.media = { dataUrlToBlob, guessExt, attachMedia };
})(globalThis);
