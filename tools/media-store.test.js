/* =========================================================
   tools/media-store.test.js — uji fungsional media-store.js
   dengan stub IndexedDB (tanpa dependency).
   Simulasi: simpan blob -> "service worker restart" (materi
   tanpa blob di memori) -> hydrateMaterials mengisi ulang dari
   IndexedDB -> nama tak dikenal tetap null (gate scheduler
   akan stop total). Jalankan: node tools/media-store.test.js
   ========================================================= */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

/* ---------- Stub IndexedDB minimal (Promise-friendly timing) ---------- */
function makeIDBStub() {
  const dbs = {};
  return {
    open(name) {
      const req = {};
      setTimeout(() => {
        const db = dbs[name] || (dbs[name] = makeDb());
        req.result = db; /* real IDB: req.result sudah ada saat upgradeneeded */
        if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    },
    _dbs: dbs,
  };
  function makeDb() {
    const data = new Map();
    return {
      _data: data,
      objectStoreNames: { contains: () => true },
      createObjectStore() {},
      close() {},
      transaction(mode) {
        const tx = { oncomplete: null, onabort: null, onerror: null };
        const store = {
          put(value, key) { data.set(key, value); const r = {}; setTimeout(() => r.onsuccess && r.onsuccess({ target: r }), 0); return r; },
          get(key) { const r = { result: data.get(key) }; setTimeout(() => r.onsuccess && r.onsuccess({ target: r }), 0); return r; },
          getAll() { const r = { result: Array.from(data.values()) }; setTimeout(() => r.onsuccess && r.onsuccess({ target: r }), 0); return r; },
          clear() { data.clear(); const r = {}; setTimeout(() => r.onsuccess && r.onsuccess({ target: r }), 0); return r; },
        };
        tx.objectStore = () => store;
        /* PENTING: IDB asli me-commit transaksi SETELAH semua request
           selesai. Node meng-clamp setTimeout 0 -> 1ms, jadi request
           (t=1) WAJIB lebih awal dari tx.oncomplete (t=2). */
        setTimeout(() => { if (tx.oncomplete) tx.oncomplete({ target: tx }); }, 2);
        return tx;
      },
    };
  }
}

async function main() {
  const idb = makeIDBStub();
  const ctx = { console, setTimeout, clearTimeout };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  Object.defineProperty(ctx, "indexedDB", { value: idb, configurable: true, writable: true });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "background", "media-store.js"), "utf8"), ctx, { filename: "media-store.js" });
  const ms = ctx.FBAP.background.mediaStore;
  const assert = (cond, label) => { if (!cond) { console.error("FAIL", label); process.exit(1); } console.log("PASS", label); };

  /* 1. putAllMedia: dedupe nama + hitung */
  const n = await ms.putAllMedia([
    { name: "A.JPG", dataUrl: "data:image/jpeg;base64,AAA", mime: "image/jpeg" },
    { name: "a.jpg", dataUrl: "data:image/jpeg;base64,DUP", mime: "image/jpeg" },
    { name: "b.png", dataUrl: "data:image/png;base64,BBB", mime: "image/png" },
  ]);
  assert(n === 2, "putAllMedia: dedupe nama (A.JPG == a.jpg) -> 2 blob tersimpan");

  /* 2. hydrate: materi dengan blob in-memory tidak tersentuh */
  const withMem = [{ mediaName: "a.jpg", mediaDataUrl: "data:MEM", mediaMime: null, available: false }];
  await ms.hydrateMaterials(withMem);
  assert(withMem[0].mediaDataUrl === "data:MEM", "hydrateMaterials: blob in-memory tetap dipakai");

  /* 3. Simulasi restart service worker: memori kosong -> hydrate dari IDB */
  console.log("-- langkah 3: hydrate setelah 'restart' --");
  const restarted = [
    { caption: "c1", mediaName: "a.jpg", mediaDataUrl: null, mediaMime: null },
    { caption: "c2", mediaName: "b.png", mediaDataUrl: null, mediaMime: null },
    { caption: "c3", mediaName: null, mediaDataUrl: null, mediaMime: null },
    { caption: "c4", mediaName: "hilang.jpg", mediaDataUrl: null, mediaMime: null },
  ];
  await ms.hydrateMaterials(restarted);
  assert(restarted[0].mediaDataUrl === "data:image/jpeg;base64,AAA", "hydrateMaterials: a.jpg dipulihkan dari IndexedDB");
  assert(restarted[1].mediaDataUrl === "data:image/png;base64,BBB", "hydrateMaterials: b.png dipulihkan dari IndexedDB");
  assert(restarted[0].available === true, "hydrateMaterials: available ikut true");
  assert(restarted[2].mediaDataUrl === null, "hydrateMaterials: materi tanpa media dibiarkan tanpa blob");
  assert(restarted[3].mediaDataUrl === null, "hydrateMaterials: nama tak dikenal tetap null (gate scheduler akan stop total)");

  /* 4. clearMedia -> hydrate tidak mengisi apa pun (store kosong) */
  await ms.clearMedia();
  const afterClear = [{ mediaName: "a.jpg", mediaDataUrl: null, mediaMime: null }];
  await ms.hydrateMaterials(afterClear);
  assert(afterClear[0].mediaDataUrl === null, "clearMedia + hydrate: store kosong -> blob tetap null (stop total)");

  console.log("\n== Semua uji fungsional media-store lulus ==");
}
main().catch((e) => { console.error("ERROR:", e); process.exit(1); });