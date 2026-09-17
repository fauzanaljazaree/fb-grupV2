/* =========================================================
   FB Auto Poster - Dashboard: Entry Point (main.js)
   File TERAKHIR yang dimuat dashboard.html: memasang penangkap
   error global lalu menjalankan inisialisasi state dari storage.

   Urutan <script> di dashboard.html:
   shared/* -> dashboard/state -> ui -> materials -> settings
            -> groups -> controls -> main
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const dashboard = (FBAP.dashboard = FBAP.dashboard || {});
  const { STORAGE } = FBAP.config;
  const { get } = FBAP.storage;
  const { State } = dashboard.state;
  const { $, addLog } = dashboard.ui;
  const { renderMaterials } = dashboard.materials;
  const { fillSettingsForm } = dashboard.settings;
  const { renderGroups } = dashboard.groups;
  const { syncStatus } = dashboard.controls;

  /* Catch dini: kalau ada error saat evaluasi script, tampilkan di Console
     dengan meta info — agar tidak "membisu" saat eksekusi gagal sebelum
     seluruh listener terpasang. */
  root.addEventListener("error", (e) => {
    try {
      console.error("[Dashboard-InitError]", e.message, "\nsource:", e.filename, "\nline:", e.lineno, "\ncol:", e.colno);
    } catch (_) {}
  });

  /** Muat seluruh state dari storage lalu render UI. */
  async function init() {
    const data = await get([
      STORAGE.SETTINGS,
      STORAGE.GROUPS,
      STORAGE.SELECTED_GROUPS,
      STORAGE.MATERIALS,
      STORAGE.POSTING_LOGS,
      STORAGE.UI
    ]);
    if (data[STORAGE.SETTINGS]) {
      State.settings = { ...State.settings, ...data[STORAGE.SETTINGS] };
    }
    if (data[STORAGE.UI] && typeof data[STORAGE.UI].showFbTab === "boolean") {
      $("chkShowFb").checked = data[STORAGE.UI].showFbTab;
    }
    // Selalu isi form dengan default agar user bisa langsung lihat & ubah.
    fillSettingsForm(State.settings);
    State.groups = data[STORAGE.GROUPS] || [];
    State.selected = new Set(data[STORAGE.SELECTED_GROUPS] || []);
    State.materials = data[STORAGE.MATERIALS] || [];
    renderGroups();
    renderMaterials();
    /* Status tombol Start/Stop diambil dari background (memori + alarm), bukan
       dari kunci `status` di storage yang bisa tertinggal dari sesi lama. */
    const running = await syncStatus();
    const logs = data[STORAGE.POSTING_LOGS] || [];
    if (logs.length && !running) {
      logs.forEach((l) => addLog(l.text, l.cls));
      $("terminal").scrollTop = $("terminal").scrollHeight;
    }
    addLog("Dashboard siap. Import materi, pilih grup, lalu jalankan.", "info");
  }

  dashboard.main = { init };
  init();
})(globalThis);
