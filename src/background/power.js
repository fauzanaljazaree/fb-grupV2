/* =========================================================
   FB Auto Poster - Background: Keep Awake (chrome.power)
   Supaya sistem tidak tidur selama proses posting panjang.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const background = (FBAP.background = FBAP.background || {});

  function keepAwakeOn() {
    try { chrome.power.requestKeepAwake("system"); } catch (e) { }
  }

  function keepAwakeOff() {
    try { chrome.power.releaseKeepAwake(); } catch (e) { }
  }

  background.power = { keepAwakeOn, keepAwakeOff };
})(globalThis);
