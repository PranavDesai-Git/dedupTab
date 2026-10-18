function showRedirectNotice() {
    const container = document.createElement("div");
    const shadow = container.attachShadow({ mode: "closed" });

    const pill = document.createElement("div");
    pill.textContent = "Tab already open, redirected";

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

          pointer-events: none;
          opacity: 0;
          transform: translateY(-8px);
          transition: opacity 0.2s ease, transform 0.2s ease;
        }
        div.visible {
          opacity: 1;
          transform: translateY(0);
        }
      `;

    shadow.appendChild(style);
    shadow.appendChild(pill);
    document.documentElement.appendChild(container);

    requestAnimationFrame(() => pill.classList.add("visible"));

    setTimeout(() => {
        pill.classList.remove("visible");
        setTimeout(() => container.remove(), 250);
    }, 1000);
}

