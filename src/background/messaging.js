/* =========================================================
   FB Auto Poster - Background: Log & Sinyal ke Dashboard
   Log disimpan ke storage (riwayat 500 baris terakhir) dan
   dikirim realtime via chrome.runtime.sendMessage.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const background = (FBAP.background = FBAP.background || {});
  const { MSG, STORAGE, LIMITS } = FBAP.config;
  const { nowStamp } = FBAP.time;
  const { get: storageGet, set: storageSet } = FBAP.storage;
  const { run } = background.state;

  /** Tulis satu baris log ke storage + kirim ke dashboard. */
  async function log(text, cls = "mut") {
    const entry = { text: `[${nowStamp()}] ${text}`, cls, t: Date.now() };
    const data = await storageGet([STORAGE.POSTING_LOGS]);
    const logs = data[STORAGE.POSTING_LOGS] || [];
    logs.push(entry);
    if (logs.length > LIMITS.MAX_LOG_ENTRIES) {
      logs.splice(0, logs.length - LIMITS.MAX_LOG_ENTRIES);
    }
    await storageSet({ [STORAGE.POSTING_LOGS]: logs });
    chrome.runtime.sendMessage({ type: MSG.LOG, text: entry.text, cls }).catch(() => {});
  }

  /** Ubah status running + beri tahu dashboard. */
  async function setRunning(v) {
    run.running = v;
    await storageSet({ [STORAGE.STATUS]: { running: v } });
    chrome.runtime.sendMessage({ type: MSG.STATE, running: v }).catch(() => {});
  }

  /** Kirim sisa antrean + jadwal posting berikutnya ke dashboard. */
  async function broadcastQueueInfo() {
    const remaining = Math.max(0, run.queue.length - run.cursor);
    chrome.runtime.sendMessage({ type: MSG.QUEUE_INFO, remaining, nextAt: run.nextAt || 0 }).catch(() => {});
  }

  background.messaging = { log, setRunning, broadcastQueueInfo };
})(globalThis);
