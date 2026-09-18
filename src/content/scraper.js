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

  /** Pola keterangan aktivitas FB yang menempel di belakang nama grup
      (ID & EN). Hanya pola PANJANG yang di-strip; kata tunggal seperti
      "Terakhir" di tengah nama asli TIDAK disentuh. */
  const ACTIVITY_SUFFIX =
    /\s*(Terakhir\s+aktif.*|Aktif\s+.*(lalu|yang\s+lalu).*|Terakhir\s+dilihat.*|Last\s+active.*|Active\s+.*\bago\b.*|\d+\s*(anggota|members?).*|\d+\s*postingan?.*)$/i;

  /** Perbaiki tempelan tanpa spasi ("KebumenTerakhir") -> "Kebumen Terakhir". */
  function splitGluedActivity(t) {
    return (t || "").replace(
      /([a-z\u00C0-\u024F\u1E00-\u1EFF0-9])(Terakhir|Aktif|Active|Last|Baru|New|Dilihat|Anggota|Member)/,
      "$1 $2"
    );
  }

  /** Ambil nama grup bersih dari anchor:
      1) span/div anak pertama yang meaningful (nama selalu di atas
         keterangan aktivitas), 2) aria-label, 3) fallback textContent +
         strip suffix aktivitas. Potong SEBELUM kata "Terakhir" dkk. */
  function extractGroupName(a) {
    if (!a) return "";
    const kids = a.querySelectorAll ? a.querySelectorAll("span, div[dir='auto']") : [];
    for (const k of kids) {
      const t = ((k.textContent || "").trim().replace(/\s+/g, " "));
      if (!t || t.length < 2) continue;
      if (ACTIVITY_SUFFIX.test(t)) continue;
      if (/^(Terakhir\s+aktif|Aktif\s+.*lalu|Last\s+active|Active\s+.*ago)/i.test(t)) continue;
      return t.slice(0, 120);
    }
    const aria = (a.getAttribute && a.getAttribute("aria-label")) || "";
    if (aria && !ACTIVITY_SUFFIX.test(aria.trim())) {
      return aria.trim().replace(/\s+/g, " ").slice(0, 120);
    }
    let full = (a.textContent || "").trim().replace(/\s+/g, " ");
    full = splitGluedActivity(full);
    full = full.replace(ACTIVITY_SUFFIX, "").trim();
    return full.slice(0, 120);
  }

  /** URL grup valid = TEPAT format kanonis
      https://www.facebook.com/groups/{id} (id angka ATAU slug teks).
      Selain format ini -> false (jangan disimpan). */
  function isValidGroupHref(url) {
    if (!url) return false;
    if (!/^https:\/\/(www\.|web\.)?facebook\.com\/groups\/[A-Za-z0-9._-]+\/?$/.test(url)) return false;
    if (SYSTEM_GROUP_URL.test(url)) return false;
    return true;
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
      const name = extractGroupName(a);
      if (!name) return;
      groups.set(url, { name, url });
      added++;
    });
    return added;
  }

  /* ---------- AUTO-DETECT SCROLL CONTAINER (sidebar kiri) ----------
     Tidak hardcoded class: gabungkan (1) selektor eksplisit navigation
     ID/EN, (2) ancestor scrollable dari anchor /groups/, (3) sweep
     koordinat kiri (rect.left < 35% viewport) dengan syarat
     overflowY auto/scroll + scrollHeight > clientHeight + memuat
     anchor /groups/. Pemenang = paling kiri + anchor terbanyak. */

  /** Ambil overflowY computed yang aman (gagal -> ""). */
  function overflowOf(el) {
    try { return (getComputedStyle(el).overflowY || "").toLowerCase(); }
    catch (e) { return ""; }
  }

  /** Jumlah anchor /groups/ di dalam el (gagal -> 0). */
  function countGroupAnchors(el) {
    try { return el.querySelectorAll('a[href*="/groups/"]').length; }
    catch (e) { return 0; }
  }

  /** Cek satu elemen layak jadi scroller sidebar kiri. */
  function isLeftScroller(el, vw) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const oy = overflowOf(el);
    if (oy !== "auto" && oy !== "scroll") return false;
    if (!(el.scrollHeight > el.clientHeight + 40)) return false;
    let r = null;
    try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (!r || r.left > vw * 0.35) return false;
    if (countGroupAnchors(el) < 1) return false;
    return true;
  }

  /** Kumpulkan semua kandidat scroller di sepertiga kiri viewport. */
  function sweepLeftScrollers() {
    const vw = window.innerWidth || 1280;
    const out = [];
    const seen = new Set();
    const push = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      if (isLeftScroller(el, vw)) out.push(el);
    };
    /* Prioritas 1: navigation + aside eksplisit. */
    try {
      document.querySelectorAll('div[role="navigation"], aside').forEach(push);
    } catch (e) { /* abaikan */ }
    /* Prioritas 2: ancestor dari tiap anchor grup (naik hingga 8 hop). */
    let anchors = [];
    try { anchors = Array.from(document.querySelectorAll('a[href*="/groups/"]')).slice(0, 40); }
    catch (e) { anchors = []; }
    for (const a of anchors) {
      let node = a.parentElement;
      let hops = 0;
      while (node && node !== document.body && hops < 8) {
        push(node);
        node = node.parentElement;
        hops++;
      }
    }
    /* Prioritas 3: sweep semua div di koordinat kiri (dibatasi 400 node). */
    try {
      const divs = document.querySelectorAll("div");
      const lim = Math.min(divs.length, 400);
      for (let i = 0; i < lim; i++) push(divs[i]);
    } catch (e) { /* abaikan */ }
    return { list: out, vw };
  }

  /** Pilih pemenang: selektor eksplisit berisi grup didahulukan, lalu
      skor = paling kiri + anchor terbanyak. */
  function pickBestScroller(cands) {
    const sels = [SIDEBAR_NAV, SIDEBAR_NAV_EN];
    for (const sel of sels) {
      let node = null;
      try { node = document.querySelector(sel); } catch (e) { node = null; }
      if (node && cands.includes(node)) return node;
    }
    let best = null;
    let bestScore = -Infinity;
    for (const el of cands) {
      let r = null;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      const score = (0 - (r ? r.left : 0)) + countGroupAnchors(el) * 50;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  /** Deteksi container scroll sidebar kiri (auto-detect, bukan hardcoded).
      Tetap diekspor dengan nama findSidebar agar wiring lama tetap jalan. */
  function findSidebar() {
    const found = sweepLeftScrollers();
    const best = pickBestScroller(found.list);
    if (best) return best;
    /* Fallback terakhir: selektor navigasi walau belum scrollable penuh. */
    for (const sel of [SIDEBAR_NAV, SIDEBAR_NAV_EN]) {
      try {
        const nav = document.querySelector(sel);
        if (nav) return nav;
      } catch (e) { /* abaikan */ }
    }
    return document.scrollingElement || document.documentElement;
  }

  /** Scroll pelan satu langkah ala algoritma lama + event scroll sintetis
      agar listener React Facebook merespons lazy-load. */
  function scrollStep(sidebar) {
    const step = Math.max(320, Math.round((sidebar.clientHeight || 600) * 0.75));
    try { sidebar.scrollTo({ top: (sidebar.scrollTop || 0) + step, behavior: "auto" }); }
    catch (e) { try { sidebar.scrollTop = (sidebar.scrollTop || 0) + step; } catch (err) {} }
    try { sidebar.dispatchEvent(new Event("scroll", { bubbles: true })); }
    catch (e) { /* abaikan */ }
  }

  /** Tunggu adaptif pasca-scroll: cek tiap 500ms hingga 5 detik, keluar
      lebih awal begitu grup/scollHeight bertambah (tanda lazy-load
      merespons). Koneksi cepat -> lanjut <1 detik; lambat -> diberi
      waktu hingga 5 detik sebelum putaran dinilai "kosong". */
  async function waitForGrowth(sidebar, groups, baseCount, baseHeight) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await sleep(500);
      collectGroups(groups, sidebar);
      collectGroups(groups, document);
      if (groups.size > baseCount) return true;
      try {
        if (sidebar.scrollHeight > baseHeight + 20) return true;
      } catch (e) { /* abaikan */ }
    }
    return groups.size > baseCount;
  }

  /** Mentok bawah ala lama (tunggu idle), tapi tiap tunggu diselingi
      scroll pelan + event scroll + tunggu adaptif; berhenti bila 3x
      berturut-turut KETIGANYA diam (grup + tinggi DOM + posisi scroll). */
  async function waitForBottomIdle(sidebar, groups, deadline) {
    let empty = 0;
    let lastCount = groups.size;
    let lastHeight = 0;
    let lastTop = -1;
    try { lastHeight = sidebar.scrollHeight || 0; } catch (e) {}
    while (empty < 3 && Date.now() < deadline) {
      collectGroups(groups, sidebar);
      collectGroups(groups, document);
      scrollStep(sidebar);
      const grew = await waitForGrowth(sidebar, groups, lastCount, lastHeight);
      collectGroups(groups, sidebar);
      collectGroups(groups, document);
      let height = lastHeight;
      try { height = sidebar.scrollHeight || 0; } catch (e) {}
      const top = sidebar.scrollTop || 0;
      const moved = top > lastTop + 2;
      const domGrew = height > lastHeight + 20;
      if (grew || moved || domGrew) empty = 0;
      else empty++;
      lastCount = groups.size;
      lastHeight = height;
      lastTop = top;
    }
    collectGroups(groups, sidebar);
    collectGroups(groups, document);
  }

  /* ---------- SCAN UTAMA (perintah SCAN_GROUPS) ---------- */

  /** Scan sidebar /groups/feed/ ala lama: tunggu render -> loop scroll
      pelan bertahap (maks LIMITS.SCAN_MAX_PASSES) + event scroll sintetis
      + tunggu adaptif -> collect tiap langkah -> berhenti setelah 3x
      scroll tanpa grup baru (ketiga sinyal diam). */
  async function scanGroups() {
    const groups = new Map();
    await sleep(3000); /* beri waktu React FB merender sidebar */
    const sidebar = findSidebar();
    const deadline = Date.now() + LIMITS.SCAN_TAB_TIMEOUT_MS;
    let empty = 0;
    let lastCount = 0;
    let lastHeight = 0;
    let lastTop = -1;
    try { lastHeight = sidebar.scrollHeight || 0; } catch (e) {}
    for (let pass = 0; pass < LIMITS.SCAN_MAX_PASSES; pass++) {
      if (Date.now() > deadline) break;
      collectGroups(groups, sidebar);
      collectGroups(groups, document);
      if (groups.size > lastCount) { empty = 0; lastCount = groups.size; }
      const top = sidebar.scrollTop || 0;
      let height = lastHeight;
      try { height = sidebar.scrollHeight || 0; } catch (e) {}
      const moved = top > lastTop + 2;
      const domGrew = height > lastHeight + 20;
      if (groups.size <= lastCount && !moved && !domGrew && pass >= 2) empty++;
      else if (groups.size > lastCount || moved || domGrew) empty = 0;
      lastHeight = height;
      lastTop = top;
      if (empty >= 3 && pass >= 2) break;
      scrollStep(sidebar);
      const grew = await waitForGrowth(sidebar, groups, lastCount, lastHeight);
      collectGroups(groups, sidebar);
      collectGroups(groups, document);
      try { lastHeight = sidebar.scrollHeight || lastHeight; } catch (e) {}
      if (grew || groups.size > lastCount) { empty = 0; lastCount = groups.size; }
      else empty++;
      if (empty >= 3 && pass >= 2) break;
      const reachedBottom =
        (sidebar.scrollTop || 0) + (sidebar.clientHeight || 0) >= (sidebar.scrollHeight || 0) - 8;
      if (reachedBottom) {
        await waitForBottomIdle(sidebar, groups, deadline);
        break;
      }
    }
    collectGroups(groups, document);
    try { sidebar.scrollTo({ top: 0, behavior: "auto" }); } catch (e) {}
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
        if (!isValidGroupHref(href)) return;
        if (seen.has(href)) return;
        const name = extractGroupName(a);
        if (!name) return;
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

  content.scraper = { scanGroups, scrapeGroups, findSidebar, collectGroups, isValidGroupHref, extractGroupName };
})(globalThis);
