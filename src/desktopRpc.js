'use strict';
// Server→OceanoDesktop native-action bridge: holds /api/desktop/stream open (auto-reconnecting,
// over the same authenticated session OceanoClient already uses — no separate login) and answers
// each pushed `rpc` command by running a REAL native action that only the main process can (a
// notification, a native file/folder picker), then posts the result to /api/desktop/result. This
// is the other half of oceano/desktopbridge.py's call() on the server — a tool call there blocks
// until the answer lands. Independent of every other surface (full client / quick chat / desktop
// mode / tray) — it only needs the shared session to already be authenticated, and does nothing
// if the daemon or the connection isn't there (silently retries instead of erroring at startup).
const { net, Notification, dialog, clipboard, shell, desktopCapturer, screen } = require('electron');

const HANDLERS = {
  notify: async ({ title, body }) => {
    if (!Notification.isSupported()) return { ok: false, result: 'notifications are not supported on this system' };
    new Notification({ title: title || 'Oceano', body: body || '' }).show();
    return { ok: true, result: true };
  },
  'pick-file': async ({ title, kind }) => {
    const properties = kind === 'folder' ? ['openDirectory'] : ['openFile'];
    const r = await dialog.showOpenDialog({ title: title || 'Choose a file', properties });
    if (r.canceled || !r.filePaths.length) return { ok: true, result: null };   // a cancel isn't a failure
    return { ok: true, result: r.filePaths[0] };
  },
  'save-file': async ({ title, default_name: defaultName }) => {
    const r = await dialog.showSaveDialog({ title: title || 'Save file', defaultPath: defaultName || undefined });
    if (r.canceled || !r.filePath) return { ok: true, result: null };   // a cancel isn't a failure
    return { ok: true, result: r.filePath };
  },
  'reveal-path': async ({ path }) => {
    if (!path) return { ok: false, result: 'no path given' };
    shell.showItemInFolder(path);      // no error signal from Electron here — best-effort by design
    return { ok: true, result: true };
  },
  'open-path': async ({ path }) => {
    if (!path) return { ok: false, result: 'no path given' };
    const err = await shell.openPath(path);       // '' on success, an error string on failure
    if (err) return { ok: false, result: err };
    return { ok: true, result: true };
  },
  'clipboard-read': async () => ({ ok: true, result: clipboard.readText() || '' }),
  'clipboard-write': async ({ text }) => { clipboard.writeText(String(text || '')); return { ok: true, result: true }; },
  screenshot: async () => {
    // thumbnailSize also caps the capture resolution — keeps the PNG a few hundred KB, not tens of
    // MB, since it travels back as a base64 JSON field (see oceano/tools/desktop.py's decode side).
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
    if (!sources.length) return { ok: false, result: 'no screen sources available' };
    let primaryId;
    try { primaryId = String(screen.getPrimaryDisplay().id); } catch (_) { primaryId = null; }
    const src = (primaryId && sources.find((s) => String(s.display_id) === primaryId)) || sources[0];
    const img = src.thumbnail;
    if (!img || img.isEmpty()) {
      return { ok: false, result: "the screen capture came back empty — on macOS, grant Oceano Screen "
        + "Recording permission in System Settings → Privacy & Security, then try again" };
    }
    return { ok: true, result: img.toPNG().toString('base64') };
  },
};

// Starts the reconnecting SSE loop; returns a stop() function (unused today, but keeps this
// symmetric with the rest of the app's start/teardown style rather than a fire-and-forget global).
function start(oceano) {
  let stopped = false;
  let retryScheduled = false;
  loop();
  return () => { stopped = true; };

  function loop() {
    if (stopped) return;
    let buf = '';
    let req;
    try {
      req = net.request({ method: 'GET', url: oceano.baseUrl + '/api/desktop/stream', session: oceano.session, useSessionCookies: true });
    } catch (_) { retry(); return; }
    req.setHeader('Accept', 'text/event-stream');
    req.on('response', (res) => {
      if (res.statusCode !== 200) { res.on('data', () => {}); res.on('end', retry); return; }
      res.on('data', (chunk) => {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;      // ignore `:` keep-alive comments
            const s = line.slice(5).trim();
            if (!s) continue;
            let cmd; try { cmd = JSON.parse(s); } catch (_) { continue; }
            if (cmd && cmd.type === 'rpc') handle(cmd);
          }
        }
      });
      res.on('end', retry);
      res.on('error', retry);
    });
    req.on('error', retry);
    req.end();
  }

  function retry() {
    if (stopped || retryScheduled) return;               // one pending reconnect at a time
    retryScheduled = true;
    setTimeout(() => { retryScheduled = false; loop(); }, 4000);   // the daemon may just be restarting
  }

  async function handle(cmd) {
    const fn = HANDLERS[cmd.action];
    let ok = false, result = `unknown desktop action: ${cmd.action}`;
    if (fn) {
      try {
        const r = await fn(cmd);
        ok = r.ok; result = r.result;
      } catch (e) {
        ok = false; result = String((e && e.message) || e);
      }
    }
    oceano.request('POST', '/api/desktop/result', { id: cmd.id, ok, result }).catch(() => {});
  }
}

module.exports = { start };
