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
     (diverifikasi lewat storage.onChanged, bukan asumsi UI).
     Permanen: buka-tutup dashboard tetap ada (restore di main.js).
     Hanya overwrite saat user mengetik ulang (input kosong diabaikan,
     tidak menghapus nama tersimpan). */
  let accountSaveTimer = null;
  let lastSavedAccount = "";

  $("accountNameInput").addEventListener("input", () => {
    clearTimeout(accountSaveTimer);
    showSaving();
    accountSaveTimer = setTimeout(async () => {
      const name = $("accountNameInput").value.trim();
      try {
        if (!name) {
          /* Input kosong = abaikan, kembalikan ke nilai tersimpan agar
             nama permanen tidak terhapus accidentaly. */
          if (lastSavedAccount) {
            $("accountNameInput").value = lastSavedAccount;
            showSaved();
          }
          return;
        }
        if (name === lastSavedAccount) {
          showSaved();
          return;
        }
        await setStrict({ [STORAGE.ACCOUNT_NAME]: { name, checkedAt: Date.now() } });
        lastSavedAccount = name;
        /* Centang tampil lewat storage.onChanged di bawah. */
        dashboard.materials.applyAccountFilter();
      } catch (e) {
        showSaveError();
        addLog(`Gagal menyimpan nama akun: ${e.message}`, "err");
      }
    }, 600);
  });

  /* Cache nilai tersimpan agar guard kosong/identik bekerja + restore sinkron. */
  FBAP.storage.get([STORAGE.ACCOUNT_NAME]).then((data) => {
    try {
      const raw = data && data[STORAGE.ACCOUNT_NAME];
      const saved = typeof raw === "string" ? raw : (raw && raw.name) || "";
      if (String(saved).trim()) {
        lastSavedAccount = String(saved).trim();
        if (!$("accountNameInput").value) {
          $("accountNameInput").value = lastSavedAccount;
        }
      }
    } catch (_) {}
  });

  /* ---------------- MULAI POSTING ----------------
     Alur baru: 1 materi diposting ke SEMUA grup yang dicentang di tabel
     (urutan tabel atas->bawah), baru lanjut materi berikutnya. */
  $("btnStart").addEventListener("click", async () => {
    if (!State.materials.length) { addLog("Tidak ada materi untuk diposting. Import Excel + media dulu.", "err"); return; }
    if (State.materials.some((m) => m.mediaName && !m.available)) {
      addLog("Ada materi dengan media tidak tersedia — akan diposting tanpa media.", "warn");
    }
    const targetGroups = (State.groups || []).filter((g) => State.selected.has(g.url));
    if (!targetGroups.length) { addLog("Tidak ada grup yang dicentang. Centang dulu grup di tabel.", "err"); return; }
    try { await setStrict({ [STORAGE.GROUP_RESULTS]: {} }); } catch (e) { /* abaikan */ }
    try { dashboard.groups.resetResults(); } catch (e) { /* abaikan */ }

    const batchPost = $("chkBatchPost").checked;
    addLog(`Menjalankan posting ${State.materials.length} materi x ${targetGroups.length} grup = ${State.materials.length * targetGroups.length} posting (${batchPost ? "batch: 1 submit s.d. 10 grup" : "satuan: 1 grup 1 submit"}).`, "info");

    const res = await sendMsg({
      type: MSG.START_POSTING,
      payload: {
        materials: State.materials.map((m) => ({
          caption: m.caption || "",
          mediaName: m.mediaName || "",
          mediaDataUrl: m.available ? m.mediaDataUrl : null,
          mediaMime: m.mediaMime || "application/octet-stream"
        })),
        groups: targetGroups.map((g) => ({ name: g.name, url: g.url })),
        settings: { ...State.settings, showFbTab: $("chkShowFb").checked, autoPost: $("chkAutoPost").checked, batchPost }
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

  /* ------- Checkbox "autoposting" (menggantikan tombol "Uji Post") -------
     checked   -> content script klik tombol Posting otomatis + verifikasi.
     unchecked -> content script berhenti setelah media+caption terisi,
                  memberi user jendela MANUAL_POST_WINDOW_MS untuk klik
                  Posting sendiri; setelah jendela habis alur tetap lanjut.
     Nilai disimpan ke STORAGE.SETTINGS supaya ikut terkirim sebagai
     payload.settings saat "Mulai Posting" ditekan. */
  $("chkAutoPost").addEventListener("change", async (e) => {
    const auto = e.target.checked;
    State.settings.autoPost = auto;
    await setStrict({ [STORAGE.SETTINGS]: { ...State.settings, autoPost: auto } }).catch(() => {});
    addLog(auto
      ? "Autoposting AKTIF: tombol Posting diklik otomatis setiap langkah."
      : "Autoposting NONAKTIF: media+caption disiapkan, lalu 10 detik untuk klik Posting sendiri — setelah itu antrean lanjut.", "info");
  });

  /* ------- Checkbox "Posting Batch" -------
     checked   -> workflow 1+9: 1 submit menjangkau s.d. 10 grup
                  (grup utama dinavigasi natural + s.d. 9 tambahan
                  dicentang via picker "Tambahkan grup").
     unchecked -> 1 grup 1 submit: setiap grup dinavigasi natural dan
                  diposting SATU-SATU; picker "Tambahkan grup" tidak
                  pernah dibuka (aman bila picker sering gagal).
     Nilai disimpan ke STORAGE.SETTINGS supaya ikut terkirim sebagai
     payload.settings saat "Mulai Posting" ditekan. */
  $("chkBatchPost").addEventListener("change", async (e) => {
    const batch = e.target.checked;
    State.settings.batchPost = batch;
    await setStrict({ [STORAGE.SETTINGS]: { ...State.settings, batchPost: batch } }).catch(() => {});
    addLog(batch
      ? "Posting Batch AKTIF: 1 submit menjangkau s.d. 10 grup via picker \"Tambahkan grup\"."
      : "Posting Batch NONAKTIF: posting 1 grup 1 submit — picker \"Tambahkan grup\" tidak dipakai.", "info");
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
    } else if (msg.type === MSG.GROUP_RESULT) {
      try { dashboard.groups.applyResult(msg); } catch (e) { /* abaikan */ }
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
      const nv = changes[STORAGE.ACCOUNT_NAME].newValue;
      const saved = typeof nv === "string" ? nv : (nv && nv.name) || "";
      if (String(saved).trim()) lastSavedAccount = String(saved).trim();
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
