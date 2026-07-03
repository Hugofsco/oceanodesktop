'use strict';
// The single authenticated Oceano client. Runs in the Electron MAIN process and reaches the daemon
// over Electron's `net` bound to the shared `persist:oceano` session — so the cookie the SPA sets
// when you log in (in a window on the same partition) is sent automatically. No CORS, one auth spot.
const { net } = require('electron');

class OceanoClient {
  constructor(session, baseUrl) {
    this.session = session;
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
  }

  _url(path) { return this.baseUrl + path; }

  // Buffered JSON request. Never throws on HTTP status — resolves {status, json} so callers branch.
  request(method, path, body) {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = net.request({ method, url: this._url(path), session: this.session, useSessionCookies: true });
      } catch (e) { return reject(e); }
      req.setHeader('Accept', 'application/json');
      if (body !== undefined) req.setHeader('Content-Type', 'application/json');
      let data = '';
      req.on('response', (res) => {
        res.on('data', (c) => { data += c.toString(); });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch (_) { /* non-JSON body */ }
          resolve({ status: res.statusCode, json });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async me() {
    try {
      const { status, json } = await this.request('GET', '/api/me');
      return { authed: status === 200, user: json && json.user };
    } catch (_) { return { authed: false }; }
  }

  async jobs() {
    const { status, json } = await this.request('GET', '/api/jobs');
    return status === 200 ? json : null;
  }

  async mailAccounts() {
    const { status, json } = await this.request('GET', '/api/mail');
    return status === 200 ? json : null;
  }

  async mailUnreads(aid) {
    const { status, json } = await this.request('GET', '/api/mail/' + encodeURIComponent(aid) + '/unreads');
    return status === 200 ? json : null;
  }

  // Streams POST /api/chat. Parses the `data: {json}\n\n` SSE frames and calls onEvent(ev) per event.
  // Returns an abort() function. onEvent receives Oceano's raw event dicts (token/notice/done/error/…).
  chatStream(payload, onEvent) {
    let aborted = false;
    let doneSent = false;
    const done = () => { if (!doneSent) { doneSent = true; onEvent({ type: 'done' }); } };
    let req;
    try {
      req = net.request({ method: 'POST', url: this._url('/api/chat'), session: this.session, useSessionCookies: true });
    } catch (e) {
      onEvent({ type: 'error', message: String((e && e.message) || e) }); done();
      return () => {};
    }
    req.setHeader('Content-Type', 'application/json');
    let buf = '';
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        onEvent({ type: 'error', message: 'HTTP ' + res.statusCode + (res.statusCode === 401 ? ' — open the client and log in first' : '') });
        res.on('data', () => {}); res.on('end', done); return;
      }
      res.on('data', (chunk) => {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;              // ignore `:` keep-alive comments
            const s = line.slice(5).trim();
            if (!s) continue;
            let ev; try { ev = JSON.parse(s); } catch (_) { continue; }
            if (aborted) return;
            if (ev && ev.type === 'done') { done(); return; }
            onEvent(ev);
          }
        }
      });
      res.on('end', done);
      res.on('error', (e) => { onEvent({ type: 'error', message: String((e && e.message) || e) }); done(); });
    });
    req.on('error', (e) => { if (!aborted) { onEvent({ type: 'error', message: String((e && e.message) || e) }); done(); } });
    req.write(JSON.stringify(payload));
    req.end();
    return () => { aborted = true; try { req.abort(); } catch (_) {} };
  }
}

module.exports = OceanoClient;
