/**
 * background.js — Service Worker for Badge Updates
 *
 * Chrome's "always-on" background script for Tab Out.
 * Its only job: keep the toolbar badge showing the current open tab count.
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts real web tabs (skipping chrome:// and extension pages).
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#3d7a4a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener(() => {
  updateBadge();
  broadcastRefresh();
});

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener(() => {
  updateBadge();
  broadcastRefresh();
});

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener(() => {
  updateBadge();
  broadcastRefresh();
});

/**
 * broadcastRefresh()
 *
 * Notify all open Tab Out new-tab pages to refresh their data.
 */
async function broadcastRefresh() {
  try {
    const extensionId = chrome.runtime.id;
    const url = `chrome-extension://${extensionId}/index.html`;
    const tabs = await chrome.tabs.query({ url });
    for (const tab of tabs) {
      try {
        chrome.tabs.sendMessage(tab.id, { action: 'refreshTabs' });
      } catch { /* tab may not have listener yet */ }
    }
  } catch { /* ignore */ }
}

// ─── Message handler: provide top sites from history to the newtab page ───────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getTopSites') {
    getTopSitesFromHistory().then(sendResponse).catch(() => sendResponse([]));
    return true; // keep message channel open for async response
  }
});

async function getTopSitesFromHistory() {
  try {
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const historyItems = await chrome.history.search({
      text: '',
      maxResults: 50,
      startTime: oneWeekAgo,
    });

    const domainMap = {};
    for (const item of historyItems) {
      try {
        const urlObj = new URL(item.url);
        const domain = urlObj.hostname.replace(/^www\./, '');
        if (!domain || domain === 'localhost' || urlObj.protocol === 'chrome-extension:') continue;

        if (!domainMap[domain]) {
          domainMap[domain] = {
            url: item.url,
            title: item.title || domain,
            visitCount: 0,
          };
        }
        domainMap[domain].visitCount += item.visitCount || 1;
        if (!domainMap[domain].lastVisitTime || item.lastVisitTime > domainMap[domain].lastVisitTime) {
          domainMap[domain].url = item.url;
          if (item.title) domainMap[domain].title = item.title;
          domainMap[domain].lastVisitTime = item.lastVisitTime;
        }
      } catch { /* skip malformed */ }
    }

    const sorted = Object.values(domainMap)
      .sort((a, b) => b.visitCount - a.visitCount)
      .slice(0, 8);

    return sorted.map((item, i) => ({
      id: `auto-${Date.now()}-${i}`,
      url: item.url,
      title: item.title,
      order: i,
    }));
  } catch {
    return [];
  }
}

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();
