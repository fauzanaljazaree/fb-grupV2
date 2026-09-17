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

  dashboard.ui = { $, escapeHtml, addLog, setStatus };
})(globalThis);
