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
  const { State } = dashboard.state;
  const { $, escapeHtml, addLog } = dashboard.ui;

  let searchFilter = "";
  let groupResults = {}; // {url: {ok, mi, at, error}} hasil posting per grup

  /** Cocokkan grup dengan kata kunci pencarian (nama atau URL). */
  function matchesFilter(g) {
    const q = searchFilter.toLowerCase();
    return g.name.toLowerCase().includes(q) || g.url.toLowerCase().includes(q);
  }

  /** Muat daftar grup + pilihan + hasil posting terakhir dari storage. */
  async function loadGroups() {
    const data = await get([STORAGE.GROUPS, STORAGE.SELECTED_GROUPS, STORAGE.GROUP_RESULTS]);
    State.groups = data[STORAGE.GROUPS] || [];
    State.selected = new Set(data[STORAGE.SELECTED_GROUPS] || []);
    groupResults = data[STORAGE.GROUP_RESULTS] || {};
    renderGroups();
  }

  /** Tanda status per grup: ✅ sukses / ❌ gagal (materi terakhir). */
  function statusBadge(url) {
    const r = groupResults[url];
    if (!r) return '<span style="color:var(--muted)">—</span>';
    if (r.ok) return `<span title="Sukses materi #${(r.mi || 0) + 1}">✅ M${(r.mi || 0) + 1}</span>`;
    return `<span title="${escapeHtml(r.error || "gagal")}">❌ M${(r.mi || 0) + 1}</span>`;
  }

  /** Update 1 baris hasil dari background (realtime + persist). */
  function applyResult(msg) {
    if (!msg || !msg.url) return;
    groupResults[msg.url] = { ok: !!msg.ok, mi: msg.mi || 0, at: Date.now(), error: msg.error || "" };
    renderGroups();
    setStrict({ [STORAGE.GROUP_RESULTS]: groupResults }).catch(() => {});
  }

  /** Reset semua tanda saat sesi posting baru dimulai. */
  function resetResults() {
    groupResults = {};
    renderGroups();
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
        <td>${escapeHtml(g.name)}</td>
        <td><a href="${escapeHtml(g.url)}" target="_blank" style="color:var(--accent)">${escapeHtml(g.url)}</a></td>
        <td style="white-space:nowrap">${statusBadge(g.url)}</td>
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
    await setStrict({ [STORAGE.GROUPS]: State.groups, [STORAGE.SELECTED_GROUPS]: [...State.selected] }).catch(() => {});
    renderGroups();
    addLog(`${doomed.size} grup dihapus dari storage.`, "warn");
  });

  dashboard.groups = { loadGroups, renderGroups, matchesFilter, applyResult, resetResults };
})(globalThis);
