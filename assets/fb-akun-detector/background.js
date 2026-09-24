chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "start_check") {
    // 1. Buka new tab ke Facebook
    // active:false -> tab dibuka di belakang, popup tidak ikut tertutup
    chrome.tabs.create({ url: "https://www.facebook.com/", active: false }, (tab) => {
      // 2. Tentukan handler listener untuk mengecek status loading tab
      function tabUpdateListener(tabId, changeInfo) {
        if (tabId === tab.id && changeInfo.status === "complete") {
          // Lepas listener agar tidak berjalan berulang kali
          chrome.tabs.onUpdated.removeListener(tabUpdateListener);

          // Jangan pakai setTimeout di service worker (bisa di-suspend MV3).
          // Retry/polling dilakukan di dalam func yang di-inject.
          chrome.scripting.executeScript(
              {
                target: { tabId: tab.id },
                func: getFBAccountName,
              },
              (results) => {
                if (chrome.runtime.lastError) {
                  notifyPopup({
                    action: "account_error",
                    error: "Gagal inject script: " + chrome.runtime.lastError.message,
                  });
                  return;
                }
                const value = results && results[0] && results[0].result;
                if (value) {
                  // Simpan cadangan agar popup bisa baca ulang saat dibuka lagi
                  chrome.storage.local.set({ lastAccount: value });
                  notifyPopup({ action: "account_found", accountName: value });
                } else {
                  notifyPopup({
                    action: "account_error",
                    error: "Nama akun tidak ditemukan atau belum login.",
                  });
                }
              },
            );
        }
      }

      chrome.tabs.onUpdated.addListener(tabUpdateListener);
    });

    sendResponse({ status: "started" });
  }
});

// Kirim hasil ke popup dengan aman. Kalau popup sudah tertutup,
// jangan biarkan error "Receiving end does not exist" jadi uncaught.
function notifyPopup(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError; // sengaja dibaca agar tidak muncul uncaught error
    });
  } catch (e) {
    // Popup extension context invalid -> abaikan, hasil sudah disimpan di storage
  }
}

// Fungsi ini dieksekusi langsung di dalam konteks DOM Facebook.
// Melakukan polling sendiri karena service worker MV3 tidak boleh setTimeout lama.
function getFBAccountName() {
  const MAX_TRIES = 20; // 20 x 500ms = 10 detik maksimum menunggu DOM siap
  const INTERVAL = 500;

  // Label generik yang BUKAN nama akun -> diabaikan (case-insensitive)
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
    "cerita", "stories", "baki cerita", "story tray", "buat cerita", "create story",
  ];

  function isGeneric(text) {
    if (!text) return true;
    const t = text.trim().toLowerCase();
    if (t === "") return true;
    if (GENERIC_LABELS.includes(t)) return true;
    // Nama akun tidak mungkin selebar 60+ karakter (buang kalimat notifikasi panjang)
    if (t.length > 60) return true;
    return false;
  }

  // Buang prefix umum: "Linimasa Dapur Family" -> "Dapur Family"
  function stripPrefix(text) {
    return (text || "")
      .replace(/^(linimasa|timeline|foto profil dari|foto profil|profile picture of|profile picture)\s*:?\s*/i, "")
      .trim();
  }

  function tryPickName() {
    // Identifikasi URL profil diri: dari link "Linimasa/Timeline <Nama>",
    // fallback: anchor di dalam/di sekitar tombol "Profil Anda"
    function findOwnUrl() {
      const timeline = document.querySelector(
        'a[aria-label^="Linimasa "], a[aria-label^="Timeline "]',
      );
      if (timeline && timeline.href) return timeline.href.split("?")[0];
      const btn = document.querySelector('[aria-label="Profil Anda"], [aria-label="Your profile"]');
      const anchor = btn ? (btn.tagName === "A" ? btn : btn.querySelector("a[href]")) : null;
      if (anchor && anchor.href) return anchor.href.split("?")[0];
      return null;
    }
    const ownUrl = findOwnUrl();

    // Prioritas 1: aria-label link timeline diri -> "Linimasa Dapur Family" => "Dapur Family"
    const timelineLink = document.querySelector(
      'a[aria-label^="Linimasa "], a[aria-label^="Timeline "]',
    );
    if (timelineLink) {
      const label = stripPrefix(timelineLink.getAttribute("aria-label"));
      if (label && !isGeneric(label)) return label;
    }

    // Prioritas 2: link yang mengarah KE PROFIL DIRI SENDIRI saja,
    // jangan sampai tertukar dengan profil orang lain dari feed
    if (ownUrl) {
      const links = document.querySelectorAll('a[href*="profile.php?id="]');
      for (const link of links) {
        if ((link.href || "").split("?")[0] !== ownUrl) continue;
        const label = stripPrefix(link.getAttribute("aria-label") || "");
        if (label && !isGeneric(label)) return label;
        const text = (link.innerText || "").trim();
        if (text && !isGeneric(text)) return text;
      }
    }

    // Prioritas 3: avatar image dengan alt "Foto profil (dari) <nama>"
    const avatarImgs = document.querySelectorAll(
      'img[alt^="Foto profil"], img[alt^="foto profil"], img[alt^="Profile picture"], img[alt^="profile picture"]',
    );
    for (const img of avatarImgs) {
      const alt = stripPrefix(img.getAttribute("alt"));
      if (alt && !isGeneric(alt)) return alt;
    }

    // Prioritas 4 (terakhir): aria-label elemen interaktif, harus lolos filter generik
    const candidates = document.querySelectorAll('[role="button"][aria-label], [role="link"][aria-label]');
    for (const el of candidates) {
      const label = stripPrefix(el.getAttribute("aria-label"));
      if (label && !isGeneric(label)) return label;
    }

    return null;
  }

  return new Promise((resolve) => {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const found = tryPickName();
      if (found || tries >= MAX_TRIES) {
        clearInterval(timer);
        resolve(found);
      }
    }, INTERVAL);
  });
}
