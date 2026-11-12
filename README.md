# DSH Edge Bridge

A zero-dependency Node.js bridge that lets DSH (or any local agent) drive Microsoft
Edge over the Chrome DevTools Protocol. It supports two isolated profiles:

- **daily** — the browser the user actually browses in, exposed on CDP port `9449`
- **automation** — a separate profile for scripted jobs, exposed on CDP port `9334`

The bridge owns the CDP connection, tab lifecycle, console/network buffers,
screenshots, input, cookies/storage and a raw CDP passthrough. The CLI is a thin
client over a local, token-authenticated HTTP API.

## Features

- Zero npm dependencies (Node 22+ built-in `fetch` and `WebSocket`)
- Persistent, visible Edge instance; survives CLI invocations and DSH restarts
- Two profile backends: daily browser and automation profile
- Real mouse/key input, DOM/JS evaluation, accessibility tree, text/HTML
- Screenshots (viewport, element, full page), PDF, uploads, downloads
- Console, exceptions, network requests and response bodies
- Cookies, localStorage/sessionStorage, dialogs, device/network emulation
- Raw CDP passthrough for anything not wrapped
- Local-only HTTP API with a per-run token
- Windows 10/11, Microsoft Edge

## Requirements

- Windows 10/11
- Microsoft Edge (stable)
- Node.js 22 or newer (`node --version`)

## Install

```powershell
git clone https://github.com/sanxiadaba/dsh-edge-bridge.git
cd dsh-edge-bridge
.\scripts\install.ps1
```

The installer copies the runtime to `%USERPROFILE%\.dsh\browser\app`, installs the
`edge-browser` skill to `%USERPROFILE%\.dsh\skills\edge-browser`, and creates
`dshedge.cmd` / `dshedge.ps1` in `%APPDATA%\npm`.

For a manual install, copy `app\` and `skill\edge-browser\` to those locations and put
this on PATH:

```powershell
node "$env:USERPROFILE\.dsh\browser\app\cli.mjs" status
```

## Quick start

```powershell
dshedge live ensure          # start/attach the persistent daily Edge
dshedge live restart         # if the daily browser is stuck
dshedge live tabs
dshedge live open https://example.com
dshedge live snapshot
dshedge live shot C:\temp\page.png --full
```

For the separate automation profile:

```powershell
dshedge status
dshedge start
dshedge open https://example.com
```

## Architecture

```
CLI / agent
    │  JSON over HTTP, 127.0.0.1:9333 (token auth)
    ▼
bridge daemon
    │  Chrome DevTools Protocol over WebSocket
    ├── automation Edge   127.0.0.1:9334   ~/.dsh/browser/edge-profile
    └── daily Edge        127.0.0.1:9449   ~/.dsh/browser/edge-daily
```

Why the two profiles: Chromium/Edge 136+ refuse `--remote-debugging-port` when
`--user-data-dir` is the default Edge profile. A dedicated, path-stable profile avoids
that restriction and keeps automation away from the user's normal browser state.
Never change `--user-data-dir` on an existing profile: Edge binds extension and
sign-in settings to that path and will invalidate them when it changes.

## Command overview

| Task | Command |
| --- | --- |
| Daily browser | prefix any page command with `live` |
| Start / status | `dshedge live ensure`, `dshedge status` |
| Tabs | `tabs`, `new <url>`, `activate <tab>`, `close [tab]` |
| Navigate | `open <url>` |
| JavaScript | `eval "<expr>"`, `--file script.js` |
| Read | `snapshot`, `text [sel]`, `html [sel]` |
| Screenshot / PDF | `shot [path] [--full]`, `pdf [path]` |
| Input | `click`, `type`, `press`, `hover`, `scroll`, `upload` |
| Debug | `console`, `net`, `body <requestId>`, `cdp <Method> '<json>'` |
| State | `cookies`, `storage`, `dialog`, `downloads`, `emulate` |

Run `dshedge help` for the full command list and `skill/references/api.md` for the
HTTP API.

### Selectors

- CSS: `#id`, `.class`, `[data-testid=...]`
- Text: `text=Sign in`
- XPath: `xpath=//button[contains(., "Save")]`
- Shadow DOM: `my-app >>> button.primary`

Prefer URL substrings or full tab ids for `--tab`; numeric indexes shift when tabs
open or close.

## Security

- The bridge binds to `127.0.0.1` and requires `x-dsh-token` from
  `~/.dsh/browser/state.json`.
- The daily CDP port `9449` is local but has **no authentication**. Any local process
  that can reach it can control the daily browser. Do not expose or forward it.
- Profiles contain cookies, sessions and potentially saved passwords. Treat them as
  private and keep this tool on a trusted machine.
- `live ensure` may restart the daily Edge to acquire CDP, using
  `--restore-last-session`. It closes only windows using the daily profile; other
  Edge profiles are left alone. Save unsaved form input before running it.
- `stop --all` closes the automation Edge only, not the daily browser.

## Limitations

- Windows only (Edge discovery and process management are Windows-specific).
- One Edge instance per profile; the port must be free.
- Page helpers (`eval`, `click`, `text`, ...) operate on the top frame. Use raw
  browser-level CDP (`--tab browser`) with `Target` sessions for OOPIF, iframe
  internals or service workers.
- The CLI remembers tabs it activated or opened. If you switch tabs manually, use a
  URL substring or full tab id instead of `--tab active`.
- `chrome-extension://` and `edge://` targets may be restricted by Edge regardless of
  this tool.
- This is a local developer tool, not a hardened multi-user service.

## Development

```powershell
node --check app\bridge.mjs
node --check app\page.mjs
node --check app\cdp.mjs
node --check app\cli.mjs
```

The bridge is intentionally dependency-free. `app/cdp.mjs` is a small CDP client over
Node's global `WebSocket`; `app/page.mjs` contains page-level actions; `app/bridge.mjs`
owns Edge lifecycle and the HTTP server; `app/cli.mjs` is the user-facing client.

## License

MIT. See [LICENSE](LICENSE).
