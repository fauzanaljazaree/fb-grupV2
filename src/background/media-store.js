/* =========================================================
   FB Auto Poster - Background: Media Store (IndexedDB)
   Penyimpanan blob media SESI posting (dataURL -> string besar).

   MENGAPA INDEXEDDB, BUKAN chrome.storage ATAU MEMORI:
   - Memori (`run.materials`) hilang begitu service worker MV3
     tidur/dimatikan Chrome (jeda antar posting 180-300s) ->
     inilah akar bug "media hilang di grup ke-4+, posting
     tinggal teks".
   - chrome.storage.local berkuota +-5MB; satu video saja bisa
     melewatinya.
   - IndexedDB tersedia di service worker MV3, bertahan lintas
     restart service worker DAN restart browser, kuota besar.

   Kontrak: satu sesi posting = satu isi store. startPosting()
   mengganti seluruh isi (putAllMedia); prosesNextPost() mengisi
   ulang blob yang hilang dari memori (hydrateMaterials) sebelum
   mengirim EXECUTE_POST. Bila blob wajib tidak ketemu (memori +
   IndexedDB), scheduler MENGHENTIKAN SESI (keputusan user:
   jangan pernah posting teks diam-diam).
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});

  const DB_NAME = "fbap-media";
  const STORE = "media";
  const VERSION = 1;

  /** Buka (sekalian upgrade schema) database media. Dibuka-tutup
      per operasi: service worker MV3 bisa dimatikan kapan saja,
      koneksi yang dibiarkan terbuka jadi sumber error `InvalidState`. */
  function openDb() {
    return new Promise((resolve, reject) => {
      const idb = root.indexedDB;
      if (!idb) {
        reject(new Error("IndexedDB tidak tersedia di konteks ini"));
        return;
      }
      const req = idb.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Gagal membuka IndexedDB"));
      req.onblocked = () => reject(new Error("IndexedDB diblokir koneksi lain"));
    });
  }

  /** Bungkus IDBRequest jadi Promise. */
  function reqAsPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Permintaan IndexedDB gagal"));
    });
  }

  /** Jalankan `fn(store)` di dalam SATU transaksi, tunggu commit. */
  async function withStore(mode, fn) {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const out = await fn(store);
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error || new Error("Transaksi IndexedDB dibatalkan"));
        tx.onerror = () => reject(tx.error || new Error("Transaksi IndexedDB gagal"));
      });
      return out;
    } finally {
      try { db.close(); } catch (e) { /* abaikan */ }
    }
  }

  /** Simpan/replace satu blob media: {name, dataUrl, mime}.
      Kunci = nama file lowercase (konsisten dgn folderMap dashboard). */
  async function putMedia(entry) {
    const key = String(entry.name || "").toLowerCase();
    await withStore("readwrite", (store) => reqAsPromise(
      store.put({ name: key, dataUrl: entry.dataUrl, mime: entry.mime || "application/octet-stream" }, key)
    ));
    return key;
  }

  /** Ambil satu blob by nama -> {name, dataUrl, mime} | null. */
  async function getMedia(name) {
    const key = String(name || "").toLowerCase();
    const hit = await withStore("readonly", (store) => reqAsPromise(store.get(key)));
    return hit || null;
  }

  /** Kosongkan seluruh store (dipanggil awal sesi baru). */
  async function clearMedia() {
    await withStore("readwrite", (store) => reqAsPromise(store.clear()));
    return true;
  }

  /** Simpan banyak media sekaligus dalam SATU transaksi: isi lama
      DIBERSIHKAN dulu (satu sesi = satu isi store). Nama duplikat
      di-dedupe. Return jumlah blob unik yang tersimpan. */
  async function putAllMedia(entries) {
    const byName = new Map();
    for (const e of entries || []) {
      if (!e || !e.name || !e.dataUrl) continue;
      const key = String(e.name).toLowerCase();
      if (!byName.has(key)) {
        byName.set(key, { name: key, dataUrl: e.dataUrl, mime: e.mime || "application/octet-stream" });
      }
    }
    await withStore("readwrite", (store) => {
      store.clear();
      for (const rec of byName.values()) store.put(rec, rec.name);
    });
    return byName.size;
  }

  /** Isi ulang mediaDataUrl/mediaMime materi dari IndexedDB — hanya untuk
      materi yang blob in-memory-nya sudah hilang (service worker baru
      bangun dari tidur / browser baru direstart). Dipakai processNextPost
      SEBELUM gate media, sehingga sesi panjang tetap bermedia penuh. */
  async function hydrateMaterials(materials) {
    if (!Array.isArray(materials) || !materials.length) return materials;
    const need = materials.some((m) => m && m.mediaName && !m.mediaDataUrl);
    if (!need) return materials;
    const all = await withStore("readonly", (store) => reqAsPromise(store.getAll()));
    const byName = new Map((all || []).map((rec) => [rec && rec.name, rec]));
    for (const m of materials) {
      if (!m || !m.mediaName || m.mediaDataUrl) continue;
      const hit = byName.get(String(m.mediaName).toLowerCase());
      if (hit && hit.dataUrl) {
        m.mediaDataUrl = hit.dataUrl;
        m.mediaMime = hit.mime || m.mediaMime || "application/octet-stream";
        m.available = true;
      }
    }
    return materials;
  }

  FBAP.background = FBAP.background || {};
  FBAP.background.mediaStore = { putMedia, getMedia, clearMedia, putAllMedia, hydrateMaterials };
})(globalThis);