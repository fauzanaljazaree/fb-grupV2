/* =========================================================
   tools/tab-reuse.test.js — Uji anti tab numpuk (postTabId persist).
   Jalankan: node tools/tab-reuse.test.js
   Tanpa dependency. Mensimulasikan service worker MV3 yang bangun
   dari tidur (memori kosong) dan memastikan tab FB lama DIPAKAI ULANG,
   bukan dibuat baru tiap batch.
   ========================================================= */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function fakeEvent() {
  return { addListener() {}, removeListener() {}, hasListener: () => false };
}

function makeChrome(store, tabsImpl) {
  return {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://stub/${p}`,
      sendMessage: (msg, cb) => {
        if (typeof cb === "function") cb({ ok: true });
        return Promise.resolve({ ok: true });
      },
      onMessage: fakeEvent(),
      onInstalled: fakeEvent(),
    },
    storage: {
      local: {
        get: (keys, cb) => cb(Object.assign({}, store)),
        set: (obj, cb) => {
          Object.assign(store, obj);
          if (cb) cb();
        },
      },
      onChanged: fakeEvent(),
    },
    tabs: tabsImpl,
    alarms: {
      create() {},
      clear: () => Promise.resolve(true),
      get: (name, cb) => {
        if (typeof cb === "function") cb();
        return Promise.resolve();
      },
      onAlarm: fakeEvent(),
    },
    action: { onClicked: fakeEvent() },
    power: { requestKeepAwake() {}, releaseKeepAwake() {} },
    scripting: { executeScript: async () => [{}] },
  };
}

/** Muat seluruh background (service-worker + importScripts) di sandbox. */
function loadBackground(chrome) {
  const sandbox = { console, setTimeout, clearTimeout, setInterval, clearInterval, chrome };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  sandbox.importScripts = (...paths) => {
    for (const p of paths) {
      const rel = path.posix.normalize(path.posix.join("src/background", p));
      vm.runInContext(read(rel), ctx, { filename: rel });
    }
  };
  vm.runInContext(read("src/background/service-worker.js"), ctx, { filename: "src/background/service-worker.js" });
  return ctx;
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` -> ${detail}` : ""}`);
  if (!ok) failures++;
}

(async () => {
  const FB_HOME_URL = "https://www.facebook.com/groups/abc";
  /* ---------- Skenario A: worker bangun (memori kosong), ID postTab masih
     ada di storage dan tabnya masih hidup -> tab DIPAKAI ULANG (update), bukan create. ---------- */
  {
    const store = { postTabId: 77 };
    let created = false;
    let updatedId = null;
    let queried = false;
    const chrome = makeChrome(store, {
      get: async (id) => {
        if (id === 77) return { id: 77, status: "complete", url: FB_HOME_URL };
        throw new Error(`No tab with id: ${id}`);
      },
      query: async () => {
        queried = true;
        return [{ id: 5, url: "https://www.facebook.com/" }];
      },
      create: async () => {
        created = true;
        return { id: 99 };
      },
      update: async (id) => {
        updatedId = id;
        return {};
      },
      remove: async () => {},
      sendMessage: (id, msg, cb) => cb && cb({ ok: true }),
      onUpdated: fakeEvent(),
    });
    const ctx = loadBackground(chrome);
    const tabs = ctx.FBAP.background.tabs;
    await tabs.restorePostTab(); /* persis yang dilakukan scheduler saat worker bangun */
    const tab = await tabs.ensurePostTab("https://www.facebook.com/groups/xyz");
    check("A: restorePostTab memulihkan ID dari storage", ctx.FBAP.background.state.run.postTabId === 77, String(ctx.FBAP.background.state.run.postTabId));
    check("A: tab lama dipakai ulang (tidak create tab baru)", !created && updatedId === 77, `created=${created} updatedId=${updatedId}`);
    check("A: tidak perlu query/adopsi", !queried, `queried=${queried}`);
    check("A: ID tetap tercatat", store.postTabId === 77, String(store.postTabId));
    check("A: tab dikembalikan", tab && tab.id === 77, JSON.stringify(tab && tab.id));
  }

  /* ---------- Skenario B: ID basi (tab ditutup user) -> adopsi tab FB
     yang sudah terbuka, BUKAN create. ---------- */
  {
    const store = { postTabId: 77 };
    let created = false;
    let updatedId = null;
    let removedId = null;
    const chrome = makeChrome(store, {
      get: async (id) => {
        if (id === 5) return { id: 5, status: "complete", url: "https://www.facebook.com/" };
        throw new Error(`No tab with id: ${id}`);
      },
      query: async () => [{ id: 5, url: "https://www.facebook.com/" }],
      create: async () => {
        created = true;
        return { id: 99 };
      },
      update: async (id) => {
        updatedId = id;
        return {};
      },
      remove: async (id) => {
        removedId = id;
      },
      sendMessage: (id, msg, cb) => cb && cb({ ok: true }),
      onUpdated: fakeEvent(),
    });
    const ctx = loadBackground(chrome);
    const tabs = ctx.FBAP.background.tabs;
    await tabs.ensurePostTab("https://www.facebook.com/groups/xyz");
    check("B: tab FB eksisting diadopsi (bukan create)", !created && updatedId === 5, `created=${created} updatedId=${updatedId}`);
    check("B: ID baru tercatat", store.postTabId === 5, String(store.postTabId));
    check("B: tab yang diadopsi tidak ditutup", removedId === null, String(removedId));
  }

  /* ---------- Skenario C: tidak ada tab sama sekali -> create baru
     (fallback terakhir) + ID tercatat. ---------- */
  {
    const store = {};
    let createdWith = null;
    const chrome = makeChrome(store, {
      get: async () => {
        throw new Error("No tab");
      },
      query: async () => [],
      create: async (opts) => {
        createdWith = opts;
        return { id: 99 };
      },
      update: async () => ({}),
      remove: async () => {},
      sendMessage: (id, msg, cb) => cb && cb({ ok: true }),
      onUpdated: fakeEvent(),
    });
    const ctx = loadBackground(chrome);
    const tabs = ctx.FBAP.background.tabs;
    const tab = await tabs.ensurePostTab("https://www.facebook.com/groups/xyz");
    check("C: create baru saat memang tidak ada tab", createdWith && tab && tab.id === 99, JSON.stringify(createdWith));
    check("C: ID baru dipersist", store.postTabId === 99, String(store.postTabId));
  }

  /* ---------- Skenario D: forgetPostTab menghapus ID dari storage
     (jalur stopPosting) — tab sendiri TIDAK ditutup. ---------- */
  {
    const store = { postTabId: 77 };
    let removed = null;
    const chrome = makeChrome(store, {
      get: async () => ({ id: 77, status: "complete", url: FB_HOME_URL }),
      query: async () => [],
      create: async () => ({ id: 99 }),
      update: async () => ({}),
      remove: async (id) => {
        removed = id;
      },
      sendMessage: (id, msg, cb) => cb && cb({ ok: true }),
      onUpdated: fakeEvent(),
    });
    const ctx = loadBackground(chrome);
    const tabs = ctx.FBAP.background.tabs;
    await tabs.restorePostTab();
    await tabs.forgetPostTab();
    check("D: forgetPostTab membersihkan storage", store.postTabId === null, JSON.stringify(store.postTabId));
    check("D: memori dibersihkan", ctx.FBAP.background.state.run.postTabId === null, String(ctx.FBAP.background.state.run.postTabId));
    check("D: tabnya TIDAK ditutup", removed === null, String(removed));
  }

  /* ---------- Skenario E: kunci STORAGE.POST_TAB_ID terdaftar + dipakai
     scheduler (storageGet processNextPost) — tanpa string ajaib. ---------- */
  {
    const store = { postTabId: 77 };
    const chrome = makeChrome(store, {
      get: async () => ({ id: 77, status: "complete", url: FB_HOME_URL }),
      query: async () => [],
      create: async () => ({ id: 99 }),
      update: async () => ({}),
      remove: async () => {},
      sendMessage: (id, msg, cb) => cb && cb({ ok: true }),
      onUpdated: fakeEvent(),
    });
    const ctx = loadBackground(chrome);
    const config = ctx.FBAP.config;
    check("E: STORAGE.POST_TAB_ID terdaftar", config.STORAGE.POST_TAB_ID === "postTabId", String(config.STORAGE.POST_TAB_ID));
    const sched = read("src/background/scheduler.js");
    const tabsSrc = read("src/background/tabs.js");
    check("E: scheduler memanggil restorePostTab di startPosting & processNextPost", (sched.match(/await restorePostTab\(\)/g) || []).length >= 2, "startPosting + processNextPost");
    check("E: stopPosting memanggil forgetPostTab", /await forgetPostTab\(\)/.test(sched), "ok");
    check("E: ensurePostTab tanpa tulis langsung run.postTabId di luar helper", (tabsSrc.match(/run\.postTabId\s*=/g) || []).length === 2, "hanya rememberPostTab + restorePostTab");
  }

  /* ---------- Skenario F: mode manual — pool FIFO. Tab baru tiap batch,
     tab manual TERTUA ditutup saat pool penuh (maks MAX_MANUAL_TABS),
     postTab (auto) TIDAK tersentuh. ---------- */
  {
    const store = { postTabId: 55, postTabManualIds: [10, 11, 12] };
    const live = new Set([55, 10, 11, 12]);
    const createdIds = [];
    const removedIds = [];
    let nextId = 100;
    const chrome = makeChrome(store, {
      get: async (id) => {
        if (live.has(id)) return { id, status: "complete", url: "https://www.facebook.com/" };
        throw new Error(`No tab with id: ${id}`);
      },
      query: async () => [],
      create: async () => {
        const id = nextId++;
        createdIds.push(id);
        live.add(id);
        return { id };
      },
      update: async () => ({}),
      remove: async (id) => {
        removedIds.push(id);
        live.delete(id);
      },
      sendMessage: (id, msg, cb) => cb && cb({ ok: true }),
      onUpdated: fakeEvent(),
    });
    const ctx = loadBackground(chrome);
    const tabs = ctx.FBAP.background.tabs;
    ctx.FBAP.background.state.run.showFbTab = true;
    check("F: LIMITS.MAX_MANUAL_TABS = 3", ctx.FBAP.config.LIMITS.MAX_MANUAL_TABS === 3, String(ctx.FBAP.config.LIMITS.MAX_MANUAL_TABS));
    /* Batch manual saat pool sudah penuh (3/3): tutup tertua dulu,
       lalu buka tab baru -> tetap maks 3. */
    const t1 = await tabs.ensureManualPostTab("https://www.facebook.com/");
    check("F: batch manual SELALU buka tab baru (bukan reuse postTab)", createdIds.length === 1 && t1 && t1.id === 100, `created=${JSON.stringify(createdIds)} t1=${t1 && t1.id}`);
    check("F: tab manual tertua (10) ditutup saat pool penuh", removedIds.includes(10), JSON.stringify(removedIds));
    check("F: pool dipersist, tetap maks 3 (urut FIFO)", JSON.stringify(store.postTabManualIds) === JSON.stringify([11, 12, 100]), JSON.stringify(store.postTabManualIds));
    check("F: postTab (auto) tidak tersentuh", store.postTabId === 55 && !removedIds.includes(55), `postTabId=${store.postTabId} removed=${JSON.stringify(removedIds)}`);
    /* Batch manual berikutnya: evict 11, tab batch sebelumnya (100) aman. */
    const t2 = await tabs.ensureManualPostTab("https://www.facebook.com/");
    check("F: batch berikutnya evict tab tertua berikutnya (11); tab sebelumnya (100) aman", removedIds.includes(11) && !removedIds.includes(100) && t2 && t2.id === 101, `removed=${JSON.stringify(removedIds)} t2=${t2 && t2.id}`);
    check("F: pool tetap maks 3 setelah dua batch", (store.postTabManualIds || []).length === 3, JSON.stringify(store.postTabManualIds));
  }

  /* ---------- Skenario G: adopsi auto MELEWATI tab pool manual —
     postTabId basi + tab FB yang terbuka ternyata tab manual -> jangan
     diadopsi/di-navigasi (composer manual harus utuh), buat tab baru. ---------- */
  {
    const store = { postTabId: 77, postTabManualIds: [5] };
    let created = false;
    let removedId = null;
    let updatedId = null;
    const chrome = makeChrome(store, {
      get: async (id) => {
        if (id === 5) return { id: 5, status: "complete", url: "https://www.facebook.com/" };
        throw new Error(`No tab with id: ${id}`);
      },
      query: async () => [{ id: 5, url: "https://www.facebook.com/" }],
      create: async () => {
        created = true;
        return { id: 99 };
      },
      update: async (id) => {
        updatedId = id;
        return {};
      },
      remove: async (id) => {
        removedId = id;
      },
      sendMessage: (id, msg, cb) => cb && cb({ ok: true }),
      onUpdated: fakeEvent(),
    });
    const ctx = loadBackground(chrome);
    const tabs = ctx.FBAP.background.tabs;
    const tab = await tabs.ensurePostTab("https://www.facebook.com/groups/xyz");
    check("G: adopsi auto MELEWATI tab pool manual (create baru, bukan bajak)", created && tab && tab.id === 99, `created=${created} tab=${tab && tab.id}`);
    check("G: composer manual tidak ditutup & tidak dinavigasi ulang", removedId === null && updatedId !== 5, `removed=${removedId} updated=${updatedId}`);
    check("G: pool manual tidak berubah", JSON.stringify(store.postTabManualIds) === "[5]", JSON.stringify(store.postTabManualIds));
    check("G: postTab baru tercatat", store.postTabId === 99, String(store.postTabId));
  }

  console.log(failures === 0 ? "\nSemua skenario tab-reuse LULUS." : `\n${failures} skenario GAGAL.`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
