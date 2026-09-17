/* =========================================================
   FB Auto Poster - Shared: Utilitas Angka Acak
   Dipakai agar pola aktivitas tidak seragam (anti-bot).
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});

  /** Bilangan bulat acak, batas a dan b ikut disertakan: randInt(1, 5) -> 1..5 */
  function randInt(a, b) {
    return Math.floor(a + Math.random() * (b - a + 1));
  }

  /** Distribusi normal (Box-Muller) supaya jeda terasa lebih manusiawi. */
  function gauss(mean = 0, sd = 1) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mean + z * sd;
  }

  FBAP.random = { randInt, gauss };
})(globalThis);
