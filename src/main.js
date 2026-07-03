'use strict';
// Oceano Desktop — alpha-alpha.
// A tray-resident native client for the Oceano daemon. Four surfaces:
//   • Full client   — a window loading Oceano's SPA (all built-in apps come free)
//   • Quick chat     — a frameless tray popover that streams /api/chat
//   • Notifications  — floating toast cards for job start/finish + new mail
//   • Desktop mode   — a frameless overlay spanning ALL monitors, loading the SPA
// Every window is dumb UI; the main process is the only thing that talks to Oceano.
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, globalShortcut, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const x11 = require('x11');
const OceanoClient = require('./oceano');
const { makeTrayIcon } = require('./trayIcon');

// ---------------- config ----------------
const DEFAULTS = {
  oceanoUrl: 'http://127.0.0.1:8800',
  pollMs: 3000,
  mailPollMs: 60000,
  notifyJobs: true,
  notifyMail: true,
  quickChatShortcut: 'Control+Shift+Space',
  desktopModeShortcut: 'Control+Shift+D',
};
function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')) };
  } catch (_) { return { ...DEFAULTS }; }
}
const CFG = loadConfig();
const QC_SESSION = 'desktop-quickchat';

let oceanoSession, oceano;
let tray = null, fullClient = null, quickChat = null, notifyWin = null, desktopWins = [];
let currentAbort = null;

// ---------------- lifecycle ----------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => toggleQuickChat());
  app.whenReady().then(init);
}

function init() {
  app.setName('Oceano');
  oceanoSession = session.fromPartition('persist:oceano');
  oceano = new OceanoClient(oceanoSession, CFG.oceanoUrl);

  setupTray();
  setupShortcuts();
  setupIPC();
  startPollers();

  if (process.env.TEST_DESKTOP) {                    // exercise the real desktop mode, probe layout, then quit
    toggleDesktopMode();
    const w0 = desktopWins[0];
    if (w0) w0.webContents.on('console-message', (_e, _l, msg) => console.log('RENDERER:', msg));
    setTimeout(async () => {
      console.log('DESKTOP_BOUNDS', JSON.stringify(desktopWins.map((w) => w.getBounds())));
      const w = desktopWins[0];
      if (w && !w.isDestroyed()) {
        try {
          const probe = await w.webContents.executeJavaScript(`(() => {
            const r = (s) => { const e = document.querySelector(s); if (!e) return null;
              const b = e.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width) }; };
            return { inner: innerWidth, shell: r('.shell'), topbar: r('.topbar'), composer: r('.composer'),
                     gate: r('.login-gate'), card: r('.login-card'), modal: r('#skModal'),
                     confirm: r('#confirmBox'), drawer: r('.drawer'), windows: r('#windows'),
                     hasLayout: !!document.getElementById('__oceano_dm_layout'),
                     hasHint: !!document.getElementById('__oceano_dm_hint'),
                     snapPatched: !!window.__dmSnapPatched,
                     // functional: a fake window on monitor 2 → maximize must fit THAT monitor
                     maxOnMon2: (() => {
                       try {
                         const d = document.createElement('div');
                         d.className = 'win'; d.style.cssText = 'position:fixed;left:2400px;top:300px;width:400px;height:300px';
                         document.getElementById('windows').appendChild(d);
                         maximizeWindow(d);
                         // read assigned targets, not offsetLeft — the .snapping transition animates for 140ms
                         const out = { l: d.style.left, t: d.style.top, w: d.style.width, h: d.style.height };
                         d.remove(); return out;
                       } catch (e) { return String(e); }
                     })(),
                     zoneMon2Top: typeof _detectZone === 'function' ? _detectZone(2880, 10) : null,
                     zoneMon2Left: typeof _detectZone === 'function' ? _detectZone(1930, 500) : null,
                     zoneMon1Right: typeof _detectZone === 'function' ? _detectZone(1900, 500) : null,
                     // preview must draw on the monitor where the zone was detected
                     previewMon2: (() => {
                       try {
                         _detectZone(2880, 10);                       // pointer at top edge of monitor 2
                         _showSnap('full', null);
                         const el = document.getElementById('snapPreview');
                         const out = el ? { l: el.style.left, w: el.style.width, shown: el.style.display } : null;
                         _showSnap(null); return out;
                       } catch (e) { return String(e); }
                     })(),
                     previewMon1: (() => {
                       try {
                         _detectZone(100, 500);                       // pointer at left edge of monitor 1
                         _showSnap('left', null);
                         const el = document.getElementById('snapPreview');
                         const out = el ? { l: el.style.left, w: el.style.width } : null;
                         _showSnap(null); return out;
                       } catch (e) { return String(e); }
                     })() };
          })()`);
          console.log('PROBE', JSON.stringify(probe));
          if (process.env.TEST_SHOT) {
            const img = await w.webContents.capturePage();
            fs.writeFileSync(process.env.TEST_SHOT, img.toPNG());
            console.log('SHOT', process.env.TEST_SHOT);
          }
        } catch (e) { console.log('PROBE_ERR', String((e && e.message) || e)); }
      }
      app.quit();
    }, 6000);
    return;
  }
  if (!process.env.SMOKE) openFullClient();          // first run → log in here (seeds the cookie)
  if (process.env.SMOKE) setTimeout(() => { console.log('[smoke] booted ok'); app.quit(); }, 3000);
}

app.on('window-all-closed', () => { /* tray app — stay alive until Quit */ });
app.on('will-quit', () => globalShortcut.unregisterAll());

// ---------------- tray ----------------
function setupTray() {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('Oceano');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Oceano client', click: openFullClient },
    { label: 'Quick chat', accelerator: CFG.quickChatShortcut, click: toggleQuickChat },
    { label: 'Full desktop mode', accelerator: CFG.desktopModeShortcut, click: toggleDesktopMode },
    { type: 'separator' },
    { label: 'Quit Oceano', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  // Click behaviour (fires on some Linux DEs, not all — the menu + shortcuts are the reliable path).
  tray.on('click', () => toggleQuickChat());
  tray.on('double-click', () => openFullClient());
}

function setupShortcuts() {
  const reg = (accel, fn) => { try { globalShortcut.register(accel, fn); } catch (_) {} };
  reg(CFG.quickChatShortcut, toggleQuickChat);
  reg(CFG.desktopModeShortcut, toggleDesktopMode);
}

// ---------------- full client ----------------
function openFullClient() {
  if (fullClient && !fullClient.isDestroyed()) { fullClient.show(); fullClient.focus(); return; }
  fullClient = new BrowserWindow({
    width: 1360, height: 860, title: 'Oceano', backgroundColor: '#06121a', autoHideMenuBar: true,
    webPreferences: { partition: 'persist:oceano' },
  });
  fullClient.loadURL(CFG.oceanoUrl);
  fullClient.on('closed', () => { fullClient = null; });
}

// ---------------- quick chat ----------------
function createQuickChat() {
  quickChat = new BrowserWindow({
    width: 392, height: 560, show: false, frame: false, resizable: false, skipTaskbar: true,
    alwaysOnTop: true, backgroundColor: '#0a1f2b', title: 'Oceano quick chat',
    webPreferences: { preload: path.join(__dirname, 'preload', 'quickchat.js') },
  });
  quickChat.loadFile(path.join(__dirname, 'windows', 'quickchat.html'));
  quickChat.on('blur', () => { if (quickChat && !quickChat.webContents.isDevToolsOpened()) quickChat.hide(); });
  quickChat.on('closed', () => { quickChat = null; });
}
function toggleQuickChat() {
  if (!quickChat) createQuickChat();
  if (quickChat.isVisible()) { quickChat.hide(); return; }
  const wa = screen.getPrimaryDisplay().workArea;
  const b = quickChat.getBounds();
  quickChat.setBounds({ x: wa.x + wa.width - b.width - 12, y: wa.y + wa.height - b.height - 12, width: b.width, height: b.height });
  quickChat.show();
  quickChat.focus();
  sendAuth();
}
async function sendAuth() {
  if (!quickChat || quickChat.isDestroyed()) return;
  const me = await oceano.me();
  if (quickChat && !quickChat.isDestroyed()) quickChat.webContents.send('qc:auth', me);
}

// ---------------- desktop mode (one seamless canvas across all monitors) ----------------
// ONE Oceano window, fullscreen across EVERY monitor (covers the panels via
// _NET_WM_FULLSCREEN_MONITORS — plain fullscreen can't span monitors under Mutter). The SPA's
// chat/sidebar is pinned to the primary monitor by a view-time CSS tweak (see preload/desktop.js),
// so the rest of the span is free space to drag Oceano's floating apps onto. Oceano is untouched.
function toggleDesktopMode() {
  if (desktopWins.length) { closeDesktopMode(); return; }
  const displays = screen.getAllDisplays();
  const u = unionBounds(displays);
  const primary = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: u.x, y: u.y, width: u.width, height: u.height, frame: false, backgroundColor: '#06121a',
    autoHideMenuBar: true, skipTaskbar: true, title: 'Oceano desktop',
    enableLargerThanScreen: true,                      // macOS: without this the window is clamped to one display
    webPreferences: {
      partition: 'persist:oceano',
      preload: path.join(__dirname, 'preload', 'desktop.js'),
      additionalArguments: [
        `--oceano-main-width=${primary.bounds.width}`,
        `--oceano-main-x=${primary.bounds.x - u.x}`,
        // every monitor in viewport coordinates (window origin = union origin), for snap/maximize
        `--oceano-monitors=${displays.map((d) => [d.bounds.x - u.x, d.bounds.y - u.y, d.bounds.width, d.bounds.height].join(',')).join(';')}`,
        `--oceano-primary=${displays.findIndex((d) => d.id === primary.id)}`,
      ],
    },
  });
  desktopWins.push(win);
  win.on('closed', () => { desktopWins = desktopWins.filter((w) => w !== win); });
  win.once('ready-to-show', () => spanFullscreen(win, displays));
  win.loadURL(CFG.oceanoUrl);
}

function unionBounds(displays) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const d of displays) {
    const b = d.bounds;
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.width); y2 = Math.max(y2, b.y + b.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

// Make the ONE desktop window cover every monitor as a seamless canvas. Each OS needs a different
// mechanism, so dispatch by platform — all three aim for the same result: a union-bounds window
// sitting above the panels / menu bar / taskbar.
async function spanFullscreen(win, displays) {
  if (!win || win.isDestroyed()) return;
  if (process.platform === 'linux') return spanLinux(win, displays);
  if (process.platform === 'darwin') return spanMac(win, displays);
  if (process.platform === 'win32') return spanWindows(win, displays);
}

// Linux/X11: send _NET_WM_FULLSCREEN_MONITORS (the top/bottom/left/right monitor indices of the
// layout), then add the fullscreen state. If the X message can't be sent, fall back to a work-area
// span (both monitors, but panels stay visible).
async function spanLinux(win, displays) {
  let xidNum;
  try { xidNum = win.getNativeWindowHandle().readUInt32LE(0); } catch (_) { return; }
  const hex = '0x' + xidNum.toString(16);
  let sent = false;
  try {
    const mons = await monitorEdgeIndices();
    await sendFullscreenMonitors(xidNum, mons);
    sent = true;
  } catch (_) { /* fall through to work-area span */ }
  if (win.isDestroyed()) return;
  if (sent) {
    execFile('wmctrl', ['-i', '-r', hex, '-b', 'add,fullscreen'], () => {});
  } else {
    const u = unionBounds(displays);
    execFile('wmctrl', ['-i', '-r', hex, '-b', 'remove,maximized_vert,maximized_horz'], () => {
      execFile('wmctrl', ['-i', '-r', hex, '-e', `0,${u.x},${u.y},${u.width},${u.height}`], () => {});
    });
  }
}

// macOS has no EWMH. The window is already created larger-than-screen (enableLargerThanScreen) at
// the union of all displays; here we re-assert those bounds once the display config is stable and
// raise it above the menu bar + Dock. IMPORTANT: a single window only visually spans multiple
// displays when macOS's "Displays have separate Spaces" is OFF (System Settings → Desktop & Dock →
// Mission Control; toggling it needs a logout). With it ON, macOS confines every window to one
// display's Space, so no single-window span is possible — that's a platform limit, not a bug here.
function spanMac(win, displays) {
  const u = unionBounds(displays);
  win.setBounds({ x: u.x, y: u.y, width: u.width, height: u.height });
  win.setAlwaysOnTop(true, 'screen-saver');            // cover the menu bar + Dock
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
}

// Windows allows larger-than-screen windows by default, so the union-bounds frameless window
// already spans every monitor; we only raise it above the taskbar. (Untested — no Windows box yet.)
function spanWindows(win, displays) {
  const u = unionBounds(displays);
  win.setBounds({ x: u.x, y: u.y, width: u.width, height: u.height });
  win.setAlwaysOnTop(true, 'screen-saver');
}

// xrandr monitor indices of the top/bottom/left/right edges of the whole layout (EWMH wants indices).
function monitorEdgeIndices() {
  return new Promise((resolve, reject) => {
    execFile('xrandr', ['--listmonitors'], (err, stdout) => {
      if (err) return reject(err);
      const mons = [];
      for (const line of stdout.split('\n')) {
        const m = line.match(/^\s*(\d+):\s+\S+\s+(\d+)\/\d+x(\d+)\/\d+\+(\d+)\+(\d+)/);
        if (m) mons.push({ i: +m[1], w: +m[2], h: +m[3], x: +m[4], y: +m[5] });
      }
      if (!mons.length) return reject(new Error('no monitors from xrandr'));
      const pick = (better) => mons.reduce((a, b) => (better(b, a) ? b : a)).i;
      resolve([
        pick((b, a) => b.y < a.y),                     // topmost
        pick((b, a) => b.y + b.h > a.y + a.h),          // bottommost
        pick((b, a) => b.x < a.x),                      // leftmost
        pick((b, a) => b.x + b.w > a.x + a.w),           // rightmost
      ]);
    });
  });
}

let _x11 = null;
function x11Display() {
  return new Promise((resolve, reject) => {
    if (_x11) return resolve(_x11);
    x11.createClient((err, display) => { if (err) return reject(err); _x11 = display; resolve(display); });
  });
}

// Fire the _NET_WM_FULLSCREEN_MONITORS client message at the root window.
async function sendFullscreenMonitors(xidNum, mons) {
  const display = await x11Display();
  const X = display.client;
  const root = display.screen[0].root;
  const atom = await new Promise((res, rej) =>
    X.InternAtom(false, '_NET_WM_FULLSCREEN_MONITORS', (e, a) => (e ? rej(e) : res(a))));
  const buf = Buffer.alloc(32);
  buf.writeUInt8(33, 0);                   // ClientMessage
  buf.writeUInt8(32, 1);                   // format 32
  buf.writeUInt32LE(xidNum >>> 0, 4);      // window
  buf.writeUInt32LE(atom, 8);              // message_type
  buf.writeUInt32LE(mons[0] >>> 0, 12);    // top
  buf.writeUInt32LE(mons[1] >>> 0, 16);    // bottom
  buf.writeUInt32LE(mons[2] >>> 0, 20);    // left
  buf.writeUInt32LE(mons[3] >>> 0, 24);    // right
  buf.writeUInt32LE(1, 28);                // source indication = application
  X.SendEvent(root, 0, 0x180000, buf);     // SubstructureRedirect | SubstructureNotify
  await new Promise((r) => setTimeout(r, 120));
}

function closeDesktopMode() {
  for (const w of desktopWins.slice()) { if (!w.isDestroyed()) w.close(); }
  desktopWins = [];
}

// ---------------- floating notifications ----------------
const notifications = [];
let _notifId = 0;
function ensureNotifyWindow() {
  if (notifyWin && !notifyWin.isDestroyed()) return;
  notifyWin = new BrowserWindow({
    width: 384, height: 120, show: false, frame: false, transparent: true, resizable: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: false, hasShadow: false,
    backgroundColor: '#00000000', title: 'Oceano notifications',
    webPreferences: { preload: path.join(__dirname, 'preload', 'notify.js') },
  });
  notifyWin.setAlwaysOnTop(true, 'screen-saver');
  try { notifyWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
  notifyWin.loadFile(path.join(__dirname, 'windows', 'notifications.html'));
  notifyWin.on('closed', () => { notifyWin = null; });
}
function pushNotification(n) {
  ensureNotifyWindow();
  const item = { id: ++_notifId, ts: Date.now(), title: n.title || 'Oceano', body: n.body || '', kind: n.kind || 'info' };
  notifications.push(item);
  if (notifications.length > 30) notifications.shift();
  const deliver = () => { if (notifyWin && !notifyWin.isDestroyed()) notifyWin.webContents.send('notify:add', item); };
  if (notifyWin.webContents.isLoading()) notifyWin.webContents.once('did-finish-load', deliver);
  else deliver();
}
function removeNotification(id) {
  const i = notifications.findIndex((x) => x.id === id);
  if (i >= 0) notifications.splice(i, 1);
}
function sizeNotifyWindow(contentHeight) {
  if (!notifyWin || notifyWin.isDestroyed()) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const width = 384;
  const h = Math.max(0, Math.min(Math.round(contentHeight), wa.height - 24));
  if (h < 8) { notifyWin.hide(); return; }
  notifyWin.setBounds({ x: wa.x + wa.width - width - 12, y: wa.y + wa.height - h - 12, width, height: h });
  if (!notifyWin.isVisible()) notifyWin.showInactive();
}

// ---------------- IPC ----------------
function setupIPC() {
  ipcMain.on('open-client', openFullClient);
  ipcMain.on('desktop:exit', closeDesktopMode);

  ipcMain.on('qc:send', (_e, text) => {
    text = String(text || '').trim();
    if (!text) return;
    if (currentAbort) { currentAbort(); currentAbort = null; }
    const wc = quickChat && quickChat.webContents;
    currentAbort = oceano.chatStream(
      { session: QC_SESSION, message: text, agent_mode: false },
      (ev) => {
        if (!wc || wc.isDestroyed()) return;
        if (ev.type === 'token') wc.send('qc:token', ev.text || '');
        else if (ev.type === 'error') wc.send('qc:error', { message: ev.message || 'error' });
        else if (ev.type === 'done') { wc.send('qc:done'); currentAbort = null; }
        else wc.send('qc:event', ev);
      },
    );
  });
  ipcMain.on('qc:stop', () => {
    if (currentAbort) { currentAbort(); currentAbort = null; }
    oceano.request('POST', '/api/chat/stop', { session: QC_SESSION }).catch(() => {});
  });

  ipcMain.on('notify:dismiss', (_e, id) => removeNotification(id));
  ipcMain.on('notify:action', (_e, id) => { removeNotification(id); openFullClient(); });
  ipcMain.on('notify:resize', (_e, h) => sizeNotifyWindow(h));
}

// ---------------- pollers ----------------
let lastJobs = null, mailSeen = null;
function startPollers() {
  setInterval(pollJobs, CFG.pollMs);
  setInterval(pollMail, CFG.mailPollMs);
}

const KIND_LABEL = { workflow: 'Workflow', agent: 'Sub-agent', research: 'Research', eval: 'Eval', task: 'Task', job: 'Job' };
function kindLabel(j) {
  const k = (j.kind || 'job');
  return KIND_LABEL[k] || (k.charAt(0).toUpperCase() + k.slice(1));
}
async function pollJobs() {
  if (!CFG.notifyJobs || !oceano) return;
  const snap = await oceano.jobs().catch(() => null);
  if (!snap) return;                                  // not authed / daemon down → skip quietly
  const jobs = (snap.jobs || []).filter((j) => (j.kind || '') !== 'chat');   // don't self-notify on chat turns
  const cur = new Map(jobs.map((j) => [String(j.id), j]));
  if (lastJobs === null) { lastJobs = cur; return; }  // seed the first snapshot silently
  for (const [id, j] of cur) if (!lastJobs.has(id)) pushNotification({ kind: 'job', title: '▶ ' + kindLabel(j) + ' started', body: j.label || j.ref || 'background job' });
  for (const [id, j] of lastJobs) if (!cur.has(id)) pushNotification({ kind: 'job-done', title: '✓ ' + kindLabel(j) + ' finished', body: j.label || j.ref || 'background job' });
  lastJobs = cur;
}

async function pollMail() {
  if (!CFG.notifyMail || !oceano) return;
  const acc = await oceano.mailAccounts().catch(() => null);
  if (!acc) return;
  const accounts = Array.isArray(acc) ? acc : (acc.accounts || []);
  if (!accounts.length) return;                       // mail not configured → nothing to do
  const cur = new Map();
  for (const a of accounts) {
    const aid = a.id != null ? a.id : (a.aid != null ? a.aid : a.account_id);
    if (aid == null) continue;
    const u = await oceano.mailUnreads(aid).catch(() => null);
    if (u == null) continue;
    cur.set(String(aid), { total: sumUnread(u), name: a.email || a.address || a.name || ('account ' + aid) });
  }
  if (mailSeen === null) { mailSeen = cur; return; }
  for (const [aid, info] of cur) {
    const prev = mailSeen.get(aid);
    if (prev && info.total > prev.total) {
      pushNotification({ kind: 'mail', title: '✉ New mail', body: (info.total - prev.total) + ' new in ' + info.name });
    }
  }
  mailSeen = cur;
}
function sumUnread(u) {
  if (typeof u === 'number') return u;
  if (Array.isArray(u)) return u.reduce((s, x) => s + (Number((x && (x.unread != null ? x.unread : x.count)) || 0) || 0), 0);
  if (u && typeof u === 'object') {
    if (typeof u.total === 'number') return u.total;
    const src = (u.unreads && typeof u.unreads === 'object') ? u.unreads : u;
    return Object.values(src).reduce((s, v) => {
      if (typeof v === 'number') return s + v;
      if (v && typeof v === 'object') return s + (Number(v.unread != null ? v.unread : v.count) || 0);
      return s;
    }, 0);
  }
  return 0;
}
