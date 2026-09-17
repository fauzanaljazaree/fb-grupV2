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
  const { STORAGE } = FBAP.config;
  const { get, setStrict } = FBAP.storage;
  const { State } = dashboard.state;
  const { $, escapeHtml, addLog } = dashboard.ui;

  let searchFilter = "";

  /** Cocokkan grup dengan kata kunci pencarian (nama atau URL). */
  function matchesFilter(g) {
    const q = searchFilter.toLowerCase();
    return g.name.toLowerCase().includes(q) || g.url.toLowerCase().includes(q);
  }

  /** Muat daftar grup + pilihan dari storage. */
  async function loadGroups() {
    const data = await get([STORAGE.GROUPS, STORAGE.SELECTED_GROUPS]);
    State.groups = data[STORAGE.GROUPS] || [];
    State.selected = new Set(data[STORAGE.SELECTED_GROUPS] || []);
    renderGroups();
  }

  function renderGroups() {
    const tb = $("groupTbody");
    const filtered = State.groups.filter(matchesFilter);
    $("groupCount").textContent = `${filtered.length} grup ditampilkan`;
    if (!filtered.length) {
      tb.innerHTML = `<tr><td colspan="4"><div class="empty">${State.groups.length ? "Tidak ada yang cocok dengan pencarian." : 'Belum ada data grup. Klik "Ambil Data Grup FB".'}</div></td></tr>`;
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

  /* FITUR SCRAPING DINONAKTIFKAN — mode input langsung.
     Grup dipilih otomatis oleh background via navigasi natural
     home -> Grup -> sidebar -> klik grup teratas. */
  $("btnScrape").addEventListener("click", () => {
    addLog('Scraping dinonaktifkan. Saat "Mulai Posting", grup dipilih otomatis dari sidebar FB.', "warn");
  });

  $("btnDeleteGroups").addEventListener("click", async () => {
    await setStrict({ [STORAGE.GROUPS]: [], [STORAGE.SELECTED_GROUPS]: [] }).catch(() => {});
    State.groups = [];
    State.selected = new Set();
    renderGroups();
    addLog("Data grup dihapus dari storage.", "warn");
  });

  dashboard.groups = { loadGroups, renderGroups, matchesFilter };
})(globalThis);
