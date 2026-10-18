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
const deadBranches = []; // Array of { parent: metadata, children: [metadata] }
const tabMetadata = new Map(); // tabId -> { url, title, windowId, index }
let currentActiveTabId = null;
let isNavigatingHistory = false;

let isInitialized = false;
let initPromise = null;

function saveState() {
    if (!isInitialized) return;
    const data = {
        tabChildren: Array.from(tabChildren.entries()),
        backStack: backStack.slice(-50),
        forwardStack: forwardStack.slice(-50),
        deadChildren: deadChildren.slice(-30),
        deadBranches: deadBranches.slice(-20),
        tabMetadata: Array.from(tabMetadata.entries())
    };
    chrome.storage.local.set({ dedupTabTreeState: data }).catch(() => {});
}

function saveTabMetadata(tab, shouldPersist = true) {
    if (!tab || !tab.id) return;
    tabMetadata.set(tab.id, {
        url: tab.url || tab.pendingUrl || "",
        title: tab.title || "",
        windowId: tab.windowId,
        index: tab.index
    });
    if (shouldPersist) saveState();
}

function addChildTab(parentId, childId, shouldPersist = true) {
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
    if (shouldPersist) saveState();
}

function removeChildTab(childId, shouldPersist = true) {
    for (const [parentId, list] of tabChildren.entries()) {
        const idx = list.indexOf(childId);
        if (idx !== -1) {
            list.splice(idx, 1);
            if (list.length === 0) tabChildren.delete(parentId);
        }
    }
    tabChildren.delete(childId);
    if (shouldPersist) saveState();
}

function getParentTabId(childId) {
    for (const [parentId, list] of tabChildren.entries()) {
        if (list.includes(childId)) return parentId;
    }
    return null;
}

async function clearSessionState() {
    tabChildren.clear();
    backStack.length = 0;
    forwardStack.length = 0;
    deadChildren.length = 0;
    deadBranches.length = 0;
    tabMetadata.clear();
    try {
        await chrome.storage.local.remove("dedupTabTreeState");
    } catch {}
}

async function ensureInitialized() {
    if (isInitialized) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        let isNewSession = false;
        if (chrome.storage && chrome.storage.session) {
            try {
                const sess = await chrome.storage.session.get("sessionActive");
                if (!sess || !sess.sessionActive) {
                    isNewSession = true;
                    await chrome.storage.session.set({ sessionActive: true });
                }
            } catch {}
        }

        if (isNewSession) {
            await clearSessionState();
        } else {
            try {
                const stored = await chrome.storage.local.get("dedupTabTreeState");
                if (stored && stored.dedupTabTreeState) {
                    const data = stored.dedupTabTreeState;
                    if (Array.isArray(data.tabChildren)) {
                        for (const [pId, cIds] of data.tabChildren) {
                            if (Array.isArray(cIds)) {
                                tabChildren.set(Number(pId), cIds.map(Number));
                            }
                        }
                    }
                    if (Array.isArray(data.backStack)) {
                        backStack.length = 0;
                        backStack.push(...data.backStack.map(Number));
                    }
                    if (Array.isArray(data.forwardStack)) {
                        forwardStack.length = 0;
                        forwardStack.push(...data.forwardStack.map(Number));
                    }
                    if (Array.isArray(data.deadChildren)) {
                        deadChildren.length = 0;
                        deadChildren.push(...data.deadChildren);
                    }
                    if (Array.isArray(data.deadBranches)) {
                        deadBranches.length = 0;
                        deadBranches.push(...data.deadBranches);
                    }
                    if (Array.isArray(data.tabMetadata)) {
                        for (const [tId, meta] of data.tabMetadata) {
                            tabMetadata.set(Number(tId), meta);
                        }
                    }
                }
            } catch {}
        }

        try {
            const aliveTabs = await chrome.tabs.query({});
            const aliveTabIds = new Set(aliveTabs.map((t) => t.id));

            for (const tab of aliveTabs) {
                saveTabMetadata(tab, false);
                if (tab.active) currentActiveTabId = tab.id;
                if (tab.openerTabId && aliveTabIds.has(tab.openerTabId)) {
                    addChildTab(tab.openerTabId, tab.id, false);
                }
            }

            // Prune dead tabs from tabChildren
            for (const parentId of Array.from(tabChildren.keys())) {
                if (!aliveTabIds.has(parentId)) {
                    tabChildren.delete(parentId);
                } else {
                    const children = tabChildren.get(parentId).filter((cId) => aliveTabIds.has(cId));
                    if (children.length === 0) {
                        tabChildren.delete(parentId);
                    } else {
                        tabChildren.set(parentId, children);
                    }
                }
            }

            // Prune dead tabs from backStack and forwardStack
            let i = backStack.length;
            while (i--) {
                if (!aliveTabIds.has(backStack[i])) backStack.splice(i, 1);
            }
            i = forwardStack.length;
            while (i--) {
                if (!aliveTabIds.has(forwardStack[i])) forwardStack.splice(i, 1);
            }
        } catch {}

        isInitialized = true;
        saveState();
    })();

    return initPromise;
}

// Start initialization immediately on service worker wake-up
ensureInitialized();

// Clear tree and navigation state when browser starts a fresh session
chrome.runtime.onStartup.addListener(async () => {
    await clearSessionState();
    if (chrome.storage && chrome.storage.session) {
        await chrome.storage.session.set({ sessionActive: true }).catch(() => {});
    }
    try {
        const aliveTabs = await chrome.tabs.query({});
        for (const tab of aliveTabs) {
            saveTabMetadata(tab, false);
            if (tab.active) currentActiveTabId = tab.id;
            if (tab.openerTabId) {
                addChildTab(tab.openerTabId, tab.id, false);
            }
        }
    } catch {}
    isInitialized = true;
    saveState();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    await ensureInitialized();
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
        saveState();
    }
    currentActiveTabId = tabId;
});

async function jumpBack() {
    await ensureInitialized();
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
                saveState();
                await chrome.tabs.update(targetTabId, { active: true });
                await chrome.windows.update(targetTab.windowId, { focused: true });
                return;
            }
        } catch {
            // Tab was closed, continue searching stack
        }
    }
    saveState();
}

async function jumpForward() {
    await ensureInitialized();
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
                saveState();
                await chrome.tabs.update(targetTabId, { active: true });
                await chrome.windows.update(targetTab.windowId, { focused: true });
                return;
            }
        } catch {
            // Tab was closed, continue searching stack
        }
    }
    saveState();
}


// Handle bypass tokens, manual jump back triggers, and link deduplication requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return;

    if (message.type === "BYPASS_DEDUP" && message.url) {
        const normalized = normalizeUrl(message.url);
        bypassUrls.add(normalized);
        setTimeout(() => bypassUrls.delete(normalized), 4000);
        sendResponse({ ok: true });
        return;
    }

    if (message.type === "TRIGGER_JUMP_BACK") {
        jumpBack();
        sendResponse({ ok: true });
        return;
    }

    if (message.type === "EXEC_COMMAND" && message.command) {
        ensureInitialized().then(async () => {
            try {
                if (message.command === "safe_kill") {
                    await safeKillChildTab();
                } else if (message.command === "revive_child") {
                    await reviveDeadChild();
                }
                sendResponse({ ok: true });
            } catch {
                sendResponse({ ok: false });
            }
        }).catch(() => {
            sendResponse({ ok: false });
        });
        return true;
    }

    if (message.type === "CHECK_AND_SWITCH_TAB" && message.url) {
        const targetNormalized = normalizeUrl(message.url);
        const sourceTabId = sender.tab ? sender.tab.id : null;

        ensureInitialized().then(() => {
            chrome.tabs.query({}, async (tabs) => {
                try {
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
                            chrome.storage.local.set({ savedCount: ((data && data.savedCount) || 0) + 1 });
                        });

                        sendResponse({ found: true });
                    } else {
                        sendResponse({ found: false });
                    }
                } catch {
                    sendResponse({ found: false });
                }
            });
        }).catch(() => {
            sendResponse({ found: false });
        });

        return true; // Keep message channel open for async sendResponse
    }
});

async function jumpToChildTab(position) {
    await ensureInitialized();
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
    await ensureInitialized();
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
    saveState();
    try {
        await chrome.tabs.remove(currentTabId);
    } catch {}
}

async function reviveDeadChild() {
    await ensureInitialized();
    let currentTabId = currentActiveTabId;
    if (!currentTabId) {
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (activeTab) currentTabId = activeTab.id;
    }

    // 1. Check if there is a recently killed parent branch to revive
    if (deadBranches.length > 0) {
        const branch = deadBranches.pop();
        saveState();
        try {
            const parentProps = {
                url: branch.parent.url || "about:blank",
                active: true
            };
            if (typeof branch.parent.windowId === "number") {
                parentProps.windowId = branch.parent.windowId;
            }
            if (typeof branch.parent.index === "number") {
                parentProps.index = branch.parent.index;
            }
            const revivedParent = await chrome.tabs.create(parentProps);
            saveTabMetadata(revivedParent);

            let childCount = 0;
            for (const ch of branch.children) {
                try {
                    const childProps = {
                        url: ch.url || "about:blank",
                        openerTabId: revivedParent.id,
                        windowId: revivedParent.windowId,
                        active: false
                    };
                    const revivedChild = await chrome.tabs.create(childProps);
                    saveTabMetadata(revivedChild);
                    addChildTab(revivedParent.id, revivedChild.id);
                    childCount++;
                } catch {}
            }

            chrome.tabs.sendMessage(revivedParent.id, {
                type: "SHOW_REDIRECT_NOTICE",
                canJumpBack: false,
                text: `Revived branch: parent and ${childCount} child tabs`
            }).catch(() => {});
            return;
        } catch {}
    }

    // 2. Check if there is a single dead child to revive
    if (deadChildren.length > 0) {
        const dead = deadChildren.pop();
        saveState();
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
            saveTabMetadata(revivedTab);
            if (parentAlive) {
                addChildTab(dead.parentId, revivedTab.id);
            }
            chrome.tabs.sendMessage(revivedTab.id, {
                type: "SHOW_REDIRECT_NOTICE",
                canJumpBack: false,
                text: `Revived child: ${dead.title || "tab"}`
            }).catch(() => {});
        } catch {}
        return;
    }

    if (currentTabId) {
        chrome.tabs.sendMessage(currentTabId, {
            type: "SHOW_REDIRECT_NOTICE",
            canJumpBack: false,
            text: "No recently closed tabs or branches to revive"
        }).catch(() => {});
    }
}

// Handle Alt+Z, Alt+X, Alt+G, and Alt+Shift+G command shortcuts
chrome.commands.onCommand.addListener(async (command) => {
    await ensureInitialized();
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

chrome.tabs.onCreated.addListener(async (tab) => {
    await ensureInitialized();
    saveTabMetadata(tab);
    pendingNewTabs.set(tab.id, Date.now());
    setTimeout(() => pendingNewTabs.delete(tab.id), 10000);

    const openerId = tab.openerTabId || currentActiveTabId;
    if (openerId) {
        addChildTab(openerId, tab.id);
    }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
    await ensureInitialized();
    pendingNewTabs.delete(tabId);

    // If this tab had alive children, decide whether to promote first child or cascade close
    if (tabChildren.has(tabId)) {
        const children = tabChildren.get(tabId) || [];
        if (children.length > 0) {
            const parentId = getParentTabId(tabId);

            let totalAliveTabs = 0;
            try {
                const alive = await chrome.tabs.query({});
                totalAliveTabs = alive.length;
            } catch {}

            const isRoot = !parentId;
            const isLastRemainingBranch = totalAliveTabs <= children.length + 1;

            if (isRoot || isLastRemainingBranch) {
                // Promote the first child to root instead of cascade closing
                const newRootId = children[0];
                const remainingChildren = children.slice(1);

                // Re-parent siblings to the new root
                if (remainingChildren.length > 0) {
                    const existingChildren = tabChildren.get(newRootId) || [];
                    for (const rcId of remainingChildren) {
                        if (!existingChildren.includes(rcId) && rcId !== newRootId) {
                            existingChildren.push(rcId);
                        }
                    }
                    tabChildren.set(newRootId, existingChildren);
                }

                // If closed tab was a child of a higher parent, re-parent newRoot to that parent
                if (parentId) {
                    addChildTab(parentId, newRootId, false);
                }

                // Save closed tab to deadChildren so Ctrl+Q can revive it
                const parentMeta = tabMetadata.get(tabId) || { id: tabId };
                deadChildren.push({
                    url: parentMeta.url,
                    title: parentMeta.title,
                    index: parentMeta.index,
                    windowId: parentMeta.windowId,
                    parentId: parentId || null
                });
                if (deadChildren.length > 30) deadChildren.shift();

                // Focus new root if needed
                try {
                    const newRootTab = await chrome.tabs.get(newRootId);
                    if (newRootTab) {
                        await chrome.tabs.update(newRootId, { active: true });
                        await chrome.windows.update(newRootTab.windowId, { focused: true });
                        chrome.tabs.sendMessage(newRootId, {
                            type: "SHOW_REDIRECT_NOTICE",
                            canJumpBack: false,
                            text: "Root closed: promoted first child as new root"
                        }).catch(() => {});
                    }
                } catch {}
            } else {
                // Non-root detour tab closure: cascade close detour children and save branch
                const parentMeta = tabMetadata.get(tabId) || { id: tabId };
                const childrenMeta = [];
                for (const childId of children) {
                    const chMeta = tabMetadata.get(childId);
                    if (chMeta) childrenMeta.push(chMeta);
                }
                deadBranches.push({
                    parent: parentMeta,
                    children: childrenMeta
                });
                if (deadBranches.length > 20) deadBranches.shift();

                for (const childId of children) {
                    try {
                        chrome.tabs.remove(childId);
                    } catch {}
                }
            }
        }
    }

    removeChildTab(tabId);
    tabMetadata.delete(tabId);
    let idx;
    while ((idx = backStack.indexOf(tabId)) !== -1) backStack.splice(idx, 1);
    while ((idx = forwardStack.indexOf(tabId)) !== -1) forwardStack.splice(idx, 1);
    if (currentActiveTabId === tabId) currentActiveTabId = null;
    saveState();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    await ensureInitialized();
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



