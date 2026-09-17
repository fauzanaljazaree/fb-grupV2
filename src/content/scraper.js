/* =========================================================
   FB Auto Poster - Content: Scraper Daftar Grup
   CATATAN: mode input langsung tidak memakai scraper ini.
   Fungsi dipertahankan agar perintah EXECUTE_SCRAPE tetap
   berfungsi bila diaktifkan kembali dari dashboard.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const content = (FBAP.content = FBAP.content || {});
  const { randInt } = FBAP.random;
  const { sleep } = FBAP.time;
  const { SYSTEM_GROUP_URL } = content.selectors;
  const { normalizeUrl } = content.dom;
  const { humanScroll } = content.stealth;

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

  content.scraper = { scrapeGroups };
})(globalThis);
