// Works as a Firefox event page and as a Chrome MV3 service worker.
globalThis.browser ??= globalThis.chrome;

// ===================== PER-SITE PERMISSIONS =====================
// Host access is requested per target site when the user adds it, instead
// of demanding <all_urls> up front. The content script is registered
// dynamically for exactly the origins that are both targeted and granted.

function originsForPattern(pattern) {
  if (pattern.startsWith("*.")) return ["*://" + pattern + "/*"];
  if (pattern.startsWith("www.")) return ["*://" + pattern + "/*", "*://" + pattern.slice(4) + "/*"];
  return ["*://" + pattern + "/*", "*://www." + pattern + "/*"];
}

async function syncRegisteredScripts() {
  const { websites = [] } = await browser.storage.local.get("websites");

  const matches = [];
  for (const pattern of websites) {
    const origins = originsForPattern(pattern);
    try {
      if (await browser.permissions.contains({ origins })) matches.push(...origins);
    } catch {
      // invalid pattern — skip
    }
  }

  const existing = await browser.scripting.getRegisteredContentScripts({ ids: ["addad"] });

  if (matches.length === 0) {
    if (existing.length > 0) await browser.scripting.unregisterContentScripts({ ids: ["addad"] });
    return;
  }

  const script = {
    id: "addad",
    matches,
    js: ["content.js"],
    css: ["content.css"],
    runAt: "document_idle",
    persistAcrossSessions: true,
  };

  if (existing.length > 0) {
    await browser.scripting.updateContentScripts([script]);
  } else {
    await browser.scripting.registerContentScripts([script]);
  }
}

function domainMatches(hostname, pattern) {
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return hostname === base || hostname.endsWith("." + base);
  }
  return hostname === pattern || hostname === "www." + pattern || "www." + hostname === pattern;
}

// Re-sync whenever grants change (covers the popup closing mid-flow on grant
// prompts) and on startup/update as a safety net.
browser.permissions.onAdded.addListener(async () => {
  await syncRegisteredScripts();

  // If the active tab is a targeted site that just became usable, reload it
  // so the ads start immediately — this finishes the popup's Destroy flow
  // even when Firefox closes the popup to show the permission doorhanger.
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https?:/.test(tab.url || "")) return;
    const host = new URL(tab.url).hostname;
    const { websites = [] } = await browser.storage.local.get("websites");
    if (!websites.some((p) => domainMatches(host, p))) return;
    if (await browser.permissions.contains({ origins: ["*://" + host + "/*"] })) {
      browser.tabs.reload(tab.id);
    }
  } catch { /* best effort */ }
});
browser.permissions.onRemoved.addListener(() => { syncRegisteredScripts(); });
browser.runtime.onStartup.addListener(() => { syncRegisteredScripts(); });

// Adds a target site to storage on behalf of the popup, so the write
// survives the popup being torn down by the permission prompt.
async function addSite(hostname) {
  const { websites = [] } = await browser.storage.local.get("websites");
  if (websites.includes(hostname)) return;
  websites.push(hostname);
  await browser.storage.local.set({ websites });
  await syncRegisteredScripts();
}

browser.runtime.onInstalled.addListener(() => {
  syncRegisteredScripts();

  browser.storage.local.get(["websites", "whitelist", "intensity", "reloadMinutes", "redirectURL", "pingPongCount"]).then((data) => {
    const defaults = {};
    if (!data.websites) defaults.websites = [];
    if (!data.whitelist) defaults.whitelist = [];
    if (!data.intensity) defaults.intensity = 40;
    if (!data.reloadMinutes) defaults.reloadMinutes = 5;
    if (!data.redirectURL) defaults.redirectURL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    if (!data.pingPongCount) defaults.pingPongCount = 1;
    if (Object.keys(defaults).length > 0) {
      browser.storage.local.set(defaults);
    }
  });
});

// ===================== RECENT SITE TRACKING =====================
// Content scripts on targeted sites ping while the page is open, so the
// options page knows which sites are open now or were open moments ago
// (used by the dodging Remove button).
const RECENT_PRUNE_MS = 10 * 60 * 1000;

async function recordSiteSeen(hostname) {
  const data = await browser.storage.local.get("recentSites");
  const recentSites = data.recentSites || {};
  const now = Date.now();
  recentSites[hostname] = now;
  for (const host of Object.keys(recentSites)) {
    if (now - recentSites[host] > RECENT_PRUNE_MS) delete recentSites[host];
  }
  browser.storage.local.set({ recentSites });
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "siteSeen") {
    recordSiteSeen(msg.hostname);
    return;
  }
  if (msg.type === "addSite") {
    addSite(msg.hostname).finally(() => sendResponse(true));
    return true; // async response
  }
  if (msg.type === "syncScripts") {
    syncRegisteredScripts().finally(() => sendResponse(true));
    return true; // async response
  }
});
