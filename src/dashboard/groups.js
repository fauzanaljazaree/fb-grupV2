/* =========================================================
   FB Auto Poster - Dashboard: Bagian 3 - Manajemen Data Grup
   FITUR SCRAPING DINONAKTIFKAN (mode input langsung): grup
   dipilih otomatis oleh background lewat navigasi natural.
   Kode di bawah dipertahankan agar tabel grup & pencarian
   tetap berfungsi bila scraping diaktifkan kembali.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const dashboard = (FBAP.dashboard = FBAP.dashboard || {});
  const { MSG, STORAGE } = FBAP.config;
  const { get, setStrict } = FBAP.storage;
  const { materialKey } = FBAP.materialKey;
  const { State } = dashboard.state;
  const { $, escapeHtml, addLog } = dashboard.ui;

  let searchFilter = "";
  let groupResults = {}; // {url: {ok, mi, at, error}} hasil posting per grup
  /* Matriks status persisten: {materialKey: {groupUrl: {ok, mi, gi, at, error}}}.
     Tidak di-reset saat sesi baru — hanya tombol "Hapus Riwayat Status". */
  let postMatrix = {};
  /* Label permanen grup jual-beli: {groupUrl: {at, name}}. Diisi background
     saat content script mendeteksi grup hanya punya tombol "Jual sesuatu"
     (tanpa kolom posting). Grup berlabel ditandai 🏷️ di tabel dan di-uncheck
     otomatis; hapus hanya via tombol "Hapus label jual-beli". */
  let sellGroups = {};

  /** Kunci matriks materi ke-i pada daftar materi yang sedang dimuat. */
  function keyOf(mi) {
    const m = State.materials[mi];
    return m ? materialKey(m) : null;
  }

  /** Sel status grup: deret badge ✅/❌/— per materi yang sedang dimuat (M1, M2, ...).
      Dibaca dari POST_MATRIX (persisten lintas sesi), bukan hanya sesi berjalan. */
  function statusCell(url) {
    if (!State.materials.length) return '<span style="color:var(--muted)">—</span>';
    return State.materials.map((m, i) => {
      const r = (postMatrix[keyOf(i)] || {})[url];
      if (!r) return `<span title="M${i + 1}: belum diposting" style="color:var(--muted)">M${i + 1}—</span>`;
      return r.ok
        ? `<span title="M${i + 1}: sukses" style="color:var(--green)">✅M${i + 1}</span>`
        : `<span title="M${i + 1}: ${escapeHtml(r.error || "gagal")}" style="color:var(--red)">❌M${i + 1}</span>`;
    }).join(" ");
  }

  /** Cocokkan grup dengan kata kunci pencarian (nama atau URL). */
  function matchesFilter(g) {
    const q = searchFilter.toLowerCase();
    return g.name.toLowerCase().includes(q) || g.url.toLowerCase().includes(q);
  }

  /** Muat daftar grup + pilihan + hasil posting terakhir + matriks status + label jual-beli. */
  async function loadGroups() {
    const data = await get([STORAGE.GROUPS, STORAGE.SELECTED_GROUPS, STORAGE.GROUP_RESULTS, STORAGE.POST_MATRIX, STORAGE.SELL_GROUPS]);
    State.groups = data[STORAGE.GROUPS] || [];
    State.selected = new Set(data[STORAGE.SELECTED_GROUPS] || []);
    groupResults = data[STORAGE.GROUP_RESULTS] || {};
    postMatrix = data[STORAGE.POST_MATRIX] || {};
    sellGroups = data[STORAGE.SELL_GROUPS] || {};
    renderGroups();
  }

  /** Reset badge sesi berjalan saat "Mulai Posting" ditekan.
      Matriks POST_MATRIX sengaja TIDAK dihapus (status lintas sesi). */
  function resetResults() {
    groupResults = {};
    renderGroups();
  }

  /* Hapus riwayat status lintas sesi (satu-satunya cara mengosongkan matriks). */
  $("btnClearMatrix").addEventListener("click", async () => {
    postMatrix = {};
    await setStrict({ [STORAGE.POST_MATRIX]: {} }).catch(() => {});
    renderGroups();
    addLog("Riwayat status posting (matriks materi × grup) dihapus.", "warn");
  });

  /** Update 1 baris hasil dari background (realtime + persist).
      Selain GROUP_RESULTS (badge sesi berjalan), tulis juga ke matriks
      POST_MATRIX agar ✅/❌ per materi bertahan lintas sesi. */
  function applyResult(msg) {
    if (!msg || !msg.url) return;
    groupResults[msg.url] = { ok: !!msg.ok, mi: msg.mi || 0, at: Date.now(), error: msg.error || "" };
    const key = keyOf(msg.mi || 0);
    if (key) {
      postMatrix[key] = postMatrix[key] || {};
      postMatrix[key][msg.url] = { ok: !!msg.ok, mi: msg.mi || 0, gi: typeof msg.gi === "number" ? msg.gi : -1, at: Date.now(), error: msg.error || "" };
    }
    renderGroups();
    setStrict({ [STORAGE.GROUP_RESULTS]: groupResults, [STORAGE.POST_MATRIX]: postMatrix }).catch(() => {});
  }

  function renderGroups() {
    const tb = $("groupTbody");
    const filtered = State.groups.filter(matchesFilter);
    $("groupCount").textContent = `${filtered.length} grup ditampilkan`;
    if (!filtered.length) {
      tb.innerHTML = `<tr><td colspan="5"><div class="empty">${State.groups.length ? "Tidak ada yang cocok dengan pencarian." : 'Belum ada data grup. Klik "Ambil Data Grup FB".'}</div></td></tr>`;
      $("chkSelectAll").checked = false;
      return;
    }
    const selectedCount = State.groups.filter((g) => State.selected.has(g.url)).length;
    tb.innerHTML = filtered.map((g, i) => `
      <tr>
        <td>${i + 1}</td>
        <td><input type="checkbox" data-url="${escapeHtml(g.url)}" ${State.selected.has(g.url) ? "checked" : ""} /></td>
        <td>${escapeHtml(g.name)}${sellGroups[g.url] ? ' <span title="Grup jual-beli: hanya ada tombol \'Jual sesuatu\' (tanpa kolom posting) — dilewati otomatis. Hapus label via tombol \'Hapus label jual-beli\' bila ingin mencoba lagi." style="color:var(--amber)">🏷️ Jual-beli</span>' : ""}</td>
        <td><a href="${escapeHtml(g.url)}" target="_blank" style="color:var(--accent)">${escapeHtml(g.url)}</a></td>
        <td style="white-space:nowrap; max-width:260px; overflow:hidden; text-overflow:ellipsis">${statusCell(g.url)}</td>
      </tr>`).join("");
    $("chkSelectAll").checked = State.groups.length > 0 && selectedCount === State.groups.length;
  }

  $("groupTbody").addEventListener("change", async (e) => {
    if (e.target.matches('input[type="checkbox"]')) {
      const url = e.target.getAttribute("data-url");
      if (e.target.checked) State.selected.add(url);
      else State.selected.delete(url);
      await setStrict({ [STORAGE.SELECTED_GROUPS]: Array.from(State.selected) });
      renderGroups();
    }
  });

  $("chkSelectAll").addEventListener("change", async (e) => {
    if (e.target.checked) {
      State.groups.filter(matchesFilter).forEach((g) => State.selected.add(g.url));
    } else {
      State.groups.filter(matchesFilter).forEach((g) => State.selected.delete(g.url));
    }
    await setStrict({ [STORAGE.SELECTED_GROUPS]: Array.from(State.selected) });
    renderGroups();
  });

  $("searchGroup").addEventListener("input", (e) => {
    searchFilter = e.target.value;
    renderGroups();
  });

  /* ---------------- SCAN GRUP (pola fb-grupV3) ----------------
     Tombol ini HANYA pemicu: kirim START_SCAN ke background lalu
     keluar. Eksekusi berat (tab sementara + scroll sidebar) ada di
     background/scan.js + content/scraper.js. Hasil & status scan
     dibaca lewat chrome.storage.onChanged di controls.js. */
  $("btnScrape").addEventListener("click", async () => {
    const btn = $("btnScrape");
    btn.disabled = true; /* disabled optimis; di-enable lagi oleh onChanged */
    $("scanMessage").textContent = "Meminta background memulai scan...";
    try {
      const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: MSG.START_SCAN }, (r) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(r);
        });
      });
      if (!res || !res.ok || res.accepted === false) {
        throw new Error((res && res.error) || "Scan sedang berjalan.");
      }
      $("scanMessage").textContent = "Tab baru dibuka. Scan berjalan — hasil akan muncul otomatis di tabel.";
      addLog("Scan grup dimulai: tab /groups/feed/ dibuka oleh background.", "info");
    } catch (e) {
      $("scanMessage").textContent = e.message;
      btn.disabled = false;
    }
  });

  $("btnDeleteGroups").addEventListener("click", async () => {
    /* Hanya grup yang dicentang (State.selected) yang dihapus. */
    if (!State.selected.size) {
      addLog("Tidak ada grup yang dicentang — centang dulu grup yang ingin dihapus.", "warn");
      return;
    }
    const doomed = new Set(State.selected);
    State.groups = State.groups.filter((g) => !doomed.has(g.url));
    /* Bersihkan seleksi yang URL-nya sudah tidak ada (anti URL yatim). */
    State.selected = new Set([...State.selected].filter((u) => State.groups.some((g) => g.url === u)));
    /* Label jual-beli milik grup yang dihapus ikut dibuang (anti URL yatim). */
    const fresh = { ...((await get([STORAGE.SELL_GROUPS]))[STORAGE.SELL_GROUPS] || {}) };
    const doomedSell = Object.keys(fresh).filter((u) => doomed.has(u));
    if (doomedSell.length) {
      for (const u of doomedSell) delete fresh[u];
      await setStrict({ [STORAGE.SELL_GROUPS]: fresh }).catch(() => {});
      sellGroups = fresh;
    }
    await setStrict({ [STORAGE.GROUPS]: State.groups, [STORAGE.SELECTED_GROUPS]: [...State.selected] }).catch(() => {});
    renderGroups();
    addLog(`${doomed.size} grup dihapus dari storage.${doomedSell.length ? ` ${doomedSell.length} label jual-beli ikut dihapus.` : ""}`, "warn");
  });

  /* ---------------- LABEL GRUP JUAL-BELI ---------------- */
  /* Grup baru saja terdeteksi jual-beli di lapangan (SELL_GROUP_MARKED
     dari background): uncheck barisnya realtime agar tidak ikut antrean
     sesi berikutnya. */
  function applySellGroupMarked(msg) {
    if (!msg || !msg.url) return;
    sellGroups[msg.url] = { at: Date.now(), name: msg.name || msg.url };
    if (State.selected.delete(msg.url)) {
      setStrict({ [STORAGE.SELECTED_GROUPS]: Array.from(State.selected) }).catch(() => {});
    }
    renderGroups();
    addLog(`🏷️ "${msg.name || msg.url}" ditandai grup jual-beli (tanpa kolom posting) — centang dilepas, akan dilewati otomatis.`, "warn");
  }

  /* Reset SEMUA label jual-beli (grup berubah tipe / false positive):
     label hilang, grup bisa dicentang & dicoba lagi sesi berikutnya. */
  $("btnClearSell").addEventListener("click", async () => {
    const n = Object.keys(sellGroups).length;
    sellGroups = {};
    await setStrict({ [STORAGE.SELL_GROUPS]: {} }).catch(() => {});
    renderGroups();
    addLog(n ? `${n} label jual-beli dihapus — semua grup bisa dicoba lagi.` : "Tidak ada label jual-beli untuk dihapus.", n ? "warn" : "info");
  });

  dashboard.groups = { loadGroups, renderGroups, matchesFilter, applyResult, resetResults, applySellGroupMarked };
})(globalThis);
