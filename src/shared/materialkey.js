/* =========================================================
   FB Auto Poster - Shared: Fingerprint Materi (materialKey)
   Kunci stabil untuk mencocokkan materi lama vs baru TANPA
   bergantung pada urutan baris Excel. Dipakai background
   (scheduler menulis matriks status) dan dashboard (menampilkan
   status per materi). Tidak bergantung modul lain.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});

  /** Normalisasi teks: lowercase + trim + spasi dirapikan + buang BOM. */
  function norm(s) {
    return String(s || "").toLowerCase().trim().replace(/\s+/g, " ").replace(/^\uFEFF/, "");
  }

  /**
   * Fingerprint stabil satu materi: hash pendek (djb2, 32-bit) dari
   * `account|caption|mediaName` yang sudah dinormalisasi. Caption sama
   * (walau urutan baris Excel berubah) -> kunci sama -> status lama
   * di matriks POST_MATRIX tetap tercocokkan.
   */
  function materialKey(m) {
    const base = `${norm(m && m.account)}|${norm(m && m.caption)}|${norm(m && m.mediaName)}`;
    let h = 5381;
    for (let i = 0; i < base.length; i++) h = ((h << 5) + h + base.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  FBAP.materialKey = { norm, materialKey };
})(globalThis);