function safeSendMessage(payload, callback) {
    if (!chrome.runtime?.id) return;
    try {
        if (typeof callback === "function") {
            chrome.runtime.sendMessage(payload, (response) => {
                const err = chrome.runtime.lastError;
                if (err) {
                    callback(null);
                    return;
                }
                callback(response);
            });
        } else {
            const promise = chrome.runtime.sendMessage(payload);
            if (promise && typeof promise.catch === "function") {
                promise.catch(() => {});
            }
        }
    } catch {
        // Extension context invalidated
    }
}

function showRedirectNotice(canJumpBack = false, customText = "Tab already open, redirected") {
    const mountPoint = document.body || document.documentElement;
    if (!mountPoint) return;

    let container, shadow;
    try {
        container = document.createElement("div");
        shadow = container.attachShadow({ mode: "closed" });
    } catch {
        return;
    }

    const pill = document.createElement("div");

    const text = document.createElement("span");
    text.textContent = customText;
    pill.appendChild(text);

    if (canJumpBack) {
        const btn = document.createElement("button");
        btn.textContent = "Jump back";
        btn.addEventListener("click", () => {
            safeSendMessage({ type: "TRIGGER_JUMP_BACK" });
            try {
                container.remove();
            } catch {}
        });
        pill.appendChild(btn);
    }

    const style = document.createElement("style");
    style.textContent = `
        :host {
          all: initial;
        }
        div {
          position: fixed;
          top: 24px;
          right: 24px;
          z-index: 2147483647;
          color-scheme: light dark;

          background: Canvas;
          color: CanvasText;
          border: 1px solid ButtonBorder;

          font: message-box;
          font-size: 13px;
          padding: 8px 16px;
          border-radius: 9999px; /* Chrome pill style */
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);

          display: inline-flex;
          align-items: center;
          user-select: none;
          opacity: 0;
          transform: translateY(-8px);
          transition: opacity 0.2s ease, transform 0.2s ease;
        }
        div.visible {
          opacity: 1;
          transform: translateY(0);
        }
        button {
          all: unset;
          margin-left: 10px;
          padding: 2px 10px;
          border: 1px solid ButtonBorder;
          border-radius: 9999px;
          cursor: pointer;
          font: inherit;
          color: CanvasText;
          background: Canvas;
          transition: opacity 0.15s ease, filter 0.15s ease;
        }
        button:hover {
          filter: brightness(0.9);
        }
        button:active {
          filter: brightness(0.8);
        }
      `;

    try {
        shadow.appendChild(style);
        shadow.appendChild(pill);
        mountPoint.appendChild(container);
    } catch {
        return;
    }

    requestAnimationFrame(() => {
        try {
            pill.classList.add("visible");
        } catch {}
    });

    const displayDuration = canJumpBack ? 2500 : 1000;
    setTimeout(() => {
        try {
            pill.classList.remove("visible");
            setTimeout(() => {
                try {
                    container.remove();
                } catch {}
            }, 250);
        } catch {}
    }, displayDuration);
}

// Listen for redirect notifications dispatched from background worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "SHOW_REDIRECT_NOTICE") {
        const text = message.text || "Tab already open, redirected";
        showRedirectNotice(Boolean(message.canJumpBack), text);
        if (typeof sendResponse === "function") {
            sendResponse({ received: true });
        }
    }
});

// Allow duplicate tab creation on Alt + Middle-click
document.addEventListener("auxclick", (e) => {
    if (e.button === 1 && e.altKey) {
        const target = e.target instanceof Element ? e.target : e.target?.parentElement;
        const link = target ? target.closest("a[href]") : null;
        if (!link) return;

        const rawHref = typeof link.href === "string" ? link.href : (link.href?.baseVal || link.getAttribute("href") || "");
        if (rawHref) {
            safeSendMessage({
                type: "BYPASS_DEDUP",
                url: rawHref
            });
        }
    }
}, true);

// Intercept regular left-clicks on links to prevent duplicate tabs
document.addEventListener("click", (e) => {
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

    const target = e.target instanceof Element ? e.target : e.target?.parentElement;
    const link = target ? target.closest("a[href]") : null;
    if (!link) return;

    const hrefAttr = link.getAttribute("href");
    if (!hrefAttr || hrefAttr.startsWith("#") || hrefAttr.startsWith("javascript:")) return;
    if (link.hasAttribute("download")) return;

    let url = "";
    try {
        const rawHref = typeof link.href === "string" ? link.href : (link.href?.baseVal || hrefAttr);
        url = new URL(rawHref, window.location.href).href;
    } catch {
        return;
    }

    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) return;

    // Ignore in-page anchor links
    const currentBase = window.location.href.split("#")[0];
    if (url === window.location.href || url.startsWith(currentBase + "#")) return;

    const targetAttr = typeof link.target === "string" ? link.target : (link.target?.baseVal || link.getAttribute("target") || "");
    const isNewTab = targetAttr === "_blank";

    e.preventDefault();
    e.stopPropagation();

    safeSendMessage(
        { type: "CHECK_AND_SWITCH_TAB", url },
        (response) => {
            if (!response || !response.found) {
                if (isNewTab) {
                    window.open(url, "_blank");
                } else {
                    window.location.href = url;
                }
            }
        }
    );
}, true);

// Listen for in-page detour keyboard shortcuts
document.addEventListener("keydown", (e) => {
    if (!e || !e.target) return;
    const el = e.target instanceof Element ? e.target : e.target?.parentElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;

    if (e.altKey && !e.shiftKey && e.code === "KeyW") {
        e.preventDefault();
        safeSendMessage({ type: "EXEC_COMMAND", command: "safe_kill" });
    } else if ((e.altKey || e.ctrlKey) && !e.shiftKey && e.code === "KeyQ") {
        e.preventDefault();
        safeSendMessage({ type: "EXEC_COMMAND", command: "revive_child" });
    }
}, true);
