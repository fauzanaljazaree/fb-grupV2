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
   9. Rantai navigasi home -> grup -> composer (DOM Facebook tiruan).
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
  const need = ["state", "power", "messaging", "tabs", "scan", "scheduler"];
  const missing = need.filter((k) => !bg || !bg[k]);
  report(missing.length === 0, "Modul background terdaftar (importScripts)", missing.join(", "));
  const api = ["startPosting", "stopPosting", "processNextPost", "sendToContent", "ensurePostTab", "getStatus"];
  const missingApi = api.filter((fn) => !bg || !bg.scheduler[fn] && !bg.tabs[fn]);
  report(missingApi.length === 0, "API background lengkap", missingApi.join(", "));
  const scanApi = ["runScan", "isScanActive"].filter((fn) => !bg || !bg.scan || typeof bg.scan[fn] !== "function");
  report(scanApi.length === 0, "API background.scan lengkap (runScan, isScanActive)", scanApi.join(", "));
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

/* ---------- 9. UJI RANTAI NAVIGASI: HOME -> GRUP -> COMPOSER ----------
   Content script asli (config -> ... -> content.js) dijalankan di atas DOM
   Facebook tiruan, lalu router dipanggil dengan NAV_HOME_TO_COMPOSER.
   Diperiksa: urutan klik natural (menu "Grup" -> grup teratas -> trigger
   composer), grup pertama dari sidebar yang terpilih, dan editor
   contenteditable terdeteksi sebagai bukti composer benar-benar terbuka. */
function makeFakeFbDom() {
  const state = { href: "https://www.facebook.com/", clicked: [], composerOpen: false };
  const size = (width, height) => ({ width, height, top: 0, left: 0 });
  const genericEl = (text) => ({
    textContent: text || "",
    style: {},
    scrollTop: 0,
    scrollHeight: 400,
    clientHeight: 300,
    offsetParent: {},
    isConnected: true,
    order: 0,
    scrollIntoView: noop,
    focus: noop,
    setAttribute: noop,
    hasAttribute: () => false,
    dispatchEvent: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => size(0, 0),
    /* Urutan dokumen: 4 = DOCUMENT_POSITION_FOLLOWING, cukup untuk kode produksi
       yang hanya menguji bit tersebut. */
    compareDocumentPosition(other) {
      return other && other.order > this.order ? 4 : 0;
    }
  });

  /* Sidebar homepage: menu "Grup" (GRUP_LINK). Klik memindahkan URL seperti SPA. */
  const grupLink = Object.assign(genericEl("Grup"), {
    getAttribute: (name) => (name === "href" ? "/groups/?ref=bookmarks" : ""),
    getBoundingClientRect: () => size(220, 36),
    click: () => {
      state.clicked.push("menu-grup");
      state.href = "https://www.facebook.com/groups/feed/";
    }
  });

  /* Link grup pertama di sidebar daftar grup.
     order=10 > heading.order=5: meniru DOM nyata di mana link grup berada
     SETELAH heading dalam urutan dokumen (diagnostic perHop=[0,1,1,1,1,1]). */
  const groupLink = Object.assign(genericEl("Grup Jualan Komando45"), {
    order: 10,
    getAttribute: (name) => (name === "href" ? "/groups/123456789" : ""),
    getBoundingClientRect: () => size(220, 32),
    click: () => {
      state.clicked.push("pilih-grup");
      state.href = "https://www.facebook.com/groups/123456789/";
    }
  });

  /* Heading "Grup yang Anda bergabung..." — cabang ancestor-nya SENGAJA
     TIDAK berisi link grup (persis DOM nyata: perHop=[0,1,1,1,1,1] hanya
     berisi "Buat Grup Baru"). findTopJoinedGroup harus menemukan groupLink
     lewat urutan dokumen (firstGroupAfter), bukan lewat ancestor. */
  const heading = Object.assign(genericEl("Grup yang Anda bergabung di dalamnya"), {
    order: 5,
    parentElement: genericEl("")
  });
  const sidebar = Object.assign(genericEl(""), {
    querySelectorAll: (sel) => {
      if (sel.indexOf("h2") !== -1) return [heading];
      if (sel.indexOf("groups/") !== -1) return [groupLink];
      return [];
    }
  });

  /* Trigger composer + editor di halaman grup. */
  const trigger = Object.assign(genericEl("Tulis sesuatu..."), {
    getBoundingClientRect: () => size(600, 40),
    click: () => {
      state.clicked.push("trigger-composer");
      state.composerOpen = true;
    }
  });
  const editor = Object.assign(genericEl(""), {
    getAttribute: (name) => (name === "aria-placeholder" ? "Buat postingan..." : ""),
    hasAttribute: (name) => name === "data-lexical-editor",
    getBoundingClientRect: () => size(520, 64)
  });

  const inGroupsPage = () => state.href.indexOf("/groups/") !== -1;
  return {
    state,
    location: {
      get href() { return state.href; },
      set href(v) { state.href = v; }
    },
    document: {
      body: genericEl(""),
      scrollingElement: genericEl(""),
      documentElement: genericEl(""),
      querySelector: (sel) => {
        if (sel.indexOf("bookmarks") !== -1) return inGroupsPage() ? null : grupLink;
        if (sel.indexOf("navigation") !== -1) return inGroupsPage() ? sidebar : null;
        return null;
      },
      querySelectorAll: (sel) => {
        if (sel.indexOf("contenteditable") !== -1) return state.composerOpen ? [editor] : [];
        if (sel.indexOf("button") !== -1) return state.composerOpen ? [] : [trigger];
        return [];
      },
      execCommand: () => true,
      addEventListener: noop
    }
  };
}

async function checkHomeToComposerChain() {
  const dom = makeFakeFbDom();
  const listeners = [];
  const chromeStub = makeChromeStub({});
  chromeStub.runtime.onMessage = {
    addListener: (fn) => listeners.push(fn),
    removeListener: noop,
    hasListener: () => false
  };

  const ctx = loadScripts(makeSandbox(chromeStub, dom), extractContentFiles(), "");
  const { MSG } = ctx.FBAP.config;
  report(
    listeners.length === 1,
    "Router content script terpasang sekali (guard routerReady)",
    `listeners=${listeners.length}`
  );

  const resp = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: "timeout harness" }), 90000);
    listeners[0]({ type: MSG.NAV_HOME_TO_COMPOSER }, {}, (r) => {
      clearTimeout(timer);
      resolve(r || {});
    });
  });

  report(
    !!(resp && resp.ok),
    "NAV_HOME_TO_COMPOSER membalas ok (rantai home -> grup -> composer)",
    JSON.stringify(resp)
  );
  report(
    resp.groupUrl === "https://www.facebook.com/groups/123456789" && !!resp.groupName,
    "Grup pertama di sidebar terpilih sebagai tujuan composer",
    `${resp.groupUrl} / ${resp.groupName}`
  );
  report(
    dom.state.clicked.join(" > ") === "menu-grup > pilih-grup > trigger-composer",
    "Urutan klik natural: menu Grup -> grup teratas -> trigger composer",
    dom.state.clicked.join(" > ")
  );
  report(
    dom.state.composerOpen === true,
    "Editor contenteditable terdeteksi (composer benar-benar terbuka)",
    `composerOpen=${dom.state.composerOpen}`
  );
}

/* ---------- Check rantai posting == rantai uji composer ----------
   Alur "Mulai Posting" wajib memakai pesan NAV_HOME_TO_COMPOSER pada
   langkah navigasi pertamanya (sama dengan tombol "Uji Buka Composer"
   yang terbukti bekerja), bukan NAV_HOME_TO_GROUP. */
function checkPostingUsesComposerChain() {
  const src = read("src/background/scheduler.js");
  const usesComposer = /MSG\.NAV_HOME_TO_COMPOSER/.test(src);
  const stillRawNav = /MSG\.NAV_HOME_TO_GROUP/.test(src);
  report(usesComposer, "Langkah navigasi posting memakai NAV_HOME_TO_COMPOSER", usesComposer ? "ok" : "tidak ditemukan");
  report(!stillRawNav, "Pesan NAV_HOME_TO_GROUP tidak lagi dipakai alur posting", stillRawNav ? "masih ada" : "bersih");
  const posting = read("src/content/posting.js");
  report(
    /async function openComposer[\s\S]*findEditor\(3?0?0?0?\)/.test(posting.replace(/\r/g, "")),
    "openComposer() idempoten (cek editor terbuka dulu sebelum klik trigger)",
    /findEditor\(3000\)/.test(posting) ? "findEditor(3000) ok" : "pola tidak cocok"
  );
}

/* ---------- Check wiring tombol "Uji Post" (media dulu -> caption) ----------
   Alur tombol "Uji Post" wajib: TEST_POST (dashboard) -> testPostFirstMaterial
   (background) -> EXECUTE_TEST_POST (content) -> testCompose yang memakai
   uploadMedia SEBELUM typeCaption (urutan media dulu, tanpa klik Posting). */
function checkTestPostWiring() {
  const config = read("src/shared/config.js");
  report(
    /TEST_POST:\s*"TEST_POST"/.test(config) && /EXECUTE_TEST_POST:\s*"EXECUTE_TEST_POST"/.test(config),
    "Konstanta TEST_POST & EXECUTE_TEST_POST terdaftar di FBAP.config.MSG",
    "ok"
  );

  const controls = read("src/dashboard/controls.js");
  report(
    /btnTestComposer[\s\S]*?MSG\.TEST_POST/.test(controls),
    "Tombol \"Uji Post\" mengirim pesan TEST_POST",
    /MSG\.TEST_POST/.test(controls) ? "ok" : "OPEN_COMPOSER dipakai"
  );

  const sw = read("src/background/service-worker.js");
  report(
    /case MSG\.TEST_POST:[\s\S]*?testPostFirstMaterial\(\)/.test(sw.replace(/\r/g, "")),
    "Service worker meroute TEST_POST ke scheduler.testPostFirstMaterial",
    /testPostFirstMaterial/.test(sw) ? "ok" : "route tidak ditemukan"
  );

  const sched = read("src/background/scheduler.js");
  report(
    /async function testPostFirstMaterial[\s\S]*?NAV_HOME_TO_COMPOSER[\s\S]*?EXECUTE_TEST_POST/.test(sched.replace(/\r/g, "")),
    "Uji Post memakai rantai navigasi terbukti lalu EXECUTE_TEST_POST",
    "ok"
  );

  const content = read("src/content/content.js");
  report(
    /MSG\.EXECUTE_TEST_POST[\s\S]*?testCompose\(/.test(content.replace(/\r/g, "")),
    "Router content script menangani EXECUTE_TEST_POST dengan testCompose()",
    "ok"
  );

  const posting = read("src/content/posting.js").replace(/\r/g, "");
  const uploadFirst = posting.indexOf("uploadMedia(");
  const captionAfter = posting.indexOf("typeCaption(editor, finalText)");
  report(
    uploadFirst !== -1 && captionAfter !== -1 && uploadFirst < captionAfter,
    "testCompose: uploadMedia DIPANGGUL SEBELUM typeCaption (urutan media dulu)",
    uploadFirst !== -1 && captionAfter !== -1 ? `posisi ${uploadFirst} < ${captionAfter}` : "urutan salah"
  );
  report(
    /async function testCompose[\s\S]*?return \{ dialog: info\.dialog/.test(posting),
    "testCompose berhenti tanpa klik tombol Posting (dry-run)",
    "ok"
  );

  /* ---------- Check jalur produksi (Mulai Posting) = workflow media-dulu ----------
     postToGroup() wajib memakai inti bersama composeMediaAndCaption (urutan
     uploadMedia sebelum typeCaption), lalu klik tombol Posting dan verifikasi
     composer tertutup (anti false-sukses antrean). */
  const core = posting.indexOf("async function composeMediaAndCaption");
  const testUse = posting.indexOf("await composeMediaAndCaption(caption");
  const prodUse = posting.indexOf("await composeMediaAndCaption(caption", testUse + 1);
  report(
    core !== -1 && testUse !== -1 && prodUse !== -1,
    "postToGroup & testCompose memakai SATU inti bersama composeMediaAndCaption",
    core !== -1 && prodUse !== -1 ? "ok" : "inti bersama tidak dipakai"
  );
  report(
    /async function postToGroup[\s\S]*?composeMediaAndCaption[\s\S]*?findPostButton/.test(posting),
    "postToGroup: inti media-dulu -> caption -> klik tombol Posting",
    "ok"
  );
  report(
    /VERIFIKASI PASCA-SUBMIT[\s\S]*?composer tertutup setelah klik Posting[\s\S]*?retry/.test(posting),
    "postToGroup: verifikasi composer tertutup + retry (anti false-sukses)",
    "ok"
  );
  const media = read("src/content/media.js").replace(/\r/g, "");
  report(
    /FALLBACK[\s\S]*?attachMedia\(mediaDataUrl/.test(media),
    "uploadMedia punya fallback attachMedia (dataURL rusak tetap terlampir)",
    "ok"
  );
  const schedSrc = read("src/background/scheduler.js");
  report(
    /EXECUTE_POST,[\s\S]*?150000/.test(schedSrc.replace(/\r/g, "")),
    "Timeout EXECUTE_POST dinaikkan ke 150s (upload+GATE+caption+submit)",
    /150000/.test(schedSrc) ? "ok" : "masih 90s"
  );
}

/* ---------- 10. WIRING WORKFLOW SCAN (pola fb-grupV3) ----------
   Dashboard hanya pemicu START_SCAN; background orkestrasi tab
   sementara + guard; content scanGroups() loop sidebar. */
function checkScanWiring() {
  const sw = read("src/background/service-worker.js").replace(/\r/g, "");
  const scan = read("src/background/scan.js").replace(/\r/g, "");
  const groups = read("src/dashboard/groups.js").replace(/\r/g, "");
  const content = read("src/content/content.js").replace(/\r/g, "");
  const scraper = read("src/content/scraper.js").replace(/\r/g, "");

  report(
    /MSG\.START_SCAN[\s\S]*?isScanActive\(\)[\s\S]*?runScan\(\)/.test(sw),
    "Router background: START_SCAN -> guard isScanActive -> runScan fire-and-forget",
    "ok"
  );
  report(
    /tabs\.create[\s\S]*?waitTabLoaded[\s\S]*?requestScan[\s\S]*?mergeGroups[\s\S]*?tabs\.remove/.test(scan),
    "scan.js: tabs.create -> waitTabLoaded -> requestScan -> mergeGroups -> tabs.remove",
    "ok"
  );
  report(
    /isScanActive[\s\S]*?SCANNING|scanning/.test(scan),
    "scan.js: guard status loading/scanning (anti dobel scan)",
    "ok"
  );
  report(
    /MSG\.START_SCAN/.test(groups) && !/querySelectorAll|humanScroll/.test(groups),
    "Dashboard hanya mengirim START_SCAN (tanpa scraping di dashboard)",
    "ok"
  );
  report(
    /MSG\.SCAN_GROUPS[\s\S]*?scanGroups\(\)/.test(content),
    "Router content script menangani SCAN_GROUPS dengan scanGroups()",
    "ok"
  );
  report(
    /function scanGroups[\s\S]*?findSidebar\(\)[\s\S]*?SCAN_MAX_PASSES[\s\S]*?collectGroups/.test(scraper),
    "scanGroups(): findSidebar + collectGroups + loop dibatasi SCAN_MAX_PASSES",
    "ok"
  );
  report(
    /function requestScan[\s\S]*?ensureContentScript/.test(scan),
    "requestScan() punya fallback inject content script bila belum siap",
    "ok"
  );
}

/* ---------- 11. RUNNER ---------- */
(async () => {
  console.log("== FB Auto Poster - verifikasi struktur ==\n");
  const files = checkSyntax();
  checkDeadCode(files);
  checkDashboardIds();
  checkManifestSync();
  checkDashboardScriptOrder();
  checkMsgConstants();
  checkPostingUsesComposerChain();
  checkTestPostWiring();
  checkScanWiring();
  checkParity();
  checkLoadBackground();
  checkLoadContent();
  checkLoadDashboard();
  await checkStatusRecovery();
  await checkHomeToComposerChain();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n== Ringkasan: ${results.length - failed.length}/${results.length} check lulus ==`);
  process.exit(failed.length ? 1 : 0);
})();

