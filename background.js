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

// In-memory state for bypass tokens and jump-back history
const bypassUrls = new Set();
let lastRedirectSourceTabId = null;

function recordRedirectSource(sourceTabId) {
    if (typeof sourceTabId === "number") {
        lastRedirectSourceTabId = sourceTabId;
    }
}

async function jumpBackToSource() {
    if (lastRedirectSourceTabId === null) return;
    try {
        const tab = await chrome.tabs.get(lastRedirectSourceTabId);
        if (tab) {
            await chrome.tabs.update(lastRedirectSourceTabId, { active: true });
            await chrome.windows.update(tab.windowId, { focused: true });
        }
    } catch {
        lastRedirectSourceTabId = null;
    }
}

// Handle bypass tokens and manual jump back triggers
chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message) return;
    if (message.type === "BYPASS_DEDUP" && message.url) {
        const normalized = normalizeUrl(message.url);
        bypassUrls.add(normalized);
        setTimeout(() => bypassUrls.delete(normalized), 4000);
    } else if (message.type === "TRIGGER_JUMP_BACK") {
        jumpBackToSource();
    }
});

// Handle Alt+Z command shortcut
chrome.commands.onCommand.addListener((command) => {
    if (command === "jump_back") {
        jumpBackToSource();
    }
});


