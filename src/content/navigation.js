/* =========================================================
   FB Auto Poster - Content: Navigasi Natural Home -> Grup
   Step 1: pastikan berada di facebook.com
   Step 2: klik menu "Grup" di sidebar kiri
   Step 3: scroll sidebar, lalu klik grup pertama setelah
           heading "Grup yang Anda bergabung di dalamnya"
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const content = (FBAP.content = FBAP.content || {});
  const { randInt } = FBAP.random;
  const { sleep } = FBAP.time;
  const { GRUP_LINK, SIDEBAR_NAV, SIDEBAR_NAV_EN, SYSTEM_GROUP_URL } = content.selectors;
  const { waitForSelector, waitForUrlContains, normalizeUrl } = content.dom;
  const { humanScrollToEl, humanScrollSidebar } = content.stealth;

  /** Cari grup pertama setelah heading "Grup yang Anda bergabung di dalamnya". */
  async function findTopJoinedGroup(root) {
    const start = Date.now();
    const kw = ["grup yang anda bergabung", "groups you've joined", "groups you joined", "grup yang anda ikuti"];
    while (Date.now() - start < 15000) {
      const headings = root.querySelectorAll("h2, [role='heading']");
      for (let i = 0; i < headings.length; i++) {
        const t = (headings[i].textContent || "").toLowerCase().trim();
        if (!kw.some((k) => t.includes(k))) continue;
        // Ambil semua link grup di bawah heading ini, ambil yang pertama valid
        let node = headings[i].parentElement;
        let hops = 0;
        while (node && hops < 6) {
          const links = node.querySelectorAll('a[role="link"][href*="/groups/"]');
          for (const a of links) {
            const href = normalizeUrl(a.getAttribute("href"));
            if (!href || SYSTEM_GROUP_URL.test(href)) continue;
            if (!/\/groups\/\d+/.test(href) && !/\/groups\/[a-zA-Z0-9._-]+/.test(href)) continue;
            if (!(a.textContent || "").trim()) continue;
            return a;
          }
          node = node.parentElement;
          hops++;
        }
      }
      await sleep(500);
    }
    return null;
  }

  /** Jalankan navigasi natural sampai berada di halaman salah satu grup. */
  async function navHomeToGroup() {
    // Step 2: klik tombol "Grup"
    const grupBtn = await waitForSelector(GRUP_LINK, 15000);
    if (!grupBtn) throw new Error("Tombol 'Grup' tidak ditemukan di halaman.");
    await humanScrollToEl(grupBtn);
    grupBtn.click();
    await sleep(randInt(1200, 2600));

    // Tunggu pindah ke halaman daftar grup (/groups/feed/)
    await waitForUrlContains("/groups/", 15000);

    // Step 3: cari sidebar "Daftar Grup"
    const sidebar = (await waitForSelector(SIDEBAR_NAV, 8000)) ||
                    (await waitForSelector(SIDEBAR_NAV_EN, 8000));
    if (!sidebar) throw new Error("Sidebar 'Daftar Grup' tidak ditemukan.");

    // Scroll sidebar sebentar (simulasi baca)
    await humanScrollSidebar(sidebar);

    // Cari heading "Grup yang Anda bergabung di dalamnya" lalu klik grup pertama setelahnya
    const groupEl = await findTopJoinedGroup(sidebar);
    if (!groupEl) throw new Error("Grup join teratas tidak ditemukan.");
    await humanScrollToEl(groupEl);
    const groupUrl = normalizeUrl(groupEl.getAttribute("href"));
    const groupName = (groupEl.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
    groupEl.click();
    await sleep(randInt(1200, 2400));
    return { groupUrl: groupUrl || location.href, groupName };
  }

  content.navigation = { navHomeToGroup, findTopJoinedGroup };
})(globalThis);
