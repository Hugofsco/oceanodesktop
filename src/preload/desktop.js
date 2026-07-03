'use strict';
// Desktop-mode chrome injected into the seamless-canvas SPA. The canvas spans ALL monitors, but
// every piece of Oceano's chrome must live on the PRIMARY one — only the floating-window layer
// (#windows), the scrims, and the ocean backgrounds may span. Two kinds of override:
//   1) .shell (sidebar + chat + topbar) — width-pinned to the primary monitor;
//   2) every position:fixed overlay that anchors to the viewport (modals, confirm/prompt dialogs,
//      toasts, the login gate, the Settings drawer) — re-anchored to primary-monitor coordinates,
//      because `left:50%` of a 2-monitor viewport is the bezel.
// All view-time — Oceano's files are never modified.
const { ipcRenderer } = require('electron');

function argInt(name, def) {
  const pfx = '--' + name + '=';
  const a = (process.argv || []).find((s) => s.startsWith(pfx));
  const v = a ? parseInt(a.slice(pfx.length), 10) : NaN;
  return Number.isFinite(v) ? v : def;
}
function argStr(name, def) {
  const pfx = '--' + name + '=';
  const a = (process.argv || []).find((s) => s.startsWith(pfx));
  return a ? a.slice(pfx.length) : def;
}
const MAIN_W = argInt('oceano-main-width', 1920);
const MAIN_X = argInt('oceano-main-x', 0);
const CX = MAIN_X + Math.round(MAIN_W / 2);          // horizontal center of the primary monitor
const MAIN_RIGHT = MAIN_X + MAIN_W;                   // right edge of the primary monitor
const PRIMARY_IDX = argInt('oceano-primary', 0);
// "x,y,w,h;x,y,w,h" → [{x,y,w,h}] (viewport coordinates)
const MONITORS = argStr('oceano-monitors', `${MAIN_X},0,${MAIN_W},1080`).split(';').map((s) => {
  const [x, y, w, h] = s.split(',').map((n) => parseInt(n, 10));
  return { x, y, w, h };
}).filter((m) => [m.x, m.y, m.w, m.h].every(Number.isFinite));

function injectLayout() {
  const root = document.head || document.documentElement;
  if (!root || document.getElementById('__oceano_dm_layout')) return;
  const st = document.createElement('style');
  st.id = '__oceano_dm_layout';
  st.textContent = [
    // the app chrome (sidebar + topbar + chat) lives on the primary monitor
    `.shell{width:${MAIN_W}px !important;margin-left:${MAIN_X}px !important}`,
    // centered overlays: left:50% of the spanned viewport is the bezel — recenter on the primary
    `.modal{left:${CX}px !important}`,
    `.confirm{left:${CX}px !important}`,
    `#toastHost{left:${CX}px !important}`,
    // login / forced-password gates: keep the full-span backdrop, center the card on the primary
    `.login-gate{grid-template-columns:${MAIN_W}px !important;justify-content:start !important;padding-left:${MAIN_X}px !important}`,
    // Settings drawer: anchor to the primary monitor's right edge, not the whole canvas's
    `.drawer{right:calc(100vw - ${MAIN_RIGHT}px) !important}`,
    // closed drawer slides right by its own width — mid-canvas that's *visible* on the next
    // monitor, so hide it once the slide-out finishes (original relied on the viewport edge)
    `.drawer:not(.open){visibility:hidden;transition:transform .32s cubic-bezier(.2,.8,.2,1),visibility 0s .32s}`,
    // #windows, the scrims, and the bg-* layers intentionally keep spanning all monitors
  ].join('\n');
  root.appendChild(st);
}

function addHint() {
  if (!document.body || document.getElementById('__oceano_dm_hint')) return;
  const style = document.createElement('style');
  style.textContent =
    `#__oceano_dm_hint{position:fixed;left:${CX}px;bottom:22px;transform:translateX(-50%);` +
    'z-index:2147483647;pointer-events:none;display:flex;gap:10px;align-items:center;' +
    'font:12px/1.2 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;color:#cfe9ef;' +
    'background:rgba(7,19,26,.86);border:1px solid rgba(58,214,227,.4);border-radius:999px;' +
    'padding:9px 16px;box-shadow:0 6px 24px rgba(0,0,0,.5);backdrop-filter:blur(8px);' +
    'transition:opacity .5s ease;opacity:1}' +
    '#__oceano_dm_hint.faded{opacity:0}' +
    '#__oceano_dm_hint b{color:#3ad6e3;font-weight:600;letter-spacing:.02em}' +
    '#__oceano_dm_hint kbd{font:11px ui-monospace,Menlo,Consolas,monospace;background:rgba(58,214,227,.14);' +
    'border:1px solid rgba(58,214,227,.35);border-radius:5px;padding:1px 5px;color:#dcedf3;margin:0 1px}';
  (document.head || document.documentElement).appendChild(style);

  const h = document.createElement('div');
  h.id = '__oceano_dm_hint';
  h.innerHTML = '<b>⤢ Full desktop mode</b><span>Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> to exit</span>';
  document.body.appendChild(h);

  let t = setTimeout(() => h.classList.add('faded'), 5000);
  window.addEventListener('mousemove', (e) => {
    if (e.clientY > window.innerHeight - 90) {
      h.classList.remove('faded');
      clearTimeout(t);
      t = setTimeout(() => h.classList.add('faded'), 2500);
    }
  });
}

// Monitor-aware snapping/maximize for Oceano's floating windows. app.js is a classic script, so
// its window-management functions are global bindings — a main-world <script> can re-bind them
// (the isolated preload world can't touch page JS; the DOM-injected script runs in the main world,
// and the SPA sets no CSP). Patched: _detectZone (aero-snap zones on the monitor under the
// pointer), _applySnap + maximizeWindow (fit the monitor holding the window — on the primary,
// the original .views region so the sidebar/topbar stay respected), and ui_arrange's "center".
// Every entry point funnels here: edge-drag, the ▢ button, title dblclick, agent ui_arrange.
function injectSnapPatch() {
  if (!document.body || document.getElementById('__oceano_dm_snap')) return;
  const s = document.createElement('script');
  s.id = '__oceano_dm_snap';
  s.textContent = `(() => {
    const MONS = ${JSON.stringify(MONITORS)};
    const PRIMARY = ${PRIMARY_IDX};
    const monAt = (x, y) => MONS.find((m) => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h) || MONS[0];
    const origRegion = window._snapRegion;
    const regionAt = (x, y) => {
      const m = monAt(x, y);
      if (m === MONS[PRIMARY] && typeof origRegion === 'function') {
        try { return origRegion(); } catch (e) { /* fall through */ }
      }
      return { left: m.x, top: m.y, w: m.w, h: m.h };
    };
    const zoneRectIn = (R, zone) => {
      const hw = R.w / 2, hh = R.h / 2;
      const m = { full: [R.left, R.top, R.w, R.h], left: [R.left, R.top, hw, R.h], right: [R.left + hw, R.top, hw, R.h],
        top: [R.left, R.top, R.w, hh], bottom: [R.left, R.top + hh, R.w, hh],
        tl: [R.left, R.top, hw, hh], tr: [R.left + hw, R.top, hw, hh],
        bl: [R.left, R.top + hh, hw, hh], br: [R.left + hw, R.top + hh, hw, hh] };
      const [x, y, w, h] = m[zone]; return { x, y, w, h };
    };
    const center = (el) => ({ x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight / 2 });

    // The region resolved by the latest zone detection (i.e. the monitor under the drag pointer).
    // The preview highlight AND the final snap both reuse it, so what you see is where it lands —
    // even when the dragged window straddles the bezel. Falls back to the window's own monitor
    // for non-drag callers (agent ui_arrange), where no recent pointer detection exists.
    let lastZone = { R: null, t: 0 };
    const freshR = () => (lastZone.R && Date.now() - lastZone.t < 600) ? lastZone.R : null;

    if (typeof window._detectZone === 'function') window._detectZone = (cx, cy) => {
      const R = regionAt(cx, cy), x = cx - R.left, y = cy - R.top;
      lastZone = { R, t: Date.now() };
      if (x < -20 || y < -20 || x > R.w + 20 || y > R.h + 20) return null;
      const E = 28, C = 150;
      if (y <= E) return x <= C ? 'tl' : x >= R.w - C ? 'tr' : 'full';
      if (y >= R.h - E) return x <= C ? 'bl' : x >= R.w - C ? 'br' : 'bottom';
      if (x <= E) return 'left';
      if (x >= R.w - E) return 'right';
      return null;
    };

    if (typeof window._applySnap === 'function') window._applySnap = (win, zone) => {
      if (!win.dataset.snapped && !win.dataset.maximized) {
        win.dataset.restoreW = win.offsetWidth; win.dataset.restoreH = win.offsetHeight;
        win.dataset.restoreX = win.offsetLeft; win.dataset.restoreY = win.offsetTop;
      }
      const c = center(win), r = zoneRectIn(freshR() || regionAt(c.x, c.y), zone);
      win.classList.add('snapping');
      win.style.left = r.x + 'px'; win.style.top = r.y + 'px';
      win.style.width = r.w + 'px'; win.style.height = r.h + 'px';
      win.dataset.snapped = zone; win.dataset.maximized = '';
      setTimeout(() => win.classList.remove('snapping'), 140);
    };

    // The snap-preview highlight — the original calls the unpatched _zoneRect (primary-only),
    // so the glow never appeared on secondary monitors. Same region resolution as the snap itself.
    if (typeof window._showSnap === 'function') window._showSnap = (zone, win) => {
      let el = document.getElementById('snapPreview');
      if (!zone) { if (el) el.style.display = 'none'; return; }
      if (!el) { el = document.createElement('div'); el.id = 'snapPreview'; document.body.appendChild(el); }
      const c = win ? center(win) : { x: 0, y: 0 };
      const r = zoneRectIn(freshR() || regionAt(c.x, c.y), zone);
      el.style.display = 'block';
      el.style.left = r.x + 'px'; el.style.top = r.y + 'px';
      el.style.width = r.w + 'px'; el.style.height = r.h + 'px';
      if (win) el.style.zIndex = (parseInt(win.style.zIndex) || 100) - 1;
    };

    if (typeof window.maximizeWindow === 'function') window.maximizeWindow = (win) => {
      win.classList.add('snapping');
      if (win.dataset.maximized || win.dataset.snapped) {
        win.style.width = (win.dataset.restoreW || 520) + 'px'; win.style.height = (win.dataset.restoreH || 420) + 'px';
        win.style.left = (win.dataset.restoreX || 150) + 'px'; win.style.top = (win.dataset.restoreY || 90) + 'px';
        win.dataset.maximized = ''; win.dataset.snapped = '';
      } else {
        win.dataset.restoreW = win.offsetWidth; win.dataset.restoreH = win.offsetHeight;
        win.dataset.restoreX = win.offsetLeft; win.dataset.restoreY = win.offsetTop;
        const c = center(win), r = zoneRectIn(regionAt(c.x, c.y), 'full');
        win.style.left = r.x + 'px'; win.style.top = r.y + 'px';
        win.style.width = r.w + 'px'; win.style.height = r.h + 'px';
        win.dataset.maximized = '1';
      }
      win.style.zIndex = ++_winZ;
      if (typeof saveWinGeom === 'function') saveWinGeom(win);
      setTimeout(() => win.classList.remove('snapping'), 140);
    };

    if (typeof window.uiArrange === 'function') {
      const origArrange = window.uiArrange;
      window.uiArrange = (c) => {
        if ((c.mode || '').toLowerCase() === 'center' && typeof window._uiWin === 'function') {
          const el = window._uiWin(c.window);
          if (el) {
            el.style.display = 'flex'; el.style.zIndex = ++_winZ;
            el.dataset.snapped = ''; el.dataset.maximized = '';
            const R = regionAt(...Object.values(center(el)));
            el.style.left = Math.max(R.left, R.left + (R.w - el.offsetWidth) / 2) + 'px';
            el.style.top = Math.max(R.top + 40, R.top + (R.h - el.offsetHeight) / 2) + 'px';
            return;
          }
        }
        return origArrange(c);
      };
    }
    window.__dmSnapPatched = true;
  })();`;
  document.body.appendChild(s);
}

// In-window fallback for the exit shortcut (covers the global shortcut being unavailable).
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) { e.preventDefault(); ipcRenderer.send('desktop:exit'); }
}, true);

// Inject the layout pin the moment <html> exists (the preload runs BEFORE any document element —
// touching the DOM immediately would throw and kill the whole preload script).
if (document.documentElement) injectLayout();
else new MutationObserver((_m, obs) => {
  if (document.documentElement) { injectLayout(); obs.disconnect(); }
}).observe(document, { childList: true });
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { injectLayout(); addHint(); injectSnapPatch(); });
else { injectLayout(); addHint(); injectSnapPatch(); }
window.addEventListener('load', () => { injectLayout(); addHint(); injectSnapPatch(); });
