/* =========================================================
   FB Auto Poster - Dashboard: Helper UI (DOM & Log)
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const dashboard = (FBAP.dashboard = FBAP.dashboard || {});
  const { State } = dashboard.state;
  const { nowStamp } = FBAP.time;

  /** Pintasan document.getElementById. */
  const $ = (id) => document.getElementById(id);

  /** Amankan teks sebelum dimasukkan ke innerHTML. */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  /** Tambah satu baris ke terminal log. */
  function addLog(msg, cls = "mut") {
    const term = $("terminal");
    const line = document.createElement("div");
    line.className = "line";
    line.innerHTML = `<span class="t">[${nowStamp()}]</span><span class="${cls}">${escapeHtml(msg)}</span>`;
    term.appendChild(line);
    term.scrollTop = term.scrollHeight;
  }

  /** Sinkronkan indikator status + tombol Start/Stop. */
  function setStatus(running) {
    State.running = running;
    const pill = $("statusPill");
    pill.className = "status-pill" + (running ? " running" : " paused");
    $("statusText").textContent = running ? "Berjalan" : "Idle";
    $("btnStart").disabled = running;
    $("btnStop").disabled = !running;
  }

  /* ---------------- AKUN FB MANUAL (textbox + centang tersimpan) ---------------- */

  /** Tampilkan spinner kecil (sedang menulis ke storage). */
  function showSaving() {
    const tick = $("accountSavedTick");
    tick.className = "saving-tick";
    tick.textContent = "";
    tick.title = "Menyimpan ke chrome storage…";
  }

  /** Centang hijau + animasi pop = data akun SUDAH tersimpan di storage
      (dipicu oleh storage.onChanged, bukan asumsi UI). */
  function showSaved() {
    const tick = $("accountSavedTick");
    tick.className = "saved-tick pop";
    tick.textContent = "✓";
    tick.title = "Tersimpan di chrome storage";
  }

  /** Ikon amber sekejap = penyimpanan gagal. */
  function showSaveError() {
    const tick = $("accountSavedTick");
    tick.className = "error-tick";
    tick.textContent = "!";
    tick.title = "Gagal menyimpan";
  }

  /** Isi nilai textbox nama akun (dipakai saat init dari storage). */
  function setAccountName(value) {
    $("accountNameInput").value = value || "";
  }

  dashboard.ui = { $, escapeHtml, addLog, setStatus, setAccountName, showSaving, showSaved, showSaveError };
})(globalThis);
