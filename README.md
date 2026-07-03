# Oceano Desktop

A native desktop **client** for the [Oceano](../Oceano) daemon. It builds *around* Oceano's
existing HTTP/SSE API and **never modifies Oceano** — the daemon stays the body, this is the
native client you reach it with.

## Platform support

| OS | Status |
|---|---|
| **Linux (Ubuntu / X11)** | ✅ Tested — runs. Full desktop-mode span via `_NET_WM_FULLSCREEN_MONITORS`. |
| **macOS** | ✅ Tested — runs. Multi-monitor desktop mode needs one system setting (see [macOS multi-display setup](#macos-multi-display-setup)). |
| **Windows** | ⏳ Not yet tested. Code path is in place (`spanWindows`); needs verification on a real Windows box. |

> Desktop mode's seamless multi-monitor span uses a different mechanism per OS. Linux/X11 is the
> reference implementation; macOS and Windows use a union-bounds window raised above the system
> chrome. On **Wayland** (even on Linux) the X11 span trick does not apply.

## Features

Five surfaces, all driven by one authenticated main process:

| Surface | What it does |
|---|---|
| **Full client** | An Electron window loading Oceano's SPA at `:8800` — every built-in app comes for free. **This is where you log in**, which seeds the shared session cookie the other surfaces reuse. |
| **Tray** | Tray icon (drawn at runtime — no asset file) with a context menu: *Open Oceano client · Quick chat · Full desktop mode · Quit*. Global shortcuts are the reliable triggers on Linux (see the tray note below). |
| **Quick chat** | A frameless popover that streams `POST /api/chat` — ask something without opening the whole client. Toggle with `Ctrl+Shift+Space` or the tray. Stops in-flight generation on close / new prompt. |
| **Floating notifications** | Transparent toast cards, bottom-right, for background **job start/finish** (polls `/api/jobs` and diffs the registry) and **new mail** (polls `/api/mail` unread deltas). Each source is independently toggleable in `config.json`. Clicking a toast opens the full client. |
| **Full desktop mode** | **One** Oceano window fullscreen across **all** monitors (`Ctrl+Shift+D` toggles). The SPA's chat + sidebar (and every viewport-anchored overlay — modals, confirm/prompt, toasts, login gate, Settings drawer) is pinned to the **primary** monitor via a view-time CSS override, leaving the other screen(s) as free space to drag Oceano's floating apps onto. Snapping is **monitor-aware**: edge-drag zones, the ▢ maximize button, title double-click, and agent `ui_arrange` all fit the monitor the window is on. Oceano's files are never modified. A click-through exit hint sits centered on the primary monitor. |

## Native action bridge

The other four surfaces are *windows*; this one is a capability. Every request this app makes to
Oceano — full client, quick chat, and the main process's own polling alike — is tagged
`X-Oceano-Client: desktop`, so when you're chatting through this app (never a plain browser tab)
Oceano's agent can reach real native actions on your actual computer:

| Tool | What it does |
|---|---|
| `desktop_notify` | Shows a native OS notification. |
| `desktop_pick_file` / `desktop_save_file` | Native open/save dialogs — returns the REAL absolute path, not a sandboxed browser upload. |
| `desktop_reveal_path` / `desktop_open_path` | Reveals a path in your file manager, or opens it with its default app. |
| `desktop_clipboard_read` / `desktop_clipboard_write` | Reads or writes your clipboard. |
| `desktop_screenshot` | Captures what's actually on your screen (not a browsed page) into the workspace, so it renders inline in chat. |

Two gates, both enforced daemon-side (`oceano/tools/desktop.py`): the client tag above (so a
browser tab never gets these), and the same taint check `ssh_run`/`mail_send` use — every one of
these is blocked for the rest of a turn that already read untrusted content (a web page, email, or
document), so an injected instruction can never trigger a native action on your real computer.
`desktop_clipboard_read` is the one exception: reading isn't destructive, so it's allowed even
mid-tainted-turn, but its own result taints the turn going forward the same way `mail_read` does.

`desktop_screenshot` needs Screen Recording permission on macOS (System Settings → Privacy &
Security) on first use, prompted automatically; Linux and Windows need no extra setup.

## Architecture

The **main process is the only thing that talks to Oceano.** It holds the session cookie from a
shared `persist:oceano` Electron partition (set when you log in via the full client) and does all
HTTP/SSE through Electron's `net`. Every window is dumb UI over IPC — no CORS, one auth spot.

```
 tray / quick-chat / notifications / desktop overlay   (renderers, IPC only)
                        │
                    main.js  ──  OceanoClient (net + persist:oceano cookie)
                        │
                 Oceano daemon  http://127.0.0.1:8800   (untouched)
```

The native action bridge runs the other direction: `desktopRpc.js` holds `/api/desktop/stream`
open on that same session, and the daemon pushes it a command whenever the agent calls a
`desktop_*` tool — the main process runs the real native action and posts the result back.

- `src/main.js` — windows, tray, shortcuts, pollers, notifications, IPC, per-OS desktop-mode span.
- `src/oceano.js` — the authenticated client (`/api/me`, `/api/chat` stream, `/api/jobs`, `/api/mail`).
- `src/desktopRpc.js` — the native action bridge: reconnecting client for `/api/desktop/stream`,
  runs `Notification` / `dialog` / `clipboard` / `shell` / `desktopCapturer`, posts results to
  `/api/desktop/result`.
- `src/preload/*` — thin contextBridge shims per window.
- `src/windows/*` — quick-chat + notification UIs (abyssal theme).
- `src/trayIcon.js` — the tray icon, generated at runtime as a `nativeImage`.
- `build/make-icon.js` — regenerates `build/icon.png` (the app/launcher icon) with `npm run icon`.
- `config.json` — daemon URL, poll intervals, shortcuts.

## Run (development)

```bash
npm install          # pulls Electron (deps are pure-JS; no native build)
npm start            # electron . --no-sandbox
```

On first launch the full client opens — **log in** (admin / your password). That seeds the cookie the
tray chat and notifications reuse. Then:

- **Quick chat**: `Ctrl+Shift+Space` (or the tray).
- **Full desktop mode**: `Ctrl+Shift+D` (toggles; also an "⤢ Exit desktop mode" button in the overlay).

> **Linux tray note:** single/double-click on the tray icon isn't delivered by every desktop's tray
> implementation. The **context menu** and the **global shortcuts** are the reliable triggers.

## Build installers

Packaging is handled by [electron-builder](https://www.electron.build/). Icons are auto-derived from
`build/icon.png`.

```bash
npm run dist:linux    # → release/*.AppImage  and  release/*.deb
npm run dist:mac      # → release/*.dmg  and  release/*-mac.zip   (must run ON macOS)
npm run dist:win      # → release/*.exe (NSIS)                    (best run on Windows / CI)
npm run dist          # current OS
```

Notes:
- **macOS builds must run on a Mac** — the `.dmg` step uses macOS-only tools (`sips`, `hdiutil`).
  If you don't have an Apple Developer certificate, use `npm run dist:mac:unsigned` to skip code
  signing. Unsigned apps need a Gatekeeper bypass on first launch:
  right-click the app → **Open** → **Open**, or `xattr -dr com.apple.quarantine /Applications/Oceano.app`.
- **Windows** installers can be produced on Windows, or on Linux via wine / CI (GitHub Actions).
- `release/` and `node_modules/` are git-ignored — they are build output, never committed.

## macOS multi-display setup

Full desktop mode spans **one** window across every monitor. macOS constrains this in two ways, so
two things must be true:

1. **The window may exceed a single display.** Handled in code (`enableLargerThanScreen: true`) — no
   action needed.
2. **"Displays have separate Spaces" must be OFF.** This is a macOS setting, ON by default. While it
   is on, macOS locks every window to a single display's Space and *no* single window can span two
   monitors — this cannot be overridden from the app.

   To turn it off:
   **System Settings → Desktop & Dock → Mission Control → uncheck "Displays have separate Spaces"**,
   then **log out and back in** for it to take effect.

With that off, toggling desktop mode (`Ctrl+Shift+D`) stretches the Oceano canvas across all
displays, above the menu bar and Dock, matching the Linux behavior.

## Config (`config.json`)

| Key | Default | Meaning |
|---|---|---|
| `oceanoUrl` | `http://127.0.0.1:8800` | daemon base URL (point at a Tailscale IP for remote) |
| `pollMs` | `3000` | job-registry poll interval |
| `mailPollMs` | `60000` | mail unread poll interval (IMAP-backed — kept slow) |
| `notifyJobs` / `notifyMail` | `true` | toggle each notification source |
| `quickChatShortcut` | `Control+Shift+Space` | global toggle |
| `desktopModeShortcut` | `Control+Shift+D` | global toggle |

## Deliberately deferred (next milestones)

- **Windows testing** — the `spanWindows` path is written but unverified on real hardware.
- **Live Browser audio** — built (null sink → ffmpeg Opus/Ogg → `/api/browser/audio` → client
  `<audio>`), worked, and was **removed by choice**: progressive HTTP audio buffers seconds, and
  multi-second lag behind the video frames made it useless in practice. If ever revisited, the
  transport must be **WebRTC** (like neko does) — sub-second, but a much bigger build.
- **Non-side-by-side monitor layouts** — the chat-pinning CSS assumes the app chrome fits the
  primary display width; stacked / mixed-DPI arrangements may need the injected `.shell` rule tuned.
- **Geometry saved on a secondary screen** — a floating window left at e.g. x=2500 in desktop mode
  reopens at those raw coordinates in the normal (one-monitor) client, i.e. off-screen until moved
  back. A restore-clamp is a follow-up.
- **Native window intents driven by `ui_arrange`** — snap/arrange *real* OS windows, not just
  Oceano's own (basic native-app integration now exists: `desktop_open_path`/`desktop_reveal_path`
  open/reveal a file with its default app).
- Code signing / notarization, auto-update.

## License

MIT
