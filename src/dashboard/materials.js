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

  /** Simpan daftar materi ke storage (kegagalan cukup diberi peringatan). */
  async function saveMaterials() {
    try {
      await setStrict({ [STORAGE.MATERIALS]: State.materials });
    } catch (err) {
      addLog(`Peringatan: materi mungkin tidak tersimpan (${err.message}).`, "warn");
    }
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
      const norm = (h) => String(h).toLowerCase().trim().replace(/^\uFEFF/, "");
      const capKey = header.find((h) => norm(h) === "caption");
      const mediaKey = header.find((h) => norm(h) === "media_name" || norm(h) === "media");
      if (!capKey) throw new Error("Kolom 'Caption' tidak ditemukan di sheet.");

      State.materials = rows.map((r) => {
        const mediaName = String(mediaKey ? r[mediaKey] : "").trim();
        const fm = folderMap[mediaName.toLowerCase()];
        return {
          caption: String(r[capKey] ?? ""),
          mediaName,
          available: !!mediaName && !!fm,
          mediaDataUrl: fm ? fm.dataUrl : null,
          mediaMime: fm ? fm.mime : null
        };
      }).filter((m) => m.caption);
      e.target.value = "";
      await saveMaterials();
      addLog(`Berhasil import ${State.materials.length} materi.`, "ok");
      renderMaterials();
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
    State.materials.forEach((m) => {
      const fm = folderMap[m.mediaName.toLowerCase()];
      m.available = !!m.mediaName && !!fm;
      m.mediaDataUrl = fm ? fm.dataUrl : null;
      m.mediaMime = fm ? fm.mime : null;
    });
    await saveMaterials();
    addLog(`Folder dimuat: ${loaded} file media tersedia.`, "ok");
    renderMaterials();
  });

  /* ---------------- RENDER TABEL MATERI ---------------- */
  function renderMaterials() {
    const tb = $("materialTbody");
    $("materialCount").textContent = `${State.materials.length} materi`;
    if (!State.materials.length) {
      tb.innerHTML = `<tr><td colspan="4"><div class="empty">Belum ada materi. Import Excel/CSV terlebih dahulu.</div></td></tr>`;
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
        <td class="cap-cell" title="${escapeHtml(m.caption)}">${escapeHtml(m.caption)}</td>
        <td>${escapeHtml(m.mediaName || "-")}</td>
        <td>${badge}</td>
      </tr>`;
    }).join("");
  }

  $("btnClearMaterials").addEventListener("click", async () => {
    State.materials = [];
    folderMap = {};
    $("excelInput").value = "";
    $("folderInput").value = "";
    await setStrict({ [STORAGE.MATERIALS]: [] }).catch(() => {});
    renderMaterials();
    addLog("Materi & media dikosongkan.", "warn");
  });

  dashboard.materials = { saveMaterials, renderMaterials };
})(globalThis);
