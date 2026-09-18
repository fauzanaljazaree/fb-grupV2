/* =========================================================
   FB Auto Poster - Content: Navigasi Natural Home -> Grup
   Step 1: pastikan berada di facebook.com
   Step 2: klik menu "Grup" di sidebar kiri
   Step 3: scroll sidebar, lalu klik grup TARGET:
           - bila targetGroupUrl diberikan -> cari anchor yang URL-nya
             cocok (kanonis) dengan target, scroll sidebar sampai ketemu;
           - bila tidak -> grup pertama setelah heading
             "Grup yang Anda bergabung di dalamnya" (perilaku lama).

   CATATAN STRATEGI PENCARIAN GRUP
   Di layout Facebook saat ini, daftar grup berada di CABANG
   SIBLING dari heading, bukan di ancestor heading: hasil ukur
   DOM nyata menunjukkan penelusuran ke atas 6 hop hanya berisi
   0-1 anchor (itu pun "Buat Grup Baru"). Jadi pencarian utama
   memakai URUTAN DOKUMEN (compareDocumentPosition) dan
   penelusuran ancestor hanya dipakai sebagai fallback layout
   lama.
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

  /** Kata kunci heading daftar grup (ID & EN). Terbukti cocok di DOM nyata. */
  const JOINED_HEADING_KW = [
    "grup yang anda bergabung",
    "groups you've joined",
    "groups you joined",
    "grup yang anda ikuti"
  ];

  /** Sama dengan Node.DOCUMENT_POSITION_FOLLOWING (dipisah agar mudah diuji). */
  const DOC_POSITION_FOLLOWING = 4;

  /** Link grup milik user? null bila bukan format kanonis / halaman sistem. */
  function isGroupLink(a) {
    const href = normalizeUrl(a.getAttribute("href"));
    if (!href) return null;
    if (!/^https:\/\/(www\.|web\.)?facebook\.com\/groups\/[A-Za-z0-9._-]+\/?$/.test(href)) return null;
    if (SYSTEM_GROUP_URL.test(href)) return null;
    if (!(a.textContent || "").trim()) return null;
    return a;
  }

  /** Link grup valid pertama yang berada SETELAH heading dalam urutan dokumen. */
  function firstGroupAfter(heading, root) {
    const anchors = root.querySelectorAll('a[role="link"][href*="/groups/"]');
    for (const a of anchors) {
      const valid = isGroupLink(a);
      if (!valid) continue;
      if (heading.compareDocumentPosition &&
          !(heading.compareDocumentPosition(valid) & DOC_POSITION_FOLLOWING)) continue;
      return valid;
    }
    return null;
  }

  /** Fallback layout lama: link grup ada di salah satu ancestor heading. */
  function firstGroupInAncestors(heading) {
    let node = heading.parentElement;
    let hops = 0;
    while (node && hops < 6) {
      const anchors = node.querySelectorAll('a[role="link"][href*="/groups/"]');
      for (const a of anchors) {
        const valid = isGroupLink(a);
        if (valid) return valid;
      }
      node = node.parentElement;
      hops++;
    }
    return null;
  }

  /** Fallback terakhir: link grup valid pertama di seluruh sidebar. */
  function firstGroupInSidebar(root) {
    const anchors = root.querySelectorAll('a[role="link"][href*="/groups/"]');
    for (const a of anchors) {
      const valid = isGroupLink(a);
      if (valid) return valid;
    }
    return null;
  }

  /** Cari grup pertama setelah heading "Grup yang Anda bergabung di dalamnya". */
  async function findTopJoinedGroup(root) {
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const headings = root.querySelectorAll("h2, [role='heading']");
      for (let i = 0; i < headings.length; i++) {
        const t = (headings[i].textContent || "").toLowerCase().trim();
        if (!JOINED_HEADING_KW.some((k) => t.includes(k))) continue;
        /* Urutan percobaan: urutan dokumen (layout sekarang) -> ancestor
           (layout lama) -> seluruh sidebar (jaring pengaman). */
        const found = firstGroupAfter(headings[i], root) ||
                      firstGroupInAncestors(headings[i]) ||
                      firstGroupInSidebar(root);
        if (found) return found;
      }
      await sleep(500);
    }
    return null;
  }

  /** Jalankan navigasi natural sampai berada di halaman grup TARGET.
      targetGroupUrl opsional: bila diberikan, sidebar di-scroll bertahap
      dan anchor yang URL kanonisnya cocok akan diklik. */
  async function navHomeToGroup(targetGroupUrl) {
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

    const want = normalizeUrl(targetGroupUrl || "");
    let groupEl = null;
    if (want) {
      groupEl = await findGroupByUrl(sidebar, want);
      if (!groupEl) throw new Error(`Grup target tidak ketemu di sidebar: ${want}`);
    } else {
      // Cari heading "Grup yang Anda bergabung di dalamnya" lalu klik grup pertama setelahnya
      groupEl = await findTopJoinedGroup(sidebar);
      if (!groupEl) throw new Error("Grup join teratas tidak ditemukan.");
    }
    await humanScrollToEl(groupEl);
    const groupUrl = normalizeUrl(groupEl.getAttribute("href"));
    const scraper = (content && content.scraper) || {};
    const groupName = typeof scraper.extractGroupName === "function"
      ? scraper.extractGroupName(groupEl)
      : (groupEl.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
    groupEl.click();
    await sleep(randInt(1200, 2400));
    return { groupUrl: groupUrl || location.href, groupName };
  }

  /** Cari anchor grup yang URL kanonisnya sama dengan target.
      Sidebar FB memakai lazy-render: scroll bertahap sampai 25x,
      tiap pass cek semua anchor; cocok = normalizeUrl sama persis. */
  async function findGroupByUrl(sidebar, targetUrl) {
    const want = normalizeUrl(targetUrl);
    if (!want) return null;
    const scroller = sidebar.querySelector("[data-visualcompletion]") || sidebar;
    for (let pass = 0; pass < 25; pass++) {
      const anchors = sidebar.querySelectorAll('a[role="link"][href*="/groups/"]');
      for (const a of anchors) {
        if (!isGroupLink(a)) continue;
        if (normalizeUrl(a.getAttribute("href")) === want) return a;
      }
      /* Belum ketemu: scroll ke bawah sedikit lalu jeda render. */
      try {
        scroller.scrollTop = scroller.scrollTop + 500;
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      } catch (e) { /* abaikan */ }
      await humanScrollSidebar(sidebar);
      await sleep(600);
    }
    return null;
  }

  content.navigation = { navHomeToGroup, findTopJoinedGroup, findGroupByUrl };
})(globalThis);
