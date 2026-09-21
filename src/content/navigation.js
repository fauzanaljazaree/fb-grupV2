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
  const JOINED_HEADING_KW = ["grup yang anda bergabung", "groups you've joined", "groups you joined", "grup yang anda ikuti"];

  /** Sama dengan Node.DOCUMENT_POSITION_FOLLOWING (dipisah agar mudah diuji). */
  const DOC_POSITION_FOLLOWING = 4;

  /** Marker notifikasi/permalink di QUERY yang bikin FB me-render view
      postingan + fokus kolom komentar walau path-nya kanonis. Anchor yang
      raw href-nya mengandung salah satu ini DITOLAK (bukan link navigasi
      grup, ini link notifikasi/aktivitas). */
  const POISON_QUERY_RE = /(multi_permalinks|comment_id|notif_id|notif_t|story_fbid|permalink|ref=notif)/i;

  /** Link grup milik user? null bila bukan format kanonis / halaman sistem.
      PENTING: validasi pakai HREF MENTAH, bukan hasil normalizeUrl() —
      href "/groups/{id}?multi_permalinks=...&ref=notif" (link notifikasi)
      ternormalisasi jadi kanonis tapi bila diklik me-render view postingan. */
  function isGroupLink(a) {
    const raw = (a.getAttribute("href") || "").trim();
    if (!raw) return null;
    if (POISON_QUERY_RE.test(raw)) return null;
    const href = normalizeUrl(raw);
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
      if (heading.compareDocumentPosition && !(heading.compareDocumentPosition(valid) & DOC_POSITION_FOLLOWING)) continue;
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
        const found = firstGroupAfter(headings[i], root) || firstGroupInAncestors(headings[i]) || firstGroupInSidebar(root);
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
    const sidebar = (await waitForSelector(SIDEBAR_NAV, 8000)) || (await waitForSelector(SIDEBAR_NAV_EN, 8000));
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
    const groupName = typeof scraper.extractGroupName === "function" ? scraper.extractGroupName(groupEl) : (groupEl.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
    groupEl.click();
    await sleep(randInt(1200, 2400));
    await ensureCanonicalUrl();
    return { groupUrl: groupUrl || normalizeUrl(location.href) || location.href, groupName };
  }

  /** KANONISASI URL GRUP (temuan lapangan): anchor yang diklik bisa href-nya
      /groups/{id}/posts/... /user/... atau query notifikasi
      (?multi_permalinks=...&ref=notif) — FB membukanya dan langsung fokus ke
      kolom komentar. Solusi STEALTH-FIRST: TIDAK ADA reload paksa dan TIDAK
      ada navigasi yang tidak diawali klik manusiawi. Satu-satunya cara
      keluar dari URL racun adalah KLIK ANCHOR KANONIS yang memang ada di
      halaman (persis /groups/{id}, tanpa query). Bila tidak ketemu ->
      throw Error eksplisit agar scheduler menandai grup ini gagal dan
      lanjut (user bisa retry manual). Kembalikan URL kanonis. */
  async function ensureCanonicalUrl() {
    const canonical = normalizeUrl(location.href);
    if (!canonical) return location.href;
    let wantPath = "";
    try {
      wantPath = new URL(canonical).pathname.replace(/\/+$/, "");
    } catch (e) {
      return location.href;
    }
    const curPath = location.pathname.replace(/\/+$/, "");
    const curQuery = (location.search || "") + (location.hash || "");
    if (curPath === wantPath && !POISON_QUERY_RE.test(curQuery)) return canonical;
    /* Cari anchor SPA href persis /groups/{id} TANPA query (boleh trailing
       slash) lalu klik seperti manusia — FB router pindah tanpa reload
       dokumen, content script tetap hidup, sendResponse tetap terkirim. */
    let target = null;
    for (const a of document.querySelectorAll('a[href^="/groups/"]')) {
      const raw = (a.getAttribute("href") || "").split("#")[0];
      const p = raw.split("?")[0].replace(/\/+$/, "");
      if (p === wantPath && !raw.includes("?")) {
        target = a;
        break;
      }
    }
    if (!target) {
      throw new Error(
        `URL grup masih racun (${location.href}) tapi anchor kanonis ${wantPath} tidak ditemukan di halaman — lewati grup ini (coba manual).`
      );
    }
    await humanScrollToEl(target);
    try {
      target.click();
    } catch (e) {
      throw new Error("Klik anchor kanonis gagal: " + e.message);
    }
    await sleep(randInt(1200, 2400));
    /* Verifikasi: path harus cocok & query bersih; loop maks 3x klik ulang
       (klik pertama kadang nyangkut saat halaman masih re-render). */
    for (let attempt = 0; attempt < 3; attempt++) {
      const path = location.pathname.replace(/\/+$/, "");
      const q = (location.search || "") + (location.hash || "");
      if (path === wantPath && !POISON_QUERY_RE.test(q)) {
        await sleep(randInt(800, 1600));
        return normalizeUrl(location.href) || canonical;
      }
      const again = document.querySelector(`a[href="${wantPath}"], a[href="${wantPath}/"]`);
      if (again) {
        await humanScrollToEl(again);
        again.click();
        await sleep(randInt(1200, 2400));
      } else {
        await sleep(700);
      }
    }
    throw new Error(
      `Klik anchor kanonis tidak membersihkan URL (${location.href}) — lewati grup ini (coba manual).`
    );
  }

  /** Expand bagian collapsible "Lihat selengkapnya" di sidebar (grup target
      sering tersembunyi di baliknya). Aman dipanggil berulang. */
  function expandSidebarSeeMore(scope) {
    const KW = ["lihat selengkapnya", "see more", "tampilkan lebih", "show more"];
    const nodes = (scope || document).querySelectorAll('div[role="button"], span, a');
    for (const n of nodes) {
      const t = (n.textContent || "").trim().toLowerCase();
      if (!t || t.length > 60) continue;
      if (!KW.some((k) => t === k || t.startsWith(k))) continue;
      const r = n.getBoundingClientRect ? n.getBoundingClientRect() : null;
      if (r && r.width < 2) continue;
      try {
        n.click();
      } catch (e) {
        /* abaikan */
      }
    }
  }

  /** Cari anchor grup yang URL kanonisnya sama dengan target.
      Sidebar /groups/feed di-render GRID dua kolom + lazy-render + collapsible
      "Lihat selengkapnya": scroll kecil +500px sering tidak memicu load.
      Strategi: auto-detect scroller sebenarnya (findSidebar), expand
      collapsible, lalu scroll langkah signifikan (scrollStep) sampai ketemu
      atau mentok bawah. */
  async function findGroupByUrl(sidebar, targetUrl) {
    const want = normalizeUrl(targetUrl);
    if (!want) return null;
    const scraper = (content && content.scraper) || {};
    const scroller = (typeof scraper.findSidebar === "function" ? scraper.findSidebar() : null) || sidebar;
    const step =
      typeof scraper.scrollStep === "function"
        ? scraper.scrollStep
        : (s) => {
            try {
              s.scrollTop = (s.scrollTop || 0) + 500;
              s.dispatchEvent(new Event("scroll", { bubbles: true }));
            } catch (e) {}
          };
    let lastTop = -1;
    let stuck = 0;
    for (let pass = 0; pass < 40; pass++) {
      expandSidebarSeeMore(scroller);
      const anchors = document.querySelectorAll('a[role="link"][href*="/groups/"]');
      for (const a of anchors) {
        if (!isGroupLink(a)) continue;
        if (normalizeUrl(a.getAttribute("href")) === want) return a;
      }
      /* Belum ketemu: scroll langkah signifikan lalu jeda render. */
      step(scroller);
      await sleep(700);
      const top = scroller.scrollTop || 0;
      const reachedBottom = top + (scroller.clientHeight || 0) >= (scroller.scrollHeight || 0) - 8;
      if (top <= lastTop + 2) stuck++;
      else stuck = 0;
      lastTop = top;
      if (reachedBottom || stuck >= 3) {
        /* Sekali lagi expand + cek setelah mentok, lalu menyerah. */
        expandSidebarSeeMore(scroller);
        await sleep(600);
        const again = document.querySelectorAll('a[role="link"][href*="/groups/"]');
        for (const a of again) {
          if (!isGroupLink(a)) continue;
          if (normalizeUrl(a.getAttribute("href")) === want) return a;
        }
        if (reachedBottom && stuck >= 3) break;
      }
    }
    return null;
  }

  content.navigation = { navHomeToGroup, findTopJoinedGroup, findGroupByUrl, ensureCanonicalUrl };
})(globalThis);
