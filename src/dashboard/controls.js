/* =========================================================
   FB Auto Poster - Dashboard: Bagian 4 - Kontrol Running,
   Live Log, dan jembatan pesan ke background.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const dashboard = (FBAP.dashboard = FBAP.dashboard || {});
  const { MSG, STORAGE } = FBAP.config;
  const { setStrict } = FBAP.storage;
  const { State } = dashboard.state;
  const { $, addLog, setStatus, showSaving, showSaved, showSaveError } = dashboard.ui;
  const { renderMaterials } = dashboard.materials;
  const { loadGroups } = dashboard.groups;

  /** Kirim pesan ke background; selalu resolve (error jadi {ok:false}). */
  function sendMsg(msg) {
    return new Promise((res) => chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) res({ ok: false, error: chrome.runtime.lastError.message });
      else res(r);
    }));
  }

  /* ---------------- SINKRONISASI STATUS AWAL ----------------
     Background adalah sumber kebenaran tombol Start/Stop. Kunci `status` di
     storage bisa tertinggal (sesi lama berakhir tanpa stopPosting()), sehingga
     dashboard harus menanyakan status sebenarnya sebelum mengunci tombol. */
  async function syncStatus() {
    const res = await sendMsg({ type: MSG.GET_STATUS });
    if (!res || !res.ok) return State.running; /* background tak menjawab */
    if (res.recovered) {
      addLog("Status \"Berjalan\" warisan sesi lama dibersihkan — siap memulai posting baru.", "warn");
    }
    setStatus(!!res.running);
    return !!res.running;
  }

  /* ---------------- NAMA AKUN FB MANUAL (textbox + centang tersimpan) ----------------
     Ketik nama -> debounce 600ms -> tulis chrome.storage.local.
     Centang hijau HANYA muncul setelah storage benar-benar berubah
     (diverifikasi lewat storage.onChanged, bukan asumsi UI). */
  let accountSaveTimer = null;

  $("accountNameInput").addEventListener("input", () => {
    clearTimeout(accountSaveTimer);
    showSaving();
    accountSaveTimer = setTimeout(async () => {
      const name = $("accountNameInput").value.trim();
      try {
        if (!name) {
          await setStrict({ [STORAGE.ACCOUNT_NAME]: { name: "", checkedAt: Date.now() } });
        } else {
          await setStrict({ [STORAGE.ACCOUNT_NAME]: { name, checkedAt: Date.now() } });
        }
        /* Centang tampil lewat storage.onChanged di bawah. */
        dashboard.materials.applyAccountFilter();
      } catch (e) {
        showSaveError();
        addLog(`Gagal menyimpan nama akun: ${e.message}`, "err");
      }
    }, 600);
  });

  /* ---------------- MULAI POSTING ---------------- */
  $("btnStart").addEventListener("click", async () => {
    if (!State.materials.length) { addLog("Tidak ada materi untuk diposting. Import Excel + media dulu.", "err"); return; }
    if (State.materials.some((m) => m.mediaName && !m.available)) {
      addLog("Ada materi dengan media tidak tersedia — akan diposting tanpa media.", "warn");
    }

    addLog(`Menjalankan posting ${State.materials.length} materi. Grup dipilih otomatis dari sidebar FB (navigasi natural).`, "info");

    const res = await sendMsg({
      type: MSG.START_POSTING,
      payload: {
        materials: State.materials.map((m) => ({
          caption: m.caption || "",
          mediaName: m.mediaName || "",
          mediaDataUrl: m.available ? m.mediaDataUrl : null,
          mediaMime: m.mediaMime || "application/octet-stream"
        })),
        settings: { ...State.settings, showFbTab: $("chkShowFb").checked }
      }
    });
    if (res && res.ok) {
      setStatus(true);
      addLog("Posting dimulai. Antrean dikelola oleh background.", "ok");
    } else {
      addLog(`Gagal memulai: ${(res && res.error) || "unknown"}`, "err");
    }
  });

  /* ---------------- HENTIKAN POSTING ---------------- */
  $("btnStop").addEventListener("click", async () => {
    await sendMsg({ type: MSG.STOP_POSTING });
    setStatus(false);
    addLog("Posting dihentikan oleh user.", "warn");
  });

  $("btnClearLog").addEventListener("click", () => {
    $("terminal").innerHTML = "";
  });

  /* ------- Opsi C: kontrol tampilan tab FB ------- */
  $("chkShowFb").addEventListener("change", async (e) => {
    const show = e.target.checked;
    const res = await sendMsg({ type: MSG.SET_VIEW, showFbTab: show });
    if (res && res.ok) {
      await setStrict({ [STORAGE.UI]: { showFbTab: show } }).catch(() => {});
      addLog(show
        ? "Tab FB akan tampil di depan (fokus pindah) saat posting, lalu balik ke dashboard."
        : "Tab FB berjalan di background — fokus tetap di dashboard.", "info");
    } else {
      addLog(`Gagal set tampilan: ${(res && res.error) || "unknown"}`, "err");
    }
  });

  $("btnViewFb").addEventListener("click", async () => {
    const res = await sendMsg({ type: MSG.VIEW_FB_TAB });
    if (!res || !res.ok) addLog(`Gagal membuka tab FB: ${(res && res.error) || "unknown"}`, "err");
  });

  /* ------- Uji workflow lengkap: navigasi -> composer -> MEDIA DULU (GATE
     preview blob) -> caption Lexical anti-dobel -> STOP tanpa submit. -------
     Materi diambil dari materi pertama yang media-nya tersedia. Tab FB
     difokuskan dulu oleh background supaya langkahnya terlihat. */
  $("btnTestComposer").addEventListener("click", async () => {
    addLog("Uji Post: navigasi -> buka composer -> upload media (GATE) -> tulis caption (tanpa submit)...", "info");
    const res = await sendMsg({ type: MSG.TEST_POST });
    if (res && res.ok) {
      addLog(
        `Uji Post sukses di ${res.groupName || "(tanpa nama)"} — preview media ter-render & caption terisi. Tombol Posting TIDAK diklik; periksa composer di tab FB.`,
        "ok"
      );
    } else {
      addLog(`Uji Post gagal: ${(res && res.error) || "unknown"}`, "err");
    }
  });

  /* ---------------- EVENT REALTIME DARI BACKGROUND ---------------- */
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === MSG.LOG) {
      addLog(msg.text, msg.cls || "mut");
    } else if (msg.type === MSG.STATE) {
      setStatus(!!msg.running);
    } else if (msg.type === MSG.QUEUE_INFO) {
      $("queueInfo").textContent = `Antrean Tersisa: ${msg.remaining}`;
    }
  });

  /* ---------------- PANTU STORAGE (antar-dashboard) ---------------- */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE.POSTING_LOGS]) {
      const logs = changes[STORAGE.POSTING_LOGS].newValue || [];
      // hanya tampilkan log terbaru bila idle agar tidak ganda
      if (!State.running) {
        $("terminal").innerHTML = "";
        logs.forEach((l) => addLog(l.text, l.cls));
      }
    }
    if (changes[STORAGE.GROUPS] || changes[STORAGE.SELECTED_GROUPS]) loadGroups();
    if (changes[STORAGE.ACCOUNT_NAME]) {
      showSaved();
      dashboard.materials.applyAccountFilter();
    }
    /* Bus status scan (pola fb-grupV3): background menulis scanStatus,
       dashboard membaca lewat onChanged agar UI update tanpa reload. */
    const scanChange = changes[STORAGE.SCAN_STATUS];
    if (scanChange) {
      const s = scanChange.newValue;
      if (s && s.state) {
        $("scanMessage").textContent = s.message || `Status scan: ${s.state}`;
        addLog(`Scan grup (${s.state}): ${s.message || "-"}`, s.state === "error" ? "err" : s.state === "done" ? "ok" : "info");
        $("btnScrape").disabled = s.state === "scanning" || s.state === "loading";
      }
    }
    if (changes[STORAGE.MATERIALS]) {
      State.materials = changes[STORAGE.MATERIALS].newValue || [];
      renderMaterials();
    }
  });

  dashboard.controls = { sendMsg, syncStatus };
})(globalThis);
