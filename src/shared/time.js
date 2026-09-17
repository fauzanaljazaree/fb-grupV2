/* =========================================================
   FB Auto Poster - Shared: Waktu & Jeda
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  /** Jam lokal bertanda waktu untuk baris log: "09:41:07" */
  function nowStamp() {
    const d = new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  /** Tanggal lokal sebagai kunci statistik harian: "2026-09-14" */
  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  /** Jeda asinkron (Promise) — pengganti setTimeout yang lebih mudah di-await. */
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  FBAP.time = { nowStamp, todayKey, sleep };
})(globalThis);
