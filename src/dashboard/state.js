/* =========================================================
   FB Auto Poster - Dashboard: State UI
   Satu sumber kebenaran untuk data yang tampil di dashboard.
   Modul lain membaca/menulis lewat FBAP.dashboard.state.State.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const dashboard = (FBAP.dashboard = FBAP.dashboard || {});
  const { DEFAULTS } = FBAP.config;

  const State = {
    materials: [],       // [{account, caption, mediaName, available, mediaDataUrl, mediaMime}] hasil filter akun
    allMaterials: [],    // semua baris hasil import (sebelum difilter akun, in-memory)
    groups: [],          // [{name, url}]
    selected: new Set(), // url grup terpilih
    settings: { ...DEFAULTS.settings },
    running: false
  };

  dashboard.state = { State };
})(globalThis);
