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
  const { get: storageGet } = FBAP.storage;
  const { State } = dashboard.state;
  const { $, addLog, setStatus, showSaving, showSaved, showSaveError } = dashboard.ui;
  const { renderMaterials } = dashboard.materials;
  const { loadGroups } = dashboard.groups;

  /* ---------------- COUNTDOWN JEDA ANTAR POSTINGAN ----------------
     Sumber kebenaran: epoch ms STORAGE.NEXT_POST_AT (ditulis scheduleNext
     background, persist agar tahan restart SW & reload dashboard).
     Dashboard HANYA menghitung mundur via setInterval 1 detik — tidak ada
     alarm/tick tambahan dari background. Format: "3 mnt 12 dtk". */
  let nextAtMs = 0;
  let countdownTimer = null;

  /** Format sisa ms -> "X mnt Y dtk" / "Y dtk" / "segera…". */
  function formatCountdown(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    if (s <= 0) return "segera…";
    const mnt = Math.floor(s / 60);
    const dtk = s % 60;
    if (mnt <= 0) return `${dtk} dtk`;
    return `${mnt} mnt ${dtk} dtk`;
  }

  /** Render satu tick countdown ke #nextPostInfo. */
  function renderCountdown() {
    let el = null;
    try { el = $("nextPostInfo"); } catch (e) { el = null; }
    if (!el) return;
    if (!State.running || !nextAtMs || nextAtMs <= Date.now()) {
      el.textContent = State.running ? "⏳ Postingan berikutnya: segera…" : "⏳ Postingan berikutnya: -";
      return;
    }
    el.textContent = `⏳ ${formatCountdown(nextAtMs - Date.now())} lagi`;
  }

  /** Set jadwal baru + pastikan interval 1 detik berjalan. */
  function setNextAt(v) {
    nextAtMs = typeof v === "number" && v > 0 ? v : 0;
    renderCountdown();
    if (!countdownTimer) {
      countdownTimer = setInterval(renderCountdown, 1000);
    }
  }

  /** Hentikan countdown (stop/selesai): tampilkan "-" tapi biarkan
      interval hidup agar sesi berikutnya langsung tampil tanpa re-init. */
  function clearNextAt() {
    nextAtMs = 0;
    renderCountdown();
  }

  // Render awal agar chip tidak kosong sebelum pesan pertama tiba.
  try { renderCountdown(); } catch (e) { /* DOM belum siap */ }

  /** Kirim pesan ke background; selalu resolve (error jadi {ok:false}). */
  function sendMsg(msg) {
    return new Promise((res) => chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) res({ ok: false, error: chrome.runtime.lastError.message });
      else res(r);
    }));
  }

  /* ---------------- BERSIHKAN LIVE LOG (DOM + storage) ----------------
     Mengosongkan #terminal saja TIDAK cukup: listener storage.onChanged di
     bawah me-render ulang seluruh isi `postingLogs` dari storage setiap ada
     perubahan, sehingga log lama muncul kembali begitu background menulis log
     baru — inilah sebab tombol "Bersihkan Log" dan auto-clear saat "Mulai
     Posting" tampak tidak berefek. Jadi kunci storage-nya ikut dikosongkan
     dalam satu operasi. */
  async function clearLog() {
    $("terminal").innerHTML = "";
    try {
      await setStrict({ [STORAGE.POSTING_LOGS]: [] });
    } catch (e) {
      addLog(`Gagal mengosongkan log tersimpan di storage: ${e.message}`, "warn");
    }
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
    /* Countdown: pulihkan jadwal agar reload dashboard di tengah sesi
       langsung menampilkan sisa jeda (fallback baca storage bila
       background tak menyertakan nextAt). */
    if (res.running && typeof res.nextAt === "number" && res.nextAt > 0) {
      setNextAt(res.nextAt);
    } else if (res.running) {
      try {
        const data = await storageGet([STORAGE.NEXT_POST_AT]);
        setNextAt(data && data[STORAGE.NEXT_POST_AT]);
      } catch (e) { /* abaikan */ }
    } else {
      clearNextAt();
    }
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
    /* Fitur debugging: setiap klik "Mulai Posting" = sesi log baru, jadi Live
       Log lama dibersihkan dulu (DOM + storage) supaya log sesi ini tidak
       tercampur sisa log sesi sebelumnya. */
    await clearLog();
    if (!State.materials.length) { addLog("Tidak ada materi untuk diposting. Import Excel + media dulu.", "err"); return; }
    /* GUARD MEDIA (jangan posting teks diam-diam): materi yang MEMAKAI media
       tapi blob tidak terbaca dari folder media (badge "✗ Tidak Ada") ->
       tolak mulai dengan pesan jelas. Dulu hanya "warn" lalu tetap jalan
       dengan mediaDataUrl null — posting pun jadi teks saja tanpa error.
       Materi "Tanpa Media" (tanpa kolom Media_Name) tetap boleh berjalan. */
    const missingMedia = State.materials.filter((m) => m.mediaName && (!m.available || !m.mediaDataUrl));
    if (missingMedia.length) {
      const names = [...new Set(missingMedia.map((m) => m.mediaName))].slice(0, 5).join(", ");
      addLog(`Tidak bisa mulai: media tidak tersedia untuk ${missingMedia.length} materi (${names}${missingMedia.length > 5 ? ", ..." : ""}). Muat ulang folder media di dashboard sampai badge berubah "✓ Tersedia", lalu mulai lagi.`, "err");
      return;
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
          /* Blob DIKIRIM APA ADANYA — background mem-persist ke IndexedDB.
             Jangan kirim null saat m.available false: guard di atas sudah
             menolak sesi bila media wajib hilang, jadi null di sini hanya
             terjadi untuk materi yang memang tanpa media. */
          mediaDataUrl: m.mediaDataUrl || null,
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

  /* Bersihkan Log: pakai clearLog() yang sama dengan auto-clear "Mulai Posting"
     agar storage ikut dikosongkan — kalau hanya DOM, onChanged merendernya ulang. */
  $("btnClearLog").addEventListener("click", async () => {
    await clearLog();
  });

  /* ---------------- SALIN SEMUA LOG (fitur debugging) ----------------
     Kumpulkan tiap baris Live Log lalu salin ke clipboard. */
  $("btnCopyLog").addEventListener("click", async () => {
    const lines = [...$("terminal").querySelectorAll(".line")]
      .map((el) => {
        const parts = [...el.children].map((c) => c.textContent);
        return (parts.length ? parts.join(" ") : el.textContent).trim();
      })
      .filter(Boolean);
    if (!lines.length) { addLog("Tidak ada log untuk disalin.", "warn"); return; }
    const text = lines.join("\n");
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) { /* fallback di bawah */ }
    if (!ok) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      ta.remove();
    }
    addLog(ok ? `Berhasil menyalin ${lines.length} baris log ke clipboard.` : "Gagal menyalin log ke clipboard.", ok ? "ok" : "err");
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
      if (!msg.running) clearNextAt();
      else renderCountdown();
    } else if (msg.type === MSG.QUEUE_INFO) {
      $("queueInfo").textContent = `Antrean Tersisa: ${msg.remaining}`;
      setNextAt(msg.nextAt);
    } else if (msg.type === MSG.GROUP_RESULT) {
      try { dashboard.groups.applyResult(msg); } catch (e) { /* abaikan */ }
    } else if (msg.type === MSG.SELL_GROUP_MARKED) {
      /* Grup terdeteksi jual-beli: uncheck baris + badge 🏷️ realtime. */
      try { dashboard.groups.applySellGroupMarked(msg); } catch (e) { /* abaikan */ }
    }
  });

  /* ---------------- PANTU STORAGE (antar-dashboard) ---------------- */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE.POSTING_LOGS]) {
      const logs = changes[STORAGE.POSTING_LOGS].newValue || [];
      /* newValue KOSONG = permintaan bersihkan (clearLog): terminal sudah
         dikosongkan pemanggil, jadi jangan render ulang — kalau dirender,
         baris yang baru saja ditulis (mis. pesan validasi) ikut terhapus.
         Bila ada isinya: render ulang dari storage hanya saat idle agar
         tidak ganda dengan aliran MSG.LOG realtime. */
      if (logs.length && !State.running) {
        $("terminal").innerHTML = "";
        logs.forEach((l) => addLog(l.text, l.cls));
      }
    }
    if (changes[STORAGE.GROUPS] || changes[STORAGE.SELECTED_GROUPS] || changes[STORAGE.SELL_GROUPS]) loadGroups();
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
    /* Countdown lintas tab dashboard: scheduleNext/stopPosting menulis
       STORAGE.NEXT_POST_AT -> semua dashboard terbuka ikut update. */
    if (changes[STORAGE.NEXT_POST_AT]) {
      setNextAt(changes[STORAGE.NEXT_POST_AT].newValue);
    }
  });

  dashboard.controls = { sendMsg, syncStatus, formatCountdown, setNextAt, clearNextAt };
})(globalThis);
