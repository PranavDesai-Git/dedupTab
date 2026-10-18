function showRedirectNotice(canJumpBack = false, customText = "Tab already open, redirected") {
    const container = document.createElement("div");
    const shadow = container.attachShadow({ mode: "closed" });

    const pill = document.createElement("div");

    const text = document.createElement("span");
    text.textContent = customText;
    pill.appendChild(text);

    if (canJumpBack) {
        const btn = document.createElement("button");
        btn.textContent = "Jump back";
        btn.addEventListener("click", () => {
            chrome.runtime.sendMessage({ type: "TRIGGER_JUMP_BACK" });
            container.remove();
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

    shadow.appendChild(style);
    shadow.appendChild(pill);
    document.documentElement.appendChild(container);

    requestAnimationFrame(() => pill.classList.add("visible"));

    const displayDuration = canJumpBack ? 2500 : 1000;
    setTimeout(() => {
        pill.classList.remove("visible");
        setTimeout(() => container.remove(), 250);
    }, displayDuration);
}

// Listen for redirect notifications dispatched from background worker
chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "SHOW_REDIRECT_NOTICE") {
        const text = message.text || "Tab already open, redirected";
        showRedirectNotice(Boolean(message.canJumpBack), text);
    }
});

// Allow duplicate tab creation on Alt + Middle-click
document.addEventListener("auxclick", (e) => {
    if (e.button === 1 && e.altKey) {
        const link = e.target.closest("a[href]");
        if (link && link.href) {
            chrome.runtime.sendMessage({
                type: "BYPASS_DEDUP",
                url: link.href
            });
        }
    }
}, true);

// Intercept regular left-clicks on links to prevent duplicate tabs
document.addEventListener("click", (e) => {
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

    const link = e.target.closest("a[href]");
    if (!link) return;

    const hrefAttr = link.getAttribute("href");
    if (!hrefAttr || hrefAttr.startsWith("#") || hrefAttr.startsWith("javascript:")) return;
    if (link.hasAttribute("download")) return;

    const url = link.href;
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) return;
    if (url.startsWith(window.location.href + "#")) return;

    e.preventDefault();
    e.stopPropagation();

    const isNewTab = link.target === "_blank";

    chrome.runtime.sendMessage(
        { type: "CHECK_AND_SWITCH_TAB", url },
        (response) => {
            if (chrome.runtime.lastError || !response || !response.found) {
                if (isNewTab) {
                    window.open(url, "_blank");
                } else {
                    window.location.href = url;
                }
            }
        }
    );
}, true);




