/* =========================================================
   FB Auto Poster - Shared: Parser Spintax
   Caption boleh berisi {varian1|varian2} agar teks tiap
   postingan berbeda.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});

  /** Acak varian spintax: "{Halo|Hai} semua" -> "Hai semua". */
  function parse(text) {
    if (!text) return "";
    let out = String(text);
    out = out.replace(/\{([^{}]+)\}/g, (m, inner) => {
      const parts = inner.split("|").map((p) => p.trim()).filter(Boolean);
      return parts.length ? parts[Math.floor(Math.random() * parts.length)] : m;
    });
    return out;
  }

  FBAP.spintax = { parse };
})(globalThis);
