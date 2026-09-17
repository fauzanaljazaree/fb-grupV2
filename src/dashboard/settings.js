/* =========================================================
   FB Auto Poster - Dashboard: Bagian 2 - Pengaturan Anti-Bot
   Jeda antar posting, limit harian, dan cooldown berkala.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const dashboard = (FBAP.dashboard = FBAP.dashboard || {});
  const { DEFAULTS, STORAGE } = FBAP.config;
  const { setStrict } = FBAP.storage;
  const { State } = dashboard.state;
  const { $, addLog } = dashboard.ui;

  /** Tulis nilai pengaturan ke form. */
  function fillSettingsForm(s) {
    $("inpMinDelay").value = s.minDelay;
    $("inpMaxDelay").value = s.maxDelay;
    $("inpDailyLimit").value = s.dailyLimit;
    $("inpCooldownEvery").value = s.cooldownEvery;
    $("inpCooldownMinutes").value = s.cooldownMinutes;
    $("cdEveryText").textContent = s.cooldownEvery;
  }

  $("btnSaveSettings").addEventListener("click", async () => {
    const min = parseInt($("inpMinDelay").value, 10);
    const max = parseInt($("inpMaxDelay").value, 10);
    const daily = parseInt($("inpDailyLimit").value, 10);
    const every = parseInt($("inpCooldownEvery").value, 10);
    const minutes = parseInt($("inpCooldownMinutes").value, 10);
    if (!min || !max || min < 1 || max < min) {
      addLog("Min/Maks jeda tidak valid (pastikan maks >= min).", "err");
      return;
    }
    State.settings = {
      minDelay: min, maxDelay: max, dailyLimit: daily || 1,
      cooldownEvery: every || 1, cooldownMinutes: minutes || 1
    };
    await setStrict({ [STORAGE.SETTINGS]: State.settings });
    fillSettingsForm(State.settings);
    addLog(`Pengaturan disimpan: jeda ${min}-${max}s, limit ${State.settings.dailyLimit}/hari, cooldown tiap ${every} posting ${minutes}m.`, "ok");
  });

  /* Tombol Reset: isi form dengan nilai default. Nilai baru tersimpan
     setelah user menekan "Simpan Pengaturan". */
  $("btnResetSettings").addEventListener("click", () => {
    fillSettingsForm(DEFAULTS.settings);
    addLog('Form pengaturan dikembalikan ke nilai default. Tekan "Simpan Pengaturan" untuk menerapkan.', "info");
  });

  dashboard.settings = { fillSettingsForm };
})(globalThis);
