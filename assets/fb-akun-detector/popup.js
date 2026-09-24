document.getElementById("startBtn").addEventListener("click", () => {
  const resultDiv = document.getElementById("result");
  resultDiv.innerText = "Membuka Facebook...";

  chrome.runtime.sendMessage({ action: "start_check" }, () => {
    if (chrome.runtime.lastError) {
      resultDiv.innerText = "Error: " + chrome.runtime.lastError.message;
      return;
    }
    resultDiv.innerText = "Mengecek tab Facebook...";
  });
});

// Saat popup dibuka, tampilkan hasil sebelumnya kalau ada
// (berguna kalau popup pernah tertutup sebelum hasil datang)
chrome.storage.local.get("lastAccount", (data) => {
  if (data && data.lastAccount) {
    document.getElementById("result").innerText = "Akun FB: " + data.lastAccount;
  }
});

// Dengarkan pesan hasil dari background script
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "account_found") {
    document.getElementById("result").innerText = "Akun FB: " + message.accountName;
  } else if (message.action === "account_error") {
    document.getElementById("result").innerText = message.error;
  }
});

// Backup: kalau runtime message sempat terlewat, storage change tetap diterima
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.lastAccount && changes.lastAccount.newValue) {
    document.getElementById("result").innerText = "Akun FB: " + changes.lastAccount.newValue;
  }
});
