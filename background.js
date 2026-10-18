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

// In-memory state for bypass tokens, tab navigation history, and child tab stacks
const bypassUrls = new Set();
const backStack = [];
const forwardStack = [];
const tabChildren = new Map(); // parentTabId -> Array<childTabId>
const deadChildren = []; // Array of { url, title, parentId, index, windowId }
const tabMetadata = new Map(); // tabId -> { url, title, windowId, index }
let currentActiveTabId = null;
let isNavigatingHistory = false;

function saveTabMetadata(tab) {
    if (!tab || !tab.id) return;
    tabMetadata.set(tab.id, {
        url: tab.url || tab.pendingUrl || "",
        title: tab.title || "",
        windowId: tab.windowId,
        index: tab.index
    });
}

function addChildTab(parentId, childId) {
    if (!parentId || !childId || parentId === childId) return;
    let list = tabChildren.get(parentId);
    if (!list) {
        list = [];
        tabChildren.set(parentId, list);
    }
    const idx = list.indexOf(childId);
    if (idx !== -1) {
        list.splice(idx, 1);
    }
    list.push(childId);
}

function removeChildTab(childId) {
    for (const [parentId, list] of tabChildren.entries()) {
        const idx = list.indexOf(childId);
        if (idx !== -1) {
            list.splice(idx, 1);
            if (list.length === 0) tabChildren.delete(parentId);
        }
    }
    tabChildren.delete(childId);
}

function getParentTabId(childId) {
    for (const [parentId, list] of tabChildren.entries()) {
        if (list.includes(childId)) return parentId;
    }
    return null;
}

// Initialize active tab and tab metadata cache on service worker startup
chrome.tabs.query({}, (tabs) => {
    if (Array.isArray(tabs)) {
        for (const tab of tabs) {
            saveTabMetadata(tab);
            if (tab.active) currentActiveTabId = tab.id;
        }
    }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
    if (isNavigatingHistory) {
        isNavigatingHistory = false;
        currentActiveTabId = tabId;
        return;
    }

    if (currentActiveTabId && currentActiveTabId !== tabId) {
        if (backStack.length === 0 || backStack[backStack.length - 1] !== currentActiveTabId) {
            backStack.push(currentActiveTabId);
            if (backStack.length > 50) backStack.shift();
        }
        forwardStack.length = 0; // New navigation resets forward history
    }
    currentActiveTabId = tabId;
});

async function jumpBack() {
    let currentTabId = currentActiveTabId;
    if (!currentTabId) {
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (activeTab) currentTabId = activeTab.id;
    }

    while (backStack.length > 0) {
        const targetTabId = backStack.pop();
        if (targetTabId === currentTabId) continue;

        try {
            const targetTab = await chrome.tabs.get(targetTabId);
            if (targetTab) {
                if (currentTabId) {
                    forwardStack.push(currentTabId);
                    if (forwardStack.length > 50) forwardStack.shift();
                }
                isNavigatingHistory = true;
                await chrome.tabs.update(targetTabId, { active: true });
                await chrome.windows.update(targetTab.windowId, { focused: true });
                return;
            }
        } catch {
            // Tab was closed, continue searching stack
        }
    }
}

async function jumpForward() {
    let currentTabId = currentActiveTabId;
    if (!currentTabId) {
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (activeTab) currentTabId = activeTab.id;
    }

    while (forwardStack.length > 0) {
        const targetTabId = forwardStack.pop();
        if (targetTabId === currentTabId) continue;

        try {
            const targetTab = await chrome.tabs.get(targetTabId);
            if (targetTab) {
                if (currentTabId) {
                    backStack.push(currentTabId);
                    if (backStack.length > 50) backStack.shift();
                }
                isNavigatingHistory = true;
                await chrome.tabs.update(targetTabId, { active: true });
                await chrome.windows.update(targetTab.windowId, { focused: true });
                return;
            }
        } catch {
            // Tab was closed, continue searching stack
        }
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
        jumpBack();
        return;
    }

    if (message.type === "EXEC_COMMAND" && message.command) {
        if (message.command === "safe_kill") {
            safeKillChildTab();
        } else if (message.command === "revive_child") {
            reviveDeadChild();
        }
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

async function jumpToChildTab(position) {
    let currentTabId = currentActiveTabId;
    if (!currentTabId) {
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (activeTab) currentTabId = activeTab.id;
    }
    if (!currentTabId) return;

    const list = tabChildren.get(currentTabId);
    if (!list || list.length === 0) return;

    const candidateIds = position === "latest" ? [...list].reverse() : [...list];

    for (const childId of candidateIds) {
        try {
            const childTab = await chrome.tabs.get(childId);
            if (childTab) {
                await chrome.tabs.update(childId, { active: true });
                await chrome.windows.update(childTab.windowId, { focused: true });
                return;
            }
        } catch {
            removeChildTab(childId);
        }
    }
}

async function stepSiblingChild(direction) {
    let currentTabId = currentActiveTabId;
    if (!currentTabId) {
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (activeTab) currentTabId = activeTab.id;
    }
    if (!currentTabId) return;

    const parentId = getParentTabId(currentTabId);
    let list = null;

    if (!parentId) {
        list = tabChildren.get(currentTabId);
        if (list && list.length > 0 && direction === 1) {
            return jumpToChildTab("first");
        }
        return;
    }

    list = tabChildren.get(parentId) || [];
    const currentIndex = list.indexOf(currentTabId);
    if (currentIndex === -1) return;

    let targetIndex = currentIndex + direction;

    while (targetIndex >= 0 && targetIndex < list.length) {
        const candidateId = list[targetIndex];
        try {
            const tab = await chrome.tabs.get(candidateId);
            if (tab) {
                await chrome.tabs.update(candidateId, { active: true });
                await chrome.windows.update(tab.windowId, { focused: true });
                return;
            }
        } catch {
            removeChildTab(candidateId);
            list = tabChildren.get(parentId) || [];
        }
        targetIndex += direction;
    }

    if (direction === -1 && targetIndex < 0) {
        try {
            const parentTab = await chrome.tabs.get(parentId);
            if (parentTab) {
                await chrome.tabs.update(parentId, { active: true });
                await chrome.windows.update(parentTab.windowId, { focused: true });
                chrome.tabs.sendMessage(parentId, {
                    type: "SHOW_REDIRECT_NOTICE",
                    canJumpBack: false,
                    text: "Returned to parent tab"
                }).catch(() => {});
            }
        } catch {}
    } else if (direction === 1 && targetIndex >= list.length) {
        chrome.tabs.sendMessage(currentTabId, {
            type: "SHOW_REDIRECT_NOTICE",
            canJumpBack: false,
            text: "Last tab in detour"
        }).catch(() => {});
    }
}

async function safeKillChildTab() {
    let currentTabId = currentActiveTabId;
    if (!currentTabId) {
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (activeTab) currentTabId = activeTab.id;
    }
    if (!currentTabId) return;

    const parentId = getParentTabId(currentTabId);

    if (!parentId) {
        chrome.tabs.sendMessage(currentTabId, {
            type: "SHOW_REDIRECT_NOTICE",
            canJumpBack: false,
            text: "Protected: root tab (safe kill only closes child tabs)"
        }).catch(() => {});
        return;
    }

    let currentTab = null;
    try {
        currentTab = await chrome.tabs.get(currentTabId);
    } catch {
        return;
    }

    deadChildren.push({
        url: currentTab.url,
        title: currentTab.title,
        parentId,
        index: currentTab.index,
        windowId: currentTab.windowId
    });
    if (deadChildren.length > 30) deadChildren.shift();

    const siblings = tabChildren.get(parentId) || [];
    const childIdx = siblings.indexOf(currentTabId);
    let nextTargetId = null;

    if (childIdx !== -1) {
        if (childIdx + 1 < siblings.length) {
            nextTargetId = siblings[childIdx + 1];
        } else if (childIdx - 1 >= 0) {
            nextTargetId = siblings[childIdx - 1];
        } else {
            nextTargetId = parentId;
        }
    } else {
        nextTargetId = parentId;
    }

    try {
        const targetTab = await chrome.tabs.get(nextTargetId);
        if (targetTab) {
            await chrome.tabs.update(nextTargetId, { active: true });
            await chrome.windows.update(targetTab.windowId, { focused: true });
            if (nextTargetId === parentId) {
                chrome.tabs.sendMessage(parentId, {
                    type: "SHOW_REDIRECT_NOTICE",
                    canJumpBack: false,
                    text: "Detour finished: returned to parent"
                }).catch(() => {});
            }
        }
    } catch {}

    removeChildTab(currentTabId);
    try {
        await chrome.tabs.remove(currentTabId);
    } catch {}
}

async function reviveDeadChild() {
    let currentTabId = currentActiveTabId;
    if (!currentTabId) {
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (activeTab) currentTabId = activeTab.id;
    }

    if (deadChildren.length === 0) {
        if (currentTabId) {
            chrome.tabs.sendMessage(currentTabId, {
                type: "SHOW_REDIRECT_NOTICE",
                canJumpBack: false,
                text: "No recently closed child tabs to revive"
            }).catch(() => {});
        }
        return;
    }

    const dead = deadChildren.pop();
    let parentAlive = false;

    try {
        await chrome.tabs.get(dead.parentId);
        parentAlive = true;
    } catch {
        parentAlive = false;
    }

    const createProps = {
        url: dead.url,
        active: true
    };

    if (parentAlive) {
        createProps.openerTabId = dead.parentId;
        createProps.windowId = dead.windowId;
        createProps.index = dead.index;
    }

    try {
        const revivedTab = await chrome.tabs.create(createProps);
        if (parentAlive) {
            addChildTab(dead.parentId, revivedTab.id);
        }
        chrome.tabs.sendMessage(revivedTab.id, {
            type: "SHOW_REDIRECT_NOTICE",
            canJumpBack: false,
            text: `Revived child: ${dead.title || "tab"}`
        }).catch(() => {});
    } catch {}
}

// Handle Alt+Z, Alt+X, Alt+G, and Alt+Shift+G command shortcuts
chrome.commands.onCommand.addListener((command) => {
    if (command === "jump_back") {
        jumpBack();
    } else if (command === "jump_forward") {
        jumpForward();
    } else if (command === "jump_tree_first" || command === "jump_latest_child") {
        jumpToChildTab("first");
    } else if (command === "jump_tree_latest" || command === "jump_first_child") {
        jumpToChildTab("latest");
    }
});

// Track newly created tabs to only close freshly spawned duplicates (e.g. from middle-click or external apps)
const pendingNewTabs = new Map();

chrome.tabs.onCreated.addListener((tab) => {
    saveTabMetadata(tab);
    pendingNewTabs.set(tab.id, Date.now());
    setTimeout(() => pendingNewTabs.delete(tab.id), 10000);

    const openerId = tab.openerTabId || currentActiveTabId;
    if (openerId) {
        addChildTab(openerId, tab.id);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    pendingNewTabs.delete(tabId);
    removeChildTab(tabId);
    let idx;
    while ((idx = backStack.indexOf(tabId)) !== -1) backStack.splice(idx, 1);
    while ((idx = forwardStack.indexOf(tabId)) !== -1) forwardStack.splice(idx, 1);
    if (currentActiveTabId === tabId) currentActiveTabId = null;
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    saveTabMetadata(tab);
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
        if (sourceTabId) {
            addChildTab(sourceTabId, match.id);
        }
        const isBackgroundOpen = !tab.active;

        try {
            await chrome.tabs.remove(tabId);
        } catch {
            // Tab may have already been closed
        }

        if (isBackgroundOpen && sourceTabId) {
            try {
                const opener = await chrome.tabs.get(sourceTabId);
                if (opener) {
                    const children = tabChildren.get(sourceTabId) || [];
                    const childSet = new Set(children);
                    const windowTabs = await chrome.tabs.query({ windowId: opener.windowId });

                    let targetIndex = opener.index + 1;
                    for (const wt of windowTabs) {
                        if (wt.id !== match.id && (wt.id === opener.id || childSet.has(wt.id))) {
                            if (wt.index >= targetIndex) {
                                targetIndex = wt.index + 1;
                            }
                        }
                    }

                    await chrome.tabs.move(match.id, {
                        windowId: opener.windowId,
                        index: targetIndex
                    });

                    chrome.tabs.sendMessage(opener.id, {
                        type: "SHOW_REDIRECT_NOTICE",
                        canJumpBack: false,
                        text: "Already open - placed at end of reading queue"
                    }).catch(() => {});
                }
            } catch {
                // Opener tab may have closed
            }
        } else {
            await chrome.tabs.update(match.id, { active: true });
            await chrome.windows.update(match.windowId, { focused: true });

            chrome.tabs.sendMessage(match.id, {
                type: "SHOW_REDIRECT_NOTICE",
                canJumpBack: Boolean(sourceTabId),
                text: "Tab already open, redirected"
            }).catch(() => {});
        }

        chrome.storage.local.get({ savedCount: 0 }, (data) => {
            chrome.storage.local.set({ savedCount: data.savedCount + 1 });
        });
    }
});



