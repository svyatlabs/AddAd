// Firefox has `browser`, Chrome only has `chrome` (promise-based in MV3)
globalThis.browser ??= globalThis.chrome;

browser.storage.local.get("theme").then(({ theme }) => {
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
  }
});

const statusEl = document.getElementById("popup-status");

document.getElementById("settings-btn").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

// Everything the Destroy button needs is computed at popup-open time.
// Firefox only shows a permission prompt when permissions.request() is
// called synchronously inside the click handler — a single await before
// it and the gesture is considered spent, the prompt is silently refused.
let currentTab = null;
let currentHost = null;
let alreadyDoomed = false;
let hasPermission = false;

(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  const url = tab && tab.url ? tab.url : "";
  if (!/^https?:/.test(url)) return;

  currentHost = new URL(url).hostname.replace(/^www\./, "");
  const { websites = [] } = await browser.storage.local.get("websites");
  alreadyDoomed = websites.includes(currentHost);
  try {
    hasPermission = await browser.permissions.contains({
      origins: ["*://" + currentHost + "/*", "*://www." + currentHost + "/*"],
    });
  } catch { /* leave false */ }
})();

document.getElementById("destroy-btn").addEventListener("click", () => {
  if (!currentHost) {
    statusEl.textContent = "Nothing to destroy here.";
    return;
  }
  if (alreadyDoomed) {
    statusEl.textContent = currentHost + " is already doomed.";
    return;
  }
  alreadyDoomed = true;

  // Save via the background so it survives the popup being closed by the
  // permission doorhanger.
  browser.runtime.sendMessage({ type: "addSite", hostname: currentHost }).catch(() => {});

  if (hasPermission) {
    // Nothing to prompt for — register, reload, done.
    browser.runtime.sendMessage({ type: "syncScripts" }).catch(() => {}).then(() => {
      if (currentTab) browser.tabs.reload(currentTab.id);
      window.close();
    });
    return;
  }

  // Prompt first, synchronously, while the click gesture is fresh. After a
  // grant the background's permissions.onAdded listener registers the
  // content script and reloads this tab — that path also covers Firefox
  // closing the popup when the doorhanger opens.
  browser.permissions.request({
    origins: ["*://" + currentHost + "/*", "*://www." + currentHost + "/*"],
  }).catch(() => false).then(() => {
    window.close();
  });
});
