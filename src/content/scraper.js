/* =========================================================
   FB Auto Poster - Content: Scraper Daftar Grup
   Dua mode:
   - scanGroups()   : scan SIDEBAR /groups/feed/ via perintah
                      SCAN_GROUPS (pola fb-grupV3: loop scroll
                      sidebar + collect anchor grup).
   - scrapeGroups() : mode lama EXECUTE_SCRAPE (scroll window),
                      dipertahankan agar tetap berfungsi.
   Hasil: [{name, url}] dengan URL ternormalisasi ke
   https://www.facebook.com/groups/{id}.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const content = (FBAP.content = FBAP.content || {});
  const { LIMITS } = FBAP.config;
  const { randInt } = FBAP.random;
  const { sleep } = FBAP.time;
  const { SYSTEM_GROUP_URL, SIDEBAR_NAV, SIDEBAR_NAV_EN } = content.selectors;
  const { normalizeUrl } = content.dom;
  const { humanScroll } = content.stealth;

  /* ---------- PENGUMPUL ANCHOR (dipakai kedua mode) ---------- */

  /** Anchor grup valid: bukan halaman sistem + punya id grup. */
  function isValidGroupHref(url) {
    if (!url) return false;
    if (SYSTEM_GROUP_URL.test(url)) return false;
    return /\/groups\/(\d+|[a-zA-Z0-9._-]+)/.test(url);
  }

  /** Kumpulkan grup dari a[href*="/groups/"] di bawah root ke Map by url. */
  function collectGroups(groups, scope) {
    const scopeRoot = scope || document;
    const anchors = scopeRoot.querySelectorAll('a[href*="/groups/"]');
    let added = 0;
    anchors.forEach((a) => {
      const url = normalizeUrl(a.getAttribute("href"));
      if (!isValidGroupHref(url)) return;
      if (groups.has(url)) return;
      const name = (a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
      if (!name) return;
      groups.set(url, { name, url });
      added++;
    });
    return added;
  }

  /* ---------- PENCARI SIDEBAR (pola fb-grupV3) ---------- */

  /** Sidebar kiri = ancestor scrollable yang benar-benar mengandung
      anchor /groups/. Bila tak ketemu, pakai role="navigation". */
  function findSidebar() {
    const anchor = document.querySelector('a[href*="/groups/"]');
    if (anchor) {
      let node = anchor.parentElement;
      while (node && node !== document.body) {
        const overflowy = getComputedStyle(node).overflowY;
        const scrollable = node.scrollHeight > node.clientHeight + 8 &&
          (overflowy === "auto" || overflowy === "scroll" || node.getAttribute("role") === "navigation");
        if (scrollable) return node;
        node = node.parentElement;
      }
    }
    for (const sel of [SIDEBAR_NAV, SIDEBAR_NAV_EN]) {
      const nav = document.querySelector(sel);
      if (nav) return nav;
    }
    return document.scrollingElement || document.documentElement;
  }

  /** Mentok bawah: tunggu hingga DOM berhenti bertambah (FB memuat
      item berikutnya secara lazy) sebelum menyerah. */
  async function waitForBottomIdle(sidebar, groups, deadline) {
    let stable = 0;
    let lastCount = groups.size;
    while (stable < 3 && Date.now() < deadline) {
      collectGroups(groups, sidebar);
      await sleep(700);
      const grew = groups.size > lastCount ||
        sidebar.scrollHeight > sidebar.clientHeight + sidebar.scrollTop + 8;
      if (grew) stable = 0;
      else stable++;
      lastCount = groups.size;
    }
    collectGroups(groups, sidebar);
  }

  /* ---------- SCAN UTAMA (perintah SCAN_GROUPS) ---------- */

  /** Scan sidebar /groups/feed/: tunggu render -> loop scroll (maks
      LIMITS.SCAN_MAX_PASSES) -> kumpulkan -> balas ke background. */
  async function scanGroups() {
    const groups = new Map();
    await sleep(3000); /* beri waktu React FB merender sidebar */
    const sidebar = findSidebar();
    const deadline = Date.now() + LIMITS.SCAN_TAB_TIMEOUT_MS;
    for (let pass = 0; pass < LIMITS.SCAN_MAX_PASSES; pass++) {
      collectGroups(groups, sidebar);
      const step = Math.max(320, Math.round(sidebar.clientHeight * 0.75));
      sidebar.scrollTo({ top: sidebar.scrollTop + step, behavior: "auto" });
      await sleep(randInt(650, 900));
      const reachedBottom =
        sidebar.scrollTop + sidebar.clientHeight >= sidebar.scrollHeight - 8;
      if (reachedBottom) {
        await waitForBottomIdle(sidebar, groups, deadline);
        break;
      }
    }
    return {
      sourceUrl: location.href,
      scannedAt: new Date().toISOString(),
      groups: [...groups.values()]
    };
  }

  /** Kumpulkan grup dari halaman /groups/joins/ dengan scroll bertahap. */
  async function scrapeGroups() {
    const results = [];
    const seen = new Set();

    const collect = () => {
      const anchors = document.querySelectorAll('a[role="link"][href*="/groups/"]');
      let added = 0;
      anchors.forEach((a) => {
        const href = normalizeUrl(a.getAttribute("href"));
        if (!href) return;
        if (SYSTEM_GROUP_URL.test(href)) return;
        if (seen.has(href)) return;
        const name = (a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
        if (!name || !/\/groups\/(\d+|[a-zA-Z0-9._-]+)/.test(href)) return;
        seen.add(href);
        results.push({ name, url: href });
        added++;
      });
      return added;
    };

    collect();
    let stable = 0;
    let guard = 0;
    const MAX_TRIES = 40;
    while (stable < 3 && guard < MAX_TRIES) {
      guard++;
      const before = document.body ? document.body.scrollHeight : 0;
      await humanScroll(window, 1400);
      await sleep(randInt(900, 1600));
      const after = document.body ? document.body.scrollHeight : 0;
      const added = collect();
      if (after > before + 50 || added > 0) stable = 0;
      else stable++;
    }
    try { window.scrollTo({ top: 0, behavior: "auto" }); } catch (e) {}
    return results;
  }

  content.scraper = { scanGroups, scrapeGroups, findSidebar, collectGroups, isValidGroupHref };
})(globalThis);
