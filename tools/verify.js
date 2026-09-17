/* =========================================================
   tools/verify.js — Pemeriksa struktur & konsistensi ekstensi.
   Tanpa dependency eksternal. Jalankan:  node tools/verify.js

   Pemeriksaan:
   1. Sintaks semua file JS.
   2. Kode mati (identifier top-level yang tidak pernah dipakai).
   3. Konsistensi id DOM antara dashboard.html dan src/dashboard/*.
   4. manifest.json sinkron dengan FBAP.config.CONTENT_SCRIPT_FILES.
   5. Urutan <script> di dashboard.html sesuai urutan modul.
   6. Nilai FBAP.config.MSG sama dengan nama kuncinya.
   7. Smoke test pemuatan modul (vm + stub chrome/document).
   8. Pemulihan status basi: tombol "Mulai Posting" tidak boleh terkunci
      oleh kunci `status` yang tertinggal dari sesi lama.
   ========================================================= */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const results = [];

function report(ok, label, detail) {
  results.push({ ok, label });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -> ${detail}` : ""}`);
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}
function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["backups", "vendor", "node_modules", "tools"].includes(entry.name)) continue;
      out.push(...listJsFiles(full));
    } else if (entry.name.endsWith(".js")) {
      out.push(path.relative(ROOT, full).replace(/\\/g, "/"));
    }
  }
  return out.sort();
}

/* ---------- 1. SINTKAS ---------- */
function checkSyntax() {
  const files = listJsFiles(ROOT);
  const bad = [];
  for (const rel of files) {
    try {
      new vm.Script(read(rel), { filename: rel });
    } catch (err) {
      bad.push(`${rel}: ${err.message}`);
    }
  }
  report(bad.length === 0, `Sintaks ${files.length} file JS`, bad.join(" | "));
  return files;
}

/* ---------- 2. KODE MATI ---------- */
function countIdentifier(src, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (src.match(new RegExp(`(?<![A-Za-z0-9_$])${esc}(?![A-Za-z0-9_$])`, "g")) || []).length;
}
/** Nama yang dideklarasikan di file: fungsi, const/let/var, dan hasil destructuring. */
function destructuredNames(list) {
  const names = [];
  for (const part of list.split(",")) {
    const raw = part.split("=")[0].trim();
    const name = raw.includes(":") ? raw.split(":")[1].trim() : raw;
    if (/^[A-Za-z0-9_$]+$/.test(name)) names.push(name);
  }
  return names;
}
function collectDeclaredNames(src) {
  return [
    ...[...src.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]),
    ...[...src.matchAll(/^\s*(?:const|let|var)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]),
    ...[...src.matchAll(/^\s*(?:const|let|var)\s*\{([^}]*)\}/gm)].flatMap((m) => destructuredNames(m[1]))
  ];
}
/** Deklarasi level teratas saja (file lama tidak dibungkus IIFE). */
function collectTopLevelNames(src) {
  return [
    ...[...src.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]),
    ...[...src.matchAll(/^(?:const|let|var)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]),
    ...[...src.matchAll(/^(?:const|let|var)\s*\{([^}]*)\}/gm)].flatMap((m) => destructuredNames(m[1]))
  ];
}
function topLevelNames(rel, onlyTopLevel) {
  const src = read(rel);
  return onlyTopLevel ? collectTopLevelNames(src) : collectDeclaredNames(src);
}
function checkDeadCode(files) {
  const dead = [];
  for (const rel of files) {
    const src = read(rel);
    for (const name of collectDeclaredNames(src)) {
      if (countIdentifier(src, name) <= 1) dead.push(`${rel}: ${name}`);
    }
  }
  report(dead.length === 0, "Tidak ada identifier yang menganggur", dead.join(", "));
}

/* ---------- 3. ID DOM DASHBOARD ---------- */
function dashboardJsFiles() {
  return fs
    .readdirSync(path.join(ROOT, "src", "dashboard"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => `src/dashboard/${f}`);
}
function checkDashboardIds() {
  const html = read("dashboard.html");
  const idsInHtml = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const idsUsed = new Set();
  for (const rel of dashboardJsFiles()) {
    for (const m of read(rel).matchAll(/\$\("([^"]+)"\)/g)) idsUsed.add(m[1]);
  }
  const missing = [...idsUsed].filter((id) => !idsInHtml.has(id));
  const unused = [...idsInHtml].filter((id) => !idsUsed.has(id));
  report(missing.length === 0, "Setiap id yang dipakai JS ada di dashboard.html", missing.join(", "));
  report(unused.length === 0, "Setiap id di dashboard.html dipakai JS", unused.join(", "));
}

/* ---------- 4. SINKRONISASI MANIFEST ---------- */
function extractContentFiles() {
  const block = read("src/shared/config.js").match(/CONTENT_SCRIPT_FILES\s*=\s*\[([\s\S]*?)\]/);
  return block ? [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
}
function checkManifestSync() {
  const manifest = JSON.parse(read("manifest.json"));
  const inManifest = (manifest.content_scripts && manifest.content_scripts[0].js) || [];
  const inConfig = extractContentFiles();
  const same = inManifest.length === inConfig.length && inManifest.every((f, i) => f === inConfig[i]);
  report(
    same,
    "manifest.content_scripts[0].js == FBAP.config.CONTENT_SCRIPT_FILES",
    same ? "" : `manifest=[${inManifest}] config=[${inConfig}]`
  );
  const bg = manifest.background && manifest.background.service_worker;
  const paths = [...inManifest, bg, "dashboard.html"].filter(Boolean);
  const missing = paths.filter((p) => !fs.existsSync(path.join(ROOT, p)));
  report(missing.length === 0, "Semua path di manifest.json tersedia", missing.join(", "));
  report(!!bg && fs.existsSync(path.join(ROOT, bg)), `service_worker ada: ${bg}`);
}

/* ---------- 5. URUTAN SCRIPT DASHBOARD ---------- */
function dashboardScriptFiles() {
  return [...read("dashboard.html").matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
}
function checkDashboardScriptOrder() {
  const all = dashboardScriptFiles();
  const srcs = all.filter((s) => s.startsWith("src/"));
  const sharedFirst = srcs.findIndex((s) => s.endsWith("src/shared/config.js"));
  const entryLast = srcs.findIndex((s) => s.endsWith("main.js"));
  report(sharedFirst === 0, "config.js dimuat paling awal di dashboard.html", srcs.join(", "));
  report(entryLast === srcs.length - 1, "main.js dimuat paling akhir di dashboard.html", srcs.join(", "));
  const notFound = all.filter((s) => s !== "xlsx.full.min.js" && !fs.existsSync(path.join(ROOT, s)));
  report(notFound.length === 0, "Semua <script src> dashboard.html ada di disk", notFound.join(", "));
}

/* ---------- 6. SMOKE TEST PEMUATAN MODUL ---------- */
function noop() {}
function fakeEvent() {
  return { addListener: noop, removeListener: noop, hasListener: () => false };
}
function makeChromeStub(store, alarms) {
  alarms = alarms || {};
  return {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://stub/${p}`,
      sendMessage: (msg, cb) => {
        if (typeof cb === "function") cb({ ok: true });
        return Promise.resolve({ ok: true });
      },
      onMessage: fakeEvent(),
      onInstalled: fakeEvent()
    },
    storage: {
      local: {
        get: (keys, cb) => cb(Object.assign({}, store)),
        set: (obj, cb) => {
          Object.assign(store, obj);
          if (cb) cb();
        },
        remove: (keys, cb) => {
          if (cb) cb();
        }
      },
      onChanged: fakeEvent()
    },
    tabs: {
      get: async () => ({ id: 1, status: "complete", url: "https://www.facebook.com/groups/1" }),
      query: async () => [],
      create: async () => ({ id: 1 }),
      update: async () => ({}),
      remove: async () => {},
      sendMessage: (id, msg, cb) => cb && cb({ ok: true }),
      onUpdated: fakeEvent()
    },
    /* Alarm disimpan di map agar pemeriksaan status bisa membedakan sesi yang
       masih terjadwal (alarm ada) dari sesi basi (alarm hilang). */
    alarms: {
      create: (name, info) => { alarms[name] = Object.assign({ name }, info); },
      clear: (name) => { delete alarms[name]; return Promise.resolve(true); },
      get: (name, cb) => {
        const a = alarms[name];
        if (typeof cb === "function") { cb(a); return; }
        return Promise.resolve(a);
      },
      onAlarm: fakeEvent()
    },
    action: { onClicked: fakeEvent() },
    power: { requestKeepAwake: noop, releaseKeepAwake: noop },
    scripting: { executeScript: async () => [{}] }
  };
}
function makeDomStub() {
  const byId = new Map();
  const element = () => ({
    style: {},
    dataset: {},
    textContent: "",
    innerHTML: "",
    className: "",
    value: "",
    disabled: false,
    checked: false,
    scrollTop: 0,
    scrollHeight: 0,
    offsetParent: null,
    isConnected: true,
    classList: { add: noop, remove: noop, contains: () => false },
    addEventListener: noop,
    appendChild: noop,
    focus: noop,
    click: noop,
    setAttribute: noop,
    getAttribute: () => "",
    hasAttribute: () => false,
    dispatchEvent: noop,
    scrollIntoView: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 })
  });
  return {
    location: { href: "https://www.facebook.com/groups/1" },
    document: {
      body: element(),
      scrollingElement: element(),
      documentElement: element(),
      querySelector: () => null,
      querySelectorAll: () => [],
      /* Objek yang sama untuk id yang sama supaya efek samping UI (mis. tombol
         "Mulai Posting" yang ikut terkunci) bisa diperiksa setelah init(). */
      getElementById: (id) => {
        if (!byId.has(id)) byId.set(id, element());
        return byId.get(id);
      },
      createElement: () => element(),
      execCommand: () => true,
      addEventListener: noop
    }
  };
}
function makeSandbox(chrome, extra) {
  const sandbox = Object.assign(
    {
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      addEventListener: noop,
      removeEventListener: noop,
      chrome
    },
    extra || {}
  );
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}
function loadScripts(sandbox, files, baseDir) {
  const ctx = vm.createContext(sandbox);
  sandbox.importScripts = (...paths) => {
    for (const p of paths) {
      const rel = path.posix.normalize(path.posix.join(baseDir || "", p));
      vm.runInContext(read(rel), ctx, { filename: rel });
    }
  };
  for (const rel of files) vm.runInContext(read(rel), ctx, { filename: rel });
  return ctx;
}
function checkLoadBackground() {
  const ctx = loadScripts(makeSandbox(makeChromeStub({})), ["src/background/service-worker.js"], "src/background");
  const bg = ctx.FBAP && ctx.FBAP.background;
  const need = ["state", "power", "messaging", "tabs", "scheduler"];
  const missing = need.filter((k) => !bg || !bg[k]);
  report(missing.length === 0, "Modul background terdaftar (importScripts)", missing.join(", "));
  const api = ["startPosting", "stopPosting", "processNextPost", "sendToContent", "ensurePostTab", "getStatus"];
  const missingApi = api.filter((fn) => !bg || !bg.scheduler[fn] && !bg.tabs[fn]);
  report(missingApi.length === 0, "API background lengkap", missingApi.join(", "));
}
function checkLoadContent() {
  const ctx = loadScripts(makeSandbox(makeChromeStub({}), makeDomStub()), extractContentFiles(), "");
  const ct = ctx.FBAP && ctx.FBAP.content;
  const missing = ["selectors", "dom", "stealth", "media", "navigation", "scraper", "posting"].filter(
    (k) => !ct || !ct[k]
  );
  report(missing.length === 0, "Modul content terdaftar", missing.join(", "));
  const api = ["postToGroup", "navHomeToGroup", "scrapeGroups", "typeLikeHuman", "attachMedia"];
  const flat = api.filter((fn) => !Object.values(ct || {}).some((mod) => mod && typeof mod[fn] === "function"));
  report(flat.length === 0, "API content lengkap", flat.join(", "));
}
/* ---------- 7. PARITAS DENGAN VERSI SEBELUM REFACTOR ---------- */
const BACKUP_DIR = "backups/pre-refactor";
/* Identifier yang sengaja dibuang saat refactor (kode mati, lihat catatan). */
const INTENTIONAL_REMOVALS = ["spin", "storageRemove", "EDITOR_SELECTOR", "randFloat"];
/* Nama lama yang digabung/dipindah saat refactor: nama lama -> lokasi baru. */
const RENAMES = {
  gaussRandom: "FBAP.random.gauss",
  parseSpintax: "FBAP.spintax.parse",
  DASHBOARD: "FBAP.config.PAGES.DASHBOARD"
};

function collectMessageLiterals(files) {
  const found = new Set();
  for (const rel of files) {
    const src = read(rel);
    for (const m of src.matchAll(/(?:type\s*:\s*|type\s*===\s*|case\s*)"([A-Z][A-Z0-9_]+)"/g)) found.add(m[1]);
    for (const m of src.matchAll(/MSG\.([A-Z][A-Z0-9_]+)/g)) found.add(m[1]);
  }
  return found;
}
function checkMsgConstants() {
  const ctx = loadScripts(makeSandbox(makeChromeStub({})), ["src/shared/config.js"], "");
  const MSG = (ctx.FBAP && ctx.FBAP.config && ctx.FBAP.config.MSG) || {};
  const badValue = Object.keys(MSG).filter((k) => MSG[k] !== k);
  report(badValue.length === 0, "Nilai FBAP.config.MSG sama dengan nama kuncinya", badValue.join(", "));
  const used = collectMessageLiterals(listJsFiles(path.join(ROOT, "src")));
  const unused = Object.keys(MSG).filter((k) => !used.has(k));
  report(unused.length === 0, "Tidak ada konstanta MSG yang menganggur", unused.join(", "));
}
function checkParity() {
  const oldFiles = ["background.js", "content.js", "dashboard.js"].map((f) => `${BACKUP_DIR}/${f}`);
  const available = oldFiles.filter((f) => fs.existsSync(path.join(ROOT, f)));
  if (available.length !== oldFiles.length) {
    report(false, `Snapshot pembanding tersedia (${BACKUP_DIR})`, oldFiles.join(", "));
    return;
  }
  const oldNames = new Set(available.flatMap((f) => topLevelNames(f, true)));
  const newNames = new Set(listJsFiles(path.join(ROOT, "src")).flatMap((f) => topLevelNames(f, false)));
  const lost = [...oldNames].filter(
    (n) => !newNames.has(n) && !INTENTIONAL_REMOVALS.includes(n) && !RENAMES[n]
  );
  report(lost.length === 0, "Semua fungsi/konstanta lama pindah ke modul baru", lost.join(", "));

  const oldMsg = collectMessageLiterals(available);
  const newMsg = collectMessageLiterals(listJsFiles(path.join(ROOT, "src")));
  const missingMsg = [...oldMsg].filter((m) => !newMsg.has(m));
  report(missingMsg.length === 0, "Semua tipe pesan lama masih dipakai", missingMsg.join(", "));
}

function checkLoadDashboard() {
  const files = dashboardScriptFiles().filter((s) => s.startsWith("src/"));
  const ctx = loadScripts(makeSandbox(makeChromeStub({}), makeDomStub()), files, "");
  const db = ctx.FBAP && ctx.FBAP.dashboard;
  const modules = ["state", "ui", "materials", "settings", "groups", "controls", "main"];
  const missing = modules.filter((k) => !db || !db[k]);
  report(missing.length === 0, "Modul dashboard terdaftar", missing.join(", "));
  const api = ["renderMaterials", "renderGroups", "fillSettingsForm", "addLog", "setStatus", "init", "syncStatus"];
  const flat = api.filter((fn) => !Object.values(db || {}).some((mod) => mod && typeof mod[fn] === "function"));
  report(flat.length === 0, "API dashboard lengkap", flat.join(", "));
}

/* ---------- 8. PEMULIHAN STATUS BASI (tombol "Mulai Posting" tidak terkunci) ---------- */
function checkStatusRecovery() {
  const shared = loadScripts(makeSandbox(makeChromeStub({})), ["src/shared/config.js"], "");
  const { MSG, STORAGE } = shared.FBAP.config;
  const bgFiles = ["src/background/service-worker.js"];

  /* a) Worker dingin (memori kosong) + kunci `status` bilang running, dan
        TIDAK ada alarm -> sesi basi. Ini kondisi yang mengunci tombol. */
  const staleStore = { [STORAGE.STATUS]: { running: true }, [STORAGE.QUEUE]: [0, 1], [STORAGE.CURSOR]: 2 };
  const staleCtx = loadScripts(makeSandbox(makeChromeStub(staleStore)), bgFiles, "src/background");
  const staleScheduler = staleCtx.FBAP.background.scheduler;

  /* b) Sesi lama yang alarm langkah berikutnya masih terjadwal -> JANGAN reset. */
  const liveStore = { [STORAGE.STATUS]: { running: true } };
  const alarmName = staleScheduler.ALARM_NAME;
  const liveCtx = loadScripts(
    makeSandbox(makeChromeStub(liveStore, { [alarmName]: { name: alarmName } })),
    bgFiles,
    "src/background"
  );
  const liveScheduler = liveCtx.FBAP.background.scheduler;
  const liveRun = liveCtx.FBAP.background.state.run;

  /* c) Dashboard: background menjawab Idle -> tombol Start harus bisa diklik. */
  const dom = makeDomStub();
  const dashStore = {
    [STORAGE.STATUS]: { running: true },
    [STORAGE.MATERIALS]: [{ caption: "Halo", mediaName: "", available: false }]
  };
  const dashChrome = makeChromeStub(dashStore);
  dashChrome.runtime.sendMessage = (msg, cb) => {
    const res = msg && msg.type === MSG.GET_STATUS ? { ok: true, running: false, recovered: true } : { ok: true };
    if (typeof cb === "function") cb(res);
    return Promise.resolve(res);
  };
  loadScripts(makeSandbox(dashChrome, dom), dashboardScriptFiles().filter((s) => s.startsWith("src/")), "");

  return Promise.all([staleScheduler.getStatus(), liveScheduler.getStatus()])
    .then(([stale, live]) => {
      report(
        stale.ok && stale.running === false && stale.recovered === true,
        "Status basi tanpa alarm direset ke Idle",
        JSON.stringify(stale)
      );
      report(
        staleStore[STORAGE.STATUS].running === false &&
          staleStore[STORAGE.QUEUE].length === 0 &&
          staleStore[STORAGE.CURSOR] === 0,
        "status/queue/cursor basi dibersihkan dari storage",
        JSON.stringify(staleStore)
      );
      report(
        live.ok && live.running === true && liveRun.running === true && liveStore[STORAGE.STATUS].running === true,
        "Sesi yang alarmnya masih terjadwal dipulihkan, bukan direset",
        JSON.stringify(live)
      );
      return new Promise((resolve) => setTimeout(resolve, 30));
    })
    .then(() => {
      const btnStart = dom.document.getElementById("btnStart");
      const btnStop = dom.document.getElementById("btnStop");
      report(btnStart.disabled === false, 'Tombol "Mulai Posting" aktif saat background Idle', `disabled=${btnStart.disabled}`);
      report(btnStop.disabled === true, 'Tombol "Hentikan Posting" nonaktif saat background Idle', `disabled=${btnStop.disabled}`);
    });
}

/* ---------- 9. RUNNER ---------- */
(async () => {
  console.log("== FB Auto Poster - verifikasi struktur ==\n");
  const files = checkSyntax();
  checkDeadCode(files);
  checkDashboardIds();
  checkManifestSync();
  checkDashboardScriptOrder();
  checkMsgConstants();
  checkParity();
  checkLoadBackground();
  checkLoadContent();
  checkLoadDashboard();
  await checkStatusRecovery();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n== Ringkasan: ${results.length - failed.length}/${results.length} check lulus ==`);
  process.exit(failed.length ? 1 : 0);
})();

