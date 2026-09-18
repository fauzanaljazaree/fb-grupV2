/* =========================================================
   FB Auto Poster - Dashboard: Bagian 1 - Import Materi & Media
   Materi dibaca dari Excel/CSV (kolom Caption & Media_Name),
   media dibaca dari folder lokal via FileSystem API.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const dashboard = (FBAP.dashboard = FBAP.dashboard || {});
  const { STORAGE } = FBAP.config;
  const { setStrict } = FBAP.storage;
  const { State } = dashboard.state;
  const { $, escapeHtml, addLog } = dashboard.ui;

  /* nama file (lowercase) -> {dataUrl, mime} dari folder media terpilih */
  let folderMap = {};

  /* ---------------- HELPER NAMA AKUN ---------------- */

  /** Normalisasi nama akun: lowercase + trim + spasi dirapikan. */
  function normAccount(s) {
    return String(s || "").toLowerCase().trim().replace(/\s+/g, " ").replace(/^\uFEFF/, "");
  }

  /** Nama akun aktif = textbox di header dashboard (akun browser ini). */
  function getCurrentAccount() {
    const el = $("accountNameInput");
    return el ? String(el.value || "").trim() : "";
  }

  /** Cocokkan satu baris Excel (boleh multi-akun "Budi, Andi") dgn akun aktif. */
  function rowMatchesAccount(rowAccount, currentAccount) {
    const cur = normAccount(currentAccount);
    if (!cur) return false;
    return String(rowAccount || "")
      .split(/[,;|]/)
      .some((part) => normAccount(part) === cur);
  }

  /** Resolve ketersediaan media utk daftar materi (folder media dipakai ulang). */
  function resolveMedia(list) {
    list.forEach((m) => {
      const fm = folderMap[String(m.mediaName || "").toLowerCase()];
      m.available = !!m.mediaName && !!fm;
      m.mediaDataUrl = fm ? fm.dataUrl : null;
      m.mediaMime = fm ? fm.mime : null;
    });
    return list;
  }

  /** Simpan daftar materi ke storage (kegagalan cukup diberi peringatan). */
  async function saveMaterials() {
    try {
      await setStrict({ [STORAGE.MATERIALS]: State.materials });
    } catch (err) {
      addLog(`Peringatan: materi mungkin tidak tersimpan (${err.message}).`, "warn");
    }
  }

  /* ---------------- FILTER PER AKUN BROWSER ----------------
     State.allMaterials = semua baris import (in-memory).
     State.materials    = hanya baris yang Nama_Akun-nya cocok dgn
                          textbox akun di header (akun browser ini). */
  function applyAccountFilter(logIt = true) {
    const current = getCurrentAccount();
    if (!current) {
      State.materials = [];
      if (logIt && State.allMaterials.length) {
        addLog("Nama akun FB belum diisi di header — materi tidak dimuat. Isi dulu lalu import ulang.", "warn");
      }
    } else {
      State.materials = resolveMedia(
        State.allMaterials.filter((m) => rowMatchesAccount(m.account, current))
      );
      if (logIt && State.allMaterials.length) {
        const skipped = State.allMaterials.length - State.materials.length;
        addLog(
          `Filter akun '${current}': ${State.materials.length} cocok, ${skipped} dilewati.`,
          State.materials.length ? "ok" : "warn"
        );
      }
    }
    saveMaterials();
    renderMaterials();
  }

  /* ---------------- IMPORT EXCEL / CSV ---------------- */
  $("excelInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      addLog(`Membaca file: ${file.name}`, "info");
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
      const header = rows.length ? Object.keys(rows[0]) : [];
      const norm = (h) => String(h).toLowerCase().trim().replace(/^\uFEFF/, "").replace(/[\s_-]+/g, "");
      const capKey = header.find((h) => norm(h) === "caption");
      const mediaKey = header.find((h) => norm(h) === "medianame" || norm(h) === "media");
      const accKey = header.find(
        (h) => ["namaakun", "akun", "account", "accountname", "namaakunfb"].includes(norm(h))
      );
      if (!capKey) throw new Error("Kolom 'Caption' tidak ditemukan di sheet.");

      const hasAccountCol = !!accKey;
      const current = getCurrentAccount();
      const all = rows.map((r) => ({
        account: String(accKey ? (r[accKey] ?? "") : "").trim(),
        caption: String(r[capKey] ?? ""),
        mediaName: String(mediaKey ? (r[mediaKey] ?? "") : "").trim()
      })).filter((m) => m.caption);

      State.allMaterials = all;
      e.target.value = "";
      if (hasAccountCol && !current) {
        /* Akun browser belum diisi: tidak memuat apa pun (aturan filter akun). */
        State.materials = [];
        addLog(`Import selesai (${all.length} baris), TAPI nama akun FB belum diisi di header — tidak ada materi dimuat. Isi nama akun lalu ganti/re-import.`, "warn");
        saveMaterials();
        renderMaterials();
      } else {
        if (hasAccountCol) {
          State.materials = resolveMedia(all.filter((m) => rowMatchesAccount(m.account, current)));
        } else {
          /* File lama tanpa kolom akun: semua baris dimuat (backward compatible). */
          State.materials = resolveMedia(all);
        }
        const skipped = all.length - State.materials.length;
        addLog(
          hasAccountCol
            ? `Import ${all.length} baris. Akun '${current}': ${State.materials.length} cocok, ${skipped} dilewati.`
            : `Berhasil import ${State.materials.length} materi (file tanpa kolom Nama_Akun — semua dimuat).`,
          State.materials.length ? "ok" : "warn"
        );
        saveMaterials();
        renderMaterials();
      }
    } catch (err) {
      addLog(`Gagal import Excel: ${err.message}`, "err");
    }
  });

  /* ---------------- FOLDER MEDIA (webkitdirectory) ---------------- */
  $("folderInput").addEventListener("change", async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    folderMap = {};
    let loaded = 0;
    addLog(`Membaca folder media (${files.length} file)...`, "info");
    for (const file of files) {
      try {
        const dataUrl = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = rej;
          fr.readAsDataURL(file);
        });
        folderMap[file.name.toLowerCase()] = {
          dataUrl,
          mime: file.type || "application/octet-stream"
        };
        loaded++;
      } catch (err) {
        addLog(`Gagal baca ${file.name}: ${err.message}`, "warn");
      }
    }
    resolveMedia(State.materials);
    await saveMaterials();
    addLog(`Folder dimuat: ${loaded} file media tersedia.`, "ok");
    renderMaterials();
  });

  /* ---------------- RENDER TABEL MATERI ---------------- */
  function renderMaterials() {
    const tb = $("materialTbody");
    $("materialCount").textContent = `${State.materials.length} materi`;
    if (!State.materials.length) {
      tb.innerHTML = `<tr><td colspan="5"><div class="empty">Belum ada materi. Import Excel/CSV terlebih dahulu.</div></td></tr>`;
      return;
    }
    tb.innerHTML = State.materials.map((m, i) => {
      const badge = m.mediaName
        ? (m.available
            ? '<span class="badge ok">✓ Tersedia</span>'
            : '<span class="badge no">✗ Tidak Ada</span>')
        : '<span class="badge warn">Tanpa Media</span>';
      return `<tr>
        <td>${i + 1}</td>
        <td title="${escapeHtml(m.account || "-")}">${escapeHtml(m.account || "-")}</td>
        <td class="cap-cell" title="${escapeHtml(m.caption)}">${escapeHtml(m.caption)}</td>
        <td>${escapeHtml(m.mediaName || "-")}</td>
        <td>${badge}</td>
      </tr>`;
    }).join("");
  }

  $("btnClearMaterials").addEventListener("click", async () => {
    State.materials = [];
    State.allMaterials = [];
    folderMap = {};
    $("excelInput").value = "";
    $("folderInput").value = "";
    await setStrict({ [STORAGE.MATERIALS]: [] }).catch(() => {});
    renderMaterials();
    addLog("Materi & media dikosongkan.", "warn");
  });

  dashboard.materials = { saveMaterials, renderMaterials, applyAccountFilter, getCurrentAccount };
})(globalThis);
