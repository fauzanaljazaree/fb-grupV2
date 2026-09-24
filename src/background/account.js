/* =========================================================
   FB Auto Poster - Background: Deteksi Akun FB yang Login
   Alur (dipicu dashboard: saat dashboard dibuka, atau user menekan
   tombol ↻ di sebelah textbox nama akun):

     tabs.create(FB_HOME, active:false)   <- TAB DETEKSI SEMENTARA
       -> waitTabLoaded -> settle render React
       -> GET_ACCOUNT_NAME ke content script (fallback: inject lalu ulang)
       -> tulis STORAGE.ACCOUNT_NAME = {name, checkedAt, auto:true}
     finally: tabs.remove(tab deteksi) + focusDashboard()

   KEPUTUSAN: deteksi SELALU memakai tab baru sementara dan TIDAK memakai
   tab posting (`postTab`):
     - menu deteksi dipicu user saat dashboard dibuka — memakai ulang tab
       postTab berisiko menghancurkan composer modal yang sedang menunggu
       klik user (mode manual) atau membatalkan navigasi batch berjalan;
     - tab deteksi dibuka `active:false` supaya FOKUS TETAP DI DASHBOARD,
       dan selalu ditutup di `finally` sehingga tidak ada tab menumpuk.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const background = (FBAP.background = FBAP.background || {});
  const { MSG, STORAGE, PAGES, LIMITS } = FBAP.config;
  const { sleep } = FBAP.time;
  const { set: storageSet } = FBAP.storage;
  const { waitTabLoaded, ensureContentScript, sendToContent, focusDashboard } = background.tabs;
  const { log } = background.messaging;
  const { run } = background.state;

  /* Guard anti-dobel: deteksi kedua diabaikan selama tab deteksi pertama
     masih berjalan (user menekan ↻ dua kali / dua tab dashboard terbuka). */
  let detecting = false;

  /** Minta nama akun ke content script; inject dulu bila belum terpasang
      (FB SPA kadang belum menjalankan content script saat tab selesai). */
  async function requestAccountName(tabId) {
    const first = await sendToContent(tabId, { type: MSG.GET_ACCOUNT_NAME }, LIMITS.ACCOUNT_MSG_TIMEOUT_MS);
    if (first && first.ok && first.name) return first.name;
    const injected = await ensureContentScript(tabId);
    if (!injected) return null;
    await sleep(800);
    const retry = await sendToContent(tabId, { type: MSG.GET_ACCOUNT_NAME }, LIMITS.ACCOUNT_MSG_TIMEOUT_MS);
    return (retry && retry.ok && retry.name) || null;
  }

  /** Deteksi nama akun FB yang sedang login. Selalu resolve:
      `{ok:true, name}` atau `{ok:false, error, busy?}` — dashboard yang
      memutuskan cara menampilkan (nilai lama tidak pernah dihapus). */
  async function detectAccount() {
    if (detecting) return { ok: false, busy: true, error: "Deteksi akun sedang berjalan." };
    detecting = true;
    let tab = null;
    try {
      tab = await chrome.tabs.create({ url: PAGES.FB_HOME, active: false, pinned: false });
      /* Catat ID tab deteksi: findExistingFbTab() mengecualikannya agar tab
         berumur pendek ini tidak diadopsi jadi postTab lalu ikut tertutup. */
      run.detectTabId = tab.id;
      await waitTabLoaded(tab.id, LIMITS.ACCOUNT_TAB_TIMEOUT_MS);
      await sleep(LIMITS.ACCOUNT_SETTLE_MS);
      const name = await requestAccountName(tab.id);
      if (!name) {
        await log("Deteksi akun: nama akun FB tidak ditemukan (belum login / DOM belum siap).", "warn");
        return { ok: false, error: "Nama akun tidak ditemukan atau belum login." };
      }
      await storageSet({ [STORAGE.ACCOUNT_NAME]: { name, checkedAt: Date.now(), auto: true } });
      await log(`Deteksi akun: ${name}`, "ok");
      return { ok: true, name };
    } catch (e) {
      const err = (e && e.message) || String(e);
      await log(`Deteksi akun gagal: ${err}`, "warn");
      return { ok: false, error: err };
    } finally {
      /* Tab deteksi TIDAK pernah ditinggal terbuka, apa pun hasilnya. */
      if (tab && tab.id) {
        try { await chrome.tabs.remove(tab.id); } catch (e) { /* sudah tertutup user */ }
      }
      run.detectTabId = null;
      detecting = false;
      /* Fokus dikembalikan ke dashboard (tab deteksi dibuka non-aktif,
         jadi fokus praktis tidak pernah berpindah). */
      try { await focusDashboard(); } catch (e) { /* abaikan */ }
    }
  }

  background.account = { detectAccount };
})(globalThis);
