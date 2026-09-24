/* =========================================================
   FB Auto Poster - Content: Deteksi Akun FB yang Sedang Login
   Modul ini HANYA membaca DOM halaman Facebook untuk menemukan
   NAMA akun yang sedang login. Pemanggilnya = background
   (`src/background/account.js`) yang membuka TAB DETEKSI
   SEMENTARA lalu menutupnya kembali.

   Algoritma diadaptasi dari ekstensi sederhana "FB Account
   Detector" (assets/fb-akun-detector) dengan urutan prioritas:
     1) anchor "Linimasa <Nama>" / "Timeline <Nama>" (paling spesifik —
        nama akun selalu menempel di aria-label link linimasa sendiri)
     2) link yang mengarah KE PROFIL SENDIRI (URL pembanding diambil dari
        link linimasa / tombol "Profil Anda"; mencegah tertukar dengan
        profil orang lain yang muncul di feed)
     3) img[alt="Foto profil (dari) <Nama>"]
     4) [role="button"|"link"][aria-label] — paling lemah, wajib lolos
        filter generik

   Setiap kandidat dibersihkan dulu: prefix "Linimasa/Timeline/Foto
   profil" dipotong, label generik menu FB ditolak, dan kalimat panjang
   (> 60 karakter, biasanya teks notifikasi) ditolak.

   Modul ini TIDAK menyentuh `chrome.*` sehingga tetap bisa diuji di
   luar ekstensi (tools/verify.js memuatnya dengan DOM tiruan).
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const content = (FBAP.content = FBAP.content || {});
  const { LIMITS } = FBAP.config;
  const { sleep } = FBAP.time;

  /* ---------------- SELEKTOR (atribut aksesibilitas, bukan class) ---------------- */
  const TIMELINE_LINK_SELECTOR = 'a[aria-label^="Linimasa "], a[aria-label^="Timeline "]';
  const OWN_PROFILE_BUTTON_SELECTOR = '[aria-label="Profil Anda"], [aria-label="Your profile"]';
  const AVATAR_IMG_SELECTOR =
    'img[alt^="Foto profil"], img[alt^="foto profil"], img[alt^="Profile picture"], img[alt^="profile picture"]';
  const LABELED_CONTROL_SELECTOR = '[role="button"][aria-label], [role="link"][aria-label]';
  const OWN_PROFILE_LINK_SELECTOR = 'a[href*="profile.php?id="]';

  /* Prefix nama pada label: "Linimasa Dapur Family" -> "Dapur Family". */
  const NAME_PREFIX_RE = /^(linimasa|timeline|foto profil dari|foto profil|profile picture of|profile picture)\s*:?\s*/i;

  /* Label UI Facebook yang BUKAN nama akun (case-insensitive, ID + EN). */
  const GENERIC_LABELS = [
    "profil anda", "your profile", "profile", "profil",
    "linimasa", "timeline", "buat postingan", "create a post",
    "menu facebook", "facebook menu", "kontrol dan pengaturan akun",
    "account center", "accounts centre", "pusat akun",
    "cari di facebook", "search facebook", "beranda", "home",
    "reels", "halaman", "pages", "messenger", "notifikasi", "notifications",
    "keluar typeahead", "kembali ke halaman sebelumnya", "go back",
    "pintasan", "shortcuts", "lihat pintasan lainnya", "see more shortcuts",
    "tautan footer lainnya", "see more footer links",
    "video siaran langsung", "live videos", "foto/video", "photo/video",
    "cerita", "stories", "baki cerita", "story tray", "buat cerita", "create story"
  ];

  /** Panjang maksimum teks yang masih wajar sebagai nama akun. */
  const MAX_NAME_LENGTH = 60;

  /** Potong prefix label ("Linimasa Dapur Family" -> "Dapur Family"). */
  function stripNamePrefix(text) {
    return String(text || "").replace(NAME_PREFIX_RE, "").trim();
  }

  /** Label generik / terlalu panjang = bukan nama akun. */
  function isGenericLabel(text) {
    const t = stripNamePrefix(text).toLowerCase();
    if (!t) return true;
    if (GENERIC_LABELS.includes(t)) return true;
    /* Nama akun tidak mungkin selebar 60+ karakter (kalimat notifikasi). */
    if (t.length > MAX_NAME_LENGTH) return true;
    return false;
  }

  /** Gabungan strip + filter: kembalikan nama siap pakai atau null. */
  function usableName(text) {
    const name = stripNamePrefix(text);
    if (!name || isGenericLabel(name)) return null;
    return name;
  }

  /** URL profil SENDIRI (normalisasi tanpa query) — dipakai sebagai
      pembanding agar link profil orang lain dari feed tidak terpakai.
      Sumber: link linimasa sendiri, fallback tombol "Profil Anda". */
  function findOwnProfileUrl() {
    const timeline = document.querySelector(TIMELINE_LINK_SELECTOR);
    if (timeline && timeline.href) return String(timeline.href).split("?")[0];
    const btn = document.querySelector(OWN_PROFILE_BUTTON_SELECTOR);
    const anchor = btn ? (btn.tagName === "A" ? btn : btn.querySelector("a[href]")) : null;
    if (anchor && anchor.href) return String(anchor.href).split("?")[0];
    return null;
  }

  /** Satu pass pembacaan DOM (sinkron). Urutan prioritas: timeline ->
      link profil sendiri -> avatar -> kontrol berlabel. Null bila tidak
      ada kandidat yang lolos filter generik. */
  function pickAccountName() {
    /* Prioritas 1: aria-label link linimasa diri sendiri. */
    const timeline = document.querySelector(TIMELINE_LINK_SELECTOR);
    if (timeline) {
      const fromTimeline = usableName(timeline.getAttribute("aria-label"));
      if (fromTimeline) return fromTimeline;
    }

    /* Prioritas 2: hanya link yang URL-nya = profil sendiri. */
    const ownUrl = findOwnProfileUrl();
    if (ownUrl) {
      for (const link of document.querySelectorAll(OWN_PROFILE_LINK_SELECTOR)) {
        if (String(link.href || "").split("?")[0] !== ownUrl) continue;
        const fromAria = usableName(link.getAttribute("aria-label"));
        if (fromAria) return fromAria;
        const fromText = usableName(link.innerText);
        if (fromText) return fromText;
      }
    }

    /* Prioritas 3: gambar avatar dengan alt "Foto profil (dari) <nama>". */
    for (const img of document.querySelectorAll(AVATAR_IMG_SELECTOR)) {
      const fromAlt = usableName(img.getAttribute("alt"));
      if (fromAlt) return fromAlt;
    }

    /* Prioritas 4 (paling lemah): kontrol berlabel yang lolos filter. */
    for (const el of document.querySelectorAll(LABELED_CONTROL_SELECTOR)) {
      const fromLabel = usableName(el.getAttribute("aria-label"));
      if (fromLabel) return fromLabel;
    }

    return null;
  }

  /** Polling DOM sampai nama ditemukan atau jatah percobaan habis
      (LIMITS.ACCOUNT_DETECT_TRIES x LIMITS.ACCOUNT_DETECT_INTERVAL_MS).
      Polling dilakukan DI SINI (bukan di background) karena service worker
      MV3 tidak boleh menahan timer panjang — pola yang sama dengan
      ekstensi rujukan "FB Account Detector". */
  async function getAccountName() {
    for (let tries = 0; tries < LIMITS.ACCOUNT_DETECT_TRIES; tries++) {
      const found = pickAccountName();
      if (found) return found;
      await sleep(LIMITS.ACCOUNT_DETECT_INTERVAL_MS);
    }
    return null;
  }

  content.account = { getAccountName, pickAccountName };
})(globalThis);
