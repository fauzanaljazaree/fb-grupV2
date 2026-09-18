/* =========================================================
   FB Auto Poster - Background: Orchestrator Scan Daftar Grup
   Pola (adaptasi fb-grupV3): tombol dashboard hanya pemicu
   START_SCAN; eksekusi berat di sini via TAB SEMENTARA:

   tabs.create(GROUPS_FEED) -> waitTabLoaded -> settle ->
   requestScan(SCAN_GROUPS ke content) -> mergeGroups ->
   saveScanStatus(done|error) -> tabs.remove(tab).

   Status scan disimpan di STORAGE.SCAN_STATUS; kunci
   STORAGE.LAST_SCAN menyimpan metadata scan terakhir.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const background = (FBAP.background = FBAP.background || {});
  const { MSG, STORAGE, PAGES, LIMITS } = FBAP.config;
  const { sleep } = FBAP.time;
  const { get: storageGet, set: storageSet } = FBAP.storage;
  const { waitTabLoaded, ensureContentScript, sendToContent, focusDashboard } = background.tabs;
  const { log } = background.messaging;

  const ACTIVE_SCAN_STATES = ["loading", "scanning"];

  /** Tulis status scan ke storage + Live Log (bus status via onChanged). */
  async function saveScanStatus(state, message) {
    await storageSet({
      [STORAGE.SCAN_STATUS]: { state, message: message || "", at: new Date().toISOString() }
    });
    if (message) {
      const cls = state === "error" ? "err" : state === "done" ? "ok" : "info";
      await log(`Scan grup (${state}): ${message}`, cls);
    }
  }

  /** Guard anti-dobel: scan dianggap aktif bila state masih loading/scanning. */
  async function isScanActive() {
    const data = await storageGet([STORAGE.SCAN_STATUS]);
    const s = data[STORAGE.SCAN_STATUS];
    return !!(s && ACTIVE_SCAN_STATES.includes(s.state));
  }

  /** Kirim SCAN_GROUPS ke content script; fallback inject bila belum siap. */
  async function requestScan(tabId) {
    let res = await sendToContent(tabId, { type: MSG.SCAN_GROUPS }, LIMITS.SCAN_MSG_TIMEOUT_MS);
    if (res && res.ok) return res;
    /* FB SPA kadang content script belum terpasang — inject manual lalu ulang. */
    const injected = await ensureContentScript(tabId);
    if (!injected) throw new Error("Content script tidak bisa diinject ke tab scan");
    await sleep(800);
    res = await sendToContent(tabId, { type: MSG.SCAN_GROUPS }, LIMITS.SCAN_MSG_TIMEOUT_MS);
    if (!res || !res.ok) throw new Error((res && res.error) || "Scan tidak merespons");
    return res;
  }

  /** Gabungkan hasil scan ke STORAGE.GROUPS by url (dedupe + merge nama). */
  async function mergeGroups(result) {
    const incoming = ((result && result.groups) || []).filter((g) => g && g.url);
    const data = await storageGet([STORAGE.GROUPS]);
    const byUrl = new Map((data[STORAGE.GROUPS] || []).map((g) => [g.url, g]));
    let added = 0;
    for (const g of incoming) {
      const existing = byUrl.get(g.url);
      if (existing) {
        if (!existing.name && g.name) byUrl.set(g.url, { ...existing, name: g.name });
      } else {
        byUrl.set(g.url, { name: g.name || g.url, url: g.url });
        added++;
      }
    }
    const groups = [...byUrl.values()];
    const lastScan = {
      scannedAt: (result && result.scannedAt) || new Date().toISOString(),
      sourceUrl: (result && result.sourceUrl) || "",
      found: incoming.length,
      total: groups.length
    };
    await storageSet({ [STORAGE.GROUPS]: groups, [STORAGE.LAST_SCAN]: lastScan });
    return lastScan;
  }

  /** Orkestrator utama: tab sementara dibuka lalu DITUTUP di finally. */
  async function runScan() {
    let tab;
    try {
      tab = await chrome.tabs.create({ url: PAGES.GROUPS_FEED, active: true });
      await saveScanStatus("scanning", "Membuka halaman daftar grup...");
      await waitTabLoaded(tab.id, LIMITS.SCAN_TAB_TIMEOUT_MS);
      await sleep(LIMITS.SCAN_SETTLE_MS);
      const result = await requestScan(tab.id);
      const lastScan = await mergeGroups(result);
      await saveScanStatus("done", `${lastScan.found} grup ditemukan. Total tersimpan: ${lastScan.total}.`);
    } catch (e) {
      await saveScanStatus("error", (e && e.message) || String(e));
    } finally {
      if (tab && tab.id) {
        try { await chrome.tabs.remove(tab.id); } catch (e) { /* tab sudah tertutup */ }
      }
      /* Kembalikan fokus ke tab dashboard agar hasil scan langsung terlihat. */
      try { await focusDashboard(); } catch (e) { /* abaikan */ }
    }
  }

  background.scan = { runScan, isScanActive };
})(globalThis);
