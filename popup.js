// Load saved duplicate tab count
chrome.storage.local.get({ savedCount: 0 }, (data) => {
  const countEl = document.getElementById("saved-count");
  if (countEl) {
    countEl.textContent = data.savedCount.toLocaleString();
  }
});

// Shortcut configuration link
document.getElementById("config-shortcuts")?.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});
