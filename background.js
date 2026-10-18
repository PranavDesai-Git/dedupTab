// Normalize URLs for consistent tab comparison
const TRACKING_PARAMS = new Set([
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "ref",
    "fbclid",
    "gclid"
]);

function normalizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return "";
    try {
        const parsed = new URL(rawUrl);
        parsed.hash = ""; // Ignore anchor jumps

        // Strip trailing slash on subpaths
        if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
            parsed.pathname = parsed.pathname.slice(0, -1);
        }

        // Clean tracking parameters
        for (const param of Array.from(parsed.searchParams.keys())) {
            if (TRACKING_PARAMS.has(param.toLowerCase())) {
                parsed.searchParams.delete(param);
            }
        }

        return parsed.toString();
    } catch {
        return rawUrl;
    }
}

// In-memory state for bypass tokens and tab origin tracking
const bypassUrls = new Set();
const tabOrigins = new Map();
let currentActiveTabId = null;
let previousActiveTabId = null;

// Initialize active tab on service worker startup
chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    if (tabs && tabs[0]) currentActiveTabId = tabs[0].id;
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
    if (currentActiveTabId && currentActiveTabId !== tabId) {
        previousActiveTabId = currentActiveTabId;
    }
    currentActiveTabId = tabId;
});

function recordRedirectSource(targetTabId, sourceTabId) {
    if (typeof targetTabId === "number" && typeof sourceTabId === "number") {
        tabOrigins.set(targetTabId, sourceTabId);
    }
}


async function jumpBackToSource() {
    let currentTabId = currentActiveTabId;
    if (!currentTabId) {
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (activeTab) currentTabId = activeTab.id;
    }
    if (!currentTabId) return;

    const targetTabId = tabOrigins.get(currentTabId) || previousActiveTabId;
    if (!targetTabId || targetTabId === currentTabId) return;

    try {
        const targetTab = await chrome.tabs.get(targetTabId);
        if (targetTab) {
            // Enable bidirectional toggle back and forth
            tabOrigins.set(targetTabId, currentTabId);

            await chrome.tabs.update(targetTabId, { active: true });
            await chrome.windows.update(targetTab.windowId, { focused: true });
        }
    } catch {
        tabOrigins.delete(currentTabId);
    }
}

// Handle bypass tokens, manual jump back triggers, and link deduplication requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return;

    if (message.type === "BYPASS_DEDUP" && message.url) {
        const normalized = normalizeUrl(message.url);
        bypassUrls.add(normalized);
        setTimeout(() => bypassUrls.delete(normalized), 4000);
        return;
    }

    if (message.type === "TRIGGER_JUMP_BACK") {
        jumpBackToSource();
        return;
    }

    if (message.type === "CHECK_AND_SWITCH_TAB" && message.url) {
        const targetNormalized = normalizeUrl(message.url);
        const sourceTabId = sender.tab ? sender.tab.id : null;

        chrome.tabs.query({}, async (tabs) => {
            const match = tabs.find((t) => {
                if (!t.url || (sourceTabId && t.id === sourceTabId)) return false;
                return normalizeUrl(t.url) === targetNormalized;
            });

            if (match) {
                recordRedirectSource(match.id, sourceTabId);

                await chrome.tabs.update(match.id, { active: true });
                await chrome.windows.update(match.windowId, { focused: true });

                chrome.tabs.sendMessage(match.id, {
                    type: "SHOW_REDIRECT_NOTICE",
                    canJumpBack: Boolean(sourceTabId)
                }).catch(() => {});

                // Increment saved duplicate tab counter
                chrome.storage.local.get({ savedCount: 0 }, (data) => {
                    chrome.storage.local.set({ savedCount: data.savedCount + 1 });
                });

                sendResponse({ found: true });
            } else {
                sendResponse({ found: false });
            }
        });

        return true; // Keep message channel open for async sendResponse
    }
});

// Handle Alt+Z command shortcut
chrome.commands.onCommand.addListener((command) => {
    if (command === "jump_back") {
        jumpBackToSource();
    }
});

// Track newly created tabs to only close freshly spawned duplicates (e.g. from middle-click or external apps)
const pendingNewTabs = new Map();

chrome.tabs.onCreated.addListener((tab) => {
    pendingNewTabs.set(tab.id, Date.now());
    setTimeout(() => pendingNewTabs.delete(tab.id), 10000);

    const originTabId = tab.openerTabId || currentActiveTabId;
    if (originTabId && originTabId !== tab.id) {
        tabOrigins.set(tab.id, originTabId);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    pendingNewTabs.delete(tabId);
    tabOrigins.delete(tabId);
    if (currentActiveTabId === tabId) currentActiveTabId = null;
    if (previousActiveTabId === tabId) previousActiveTabId = null;
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    const url = changeInfo.url || (pendingNewTabs.has(tabId) && tab.url);
    if (!url || !pendingNewTabs.has(tabId)) return;
    if (!url.startsWith("http://") && !url.startsWith("https://")) return;

    const normalized = normalizeUrl(url);

    // If marked as bypass (e.g. via Alt+Middle-click), allow duplicate
    if (bypassUrls.has(normalized)) {
        bypassUrls.delete(normalized);
        pendingNewTabs.delete(tabId);
        return;
    }

    const allTabs = await chrome.tabs.query({});
    const match = allTabs.find((t) => t.id !== tabId && t.url && normalizeUrl(t.url) === normalized);

    if (match) {
        pendingNewTabs.delete(tabId);

        const sourceTabId = tab.openerTabId || null;
        recordRedirectSource(match.id, sourceTabId);

        try {
            await chrome.tabs.remove(tabId);
        } catch {
            // Tab may have already been closed
        }

        await chrome.tabs.update(match.id, { active: true });
        await chrome.windows.update(match.windowId, { focused: true });

        chrome.tabs.sendMessage(match.id, {
            type: "SHOW_REDIRECT_NOTICE",
            canJumpBack: Boolean(sourceTabId)
        }).catch(() => {});

        chrome.storage.local.get({ savedCount: 0 }, (data) => {
            chrome.storage.local.set({ savedCount: data.savedCount + 1 });
        });
    }
});



