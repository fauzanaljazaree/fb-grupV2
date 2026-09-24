/* =========================================================
   FB Auto Poster - Dashboard: Deteksi Akun FB (otomatis + tombol ↻)
   Tiga lapis pengisian nama akun di textbox header:
     1. OTOMATIS — `detectOnStartup()` dipanggil main.js setiap dashboard
        dibuka. Background mengambil nama akun yang sedang login lewat TAB
        DETEKSI SEMENTARA (dibuka & ditutup background; fokus tetap di
        dashboard), hasilnya dikirim balik ke sini.
     2. TOMBOL ↻ (btnRefreshAccount) — deteksi ulang manual bila lapis 1
        gagal (mis. tab FB sempat tidak siap).
     3. KETIK MANUAL — handler lama di controls.js tetap berlaku sebagai
        backup terakhir; nama yang diketik user TIDAK pernah ditimpa oleh
        hasil deteksi yang datang belakangan.
   Gagal deteksi: textbox TIDAK dikosongkan (nama lama tetap dipakai untuk
   filter materi) — hanya tick amber + satu baris log peringatan.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const dashboard = (FBAP.dashboard = FBAP.dashboard || {});
  const { MSG } = FBAP.config;
  const { $, addLog, setAccountName, showSaving, showSaved, showDetectError } = dashboard.ui;
  const { sendMsg } = dashboard.controls;

  /* Deteksi otomatis hanya sekali per pembukaan dashboard. */
  let autoTried = false;

  /** Nonaktifkan tombol deteksi + putar ikonnya selama proses berjalan. */
  function setBusy(busy) {
    const btn = $("btnRefreshAccount");
    btn.disabled = busy;
    btn.classList.toggle("spin", busy);
  }

  /** Kirim permintaan deteksi ke background dan terapkan hasilnya.
      `auto` = true saat dipicu pembukaan dashboard (hanya untuk teks log). */
  async function runDetect(auto) {
    const before = $("accountNameInput").value.trim();
    setBusy(true);
    showSaving();
    const res = await sendMsg({ type: MSG.GET_ACCOUNT_NAME });
    setBusy(false);
    const label = auto ? "Deteksi akun otomatis" : "Deteksi ulang akun";

    if (res && res.ok && res.name) {
      const typed = $("accountNameInput").value.trim();
      if (typed && typed !== before) {
        /* User mengetik manual saat deteksi berjalan: harkat manual menang
           (ketikan tidak pernah ditelan hasil deteksi yang datang telat). */
        showSaved();
        addLog(`${label}: terdeteksi "${res.name}" — nama manual "${typed}" yang dipertahankan.`, "info");
        return res.name;
      }
      setAccountName(res.name);
      showSaved();
      addLog(`${label}: ${res.name}`, "ok");
      /* Filter materi memakai nama akun aktif (textbox), jadi re-filter
         setelah nama berubah. */
      try { dashboard.materials.applyAccountFilter(); } catch (e) { /* abaikan */ }
      return res.name;
    }

    showDetectError();
    const reason = (res && res.error) || "background tidak merespons";
    addLog(`${label} gagal: ${reason} Nama akun yang lama tetap dipakai — ketik manual bila perlu.`, "warn");
    return null;
  }

  /** Dipanggil main.js setelah state lama dipulihkan (fire-and-forget). */
  async function detectOnStartup() {
    if (autoTried) return null;
    autoTried = true;
    return runDetect(true);
  }

  $("btnRefreshAccount").addEventListener("click", () => { runDetect(false).catch(() => {}); });

  dashboard.account = { detectOnStartup, runDetect };
})(globalThis);
