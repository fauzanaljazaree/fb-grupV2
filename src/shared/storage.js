/* =========================================================
   FB Auto Poster - Shared: Pembungkus chrome.storage.local
   Versi Promise dari API callback Chrome.

   Catatan soal error (mempertahankan perilaku asli tiap konteks):
   - get()       : selalu resolve.
   - set()       : selalu resolve; error diabaikan. Dipakai pada alur
                   kritis posting supaya kegagalan tulis storage tidak
                   pernah menggagalkan/menggantung proses.
   - setStrict() : reject bila chrome.runtime.lastError ada. Dipakai
                   dashboard yang memang memasang .catch()/try-catch.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});

  function get(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function set(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  function setStrict(obj) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(obj, () => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      });
    });
  }

  FBAP.storage = { get, set, setStrict };
})(globalThis);
