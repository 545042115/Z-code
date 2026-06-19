// @z-assistant/agent-browser — Browser Agent element overlay
//
// Injects a visual overlay into the page so users can see which
// elements the agent is interacting with. Only injected when the
// browser is launched in headed mode.

const OVERLAY_CSS = `
#z-assistant-overlay {
  position: fixed;
  top: 0; left: 0;
  width: 100%; height: 100%;
  pointer-events: none;
  z-index: 2147483647;
}
#z-assistant-overlay .z-highlight {
  position: absolute;
  border: 2px solid #38bdf8;
  background: rgba(56, 189, 248, 0.1);
  pointer-events: none;
  transition: all 0.2s ease;
}
#z-assistant-overlay .z-highlight.active {
  border-color: #f97316;
  background: rgba(249, 115, 22, 0.15);
}
#z-assistant-overlay .z-tooltip {
  position: absolute;
  background: #1e293b;
  color: #f8fafc;
  padding: 4px 8px;
  font-size: 12px;
  font-family: monospace;
  border-radius: 4px;
  pointer-events: none;
  white-space: nowrap;
}
`;

// The overlay injection code is expected to be run via page.evaluate or
// added as a content script. It exposes a helper for highlighting elements.

export function generateOverlayScript(): string {
  return `
(function() {
  if (document.getElementById('z-assistant-overlay')) return;
  const style = document.createElement('style');
  style.textContent = ${JSON.stringify(OVERLAY_CSS)};
  document.head.appendChild(style);
  const overlay = document.createElement('div');
  overlay.id = 'z-assistant-overlay';
  document.body.appendChild(overlay);
  (window as any).__zOverlay = {
    highlight: function(x, y, w, h, label) {
      const o = document.getElementById('z-assistant-overlay');
      if (!o) return;
      const el = document.createElement('div');
      el.className = 'z-highlight';
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      o.appendChild(el);
      if (label) {
        const tip = document.createElement('div');
        tip.className = 'z-tooltip';
        tip.style.left = x + 'px';
        tip.style.top = (y - 24) + 'px';
        tip.textContent = label;
        o.appendChild(tip);
      }
      setTimeout(function() { el.remove(); if (tip) tip.remove(); }, 3000);
    },
    clear: function() {
      const o = document.getElementById('z-assistant-overlay');
      if (o) o.innerHTML = '';
    }
  };
})();
`;
}
