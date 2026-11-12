---
name: edge-browser
description: >
  Control and debug the user's Microsoft Edge browser through a local CDP bridge:
  navigate sites, click, type, fill forms, upload files, take screenshots or PDFs,
  read DOM/text/accessibility tree, inspect console and network traffic, emulate
  devices or offline, and run raw Chrome DevTools Protocol. Use for any request to
  browse a site, test or debug a web app, automate a logged-in workflow, scrape a
  rendered page, watch browser console/network, or "接管/调试我的浏览器". Also use
  when a page should be opened visibly for the user.
---

# Edge browser control

`dshedge` drives one persistent, visible Edge instance over CDP. The bridge is a
zero-dependency Node daemon; the Edge profile keeps its cookies and logins, so
authenticated sites usually work without re-login.

Runtime layout:

| Path | Purpose |
| --- | --- |
| `~/.dsh/browser/app/cli.mjs` | CLI source (this skill's entry point) |
| `~/.dsh/browser/app/bridge.mjs` | CDP bridge daemon |
| `~/.dsh/browser/edge-daily` | persistent daily profile used by `live` |
| `~/.dsh/browser/edge-profile` | separate automation profile used by non-live commands |
| `~/.dsh/browser/screenshots` | default screenshots |
| `~/.dsh/browser/downloads` | browser downloads |
| `~/.dsh/browser/logs/bridge.log` | bridge log |

`dshedge` is on PATH. If it is not, run
`node "$env:USERPROFILE\.dsh\browser\app\cli.mjs"` with the same arguments.

## First move

For the user's daily browser (the default for user-facing browser tasks):

```powershell
dshedge live ensure     # starts bridge + daily Edge if needed
dshedge live tabs
```

Do not start by launching Edge manually. `live ensure` attaches if the daily Edge is
already running with CDP; otherwise it restarts the same daily profile with
`--restore-last-session`.

For the separate automation profile, use `dshedge status` then `dshedge start`; this
does not touch the daily browser.

This setup is the agent's job, not the user's. Never ask the user to run `dshedge`,
start Edge, or follow any setup step; perform `live ensure` yourself and continue with
the task.

Do not launch Edge yourself with either profile, and do not start a second bridge.
One Edge, one bridge, many tabs.

## Live mode: the daily Edge profile

`dshedge live` controls the persistent profile at `~/.dsh/browser/edge-daily` on
port 9449. The profile is created on first use and keeps its own cookies, logins and
extensions. The bridge never rewrites the profile path after creation, because Edge
binds extension and sign-in settings to that path. No junction and no
`--load-extension` are used.

```powershell
dshedge live ensure            # ensure daily Edge is running with CDP
dshedge live status            # connected? which tabs?
dshedge live tabs
dshedge live eval "document.title" --tab "example.com"
dshedge live click "text=登录"
dshedge live type "#q" "hello" --clear
dshedge live shot C:\temp\live.png
```

- `live ensure` / any live page command may **restart the daily Edge** when it is
  running without CDP. It closes only Edge windows using the daily profile; other
  Edge profiles are left alone. The restart uses `--restore-last-session`; warn the
  user before running it if they have unsaved form input.
- Live mode is the same CDP surface as the automation profile: tabs, DOM, input,
  console, network, screenshots, raw `cdp`.
- `dshedge stop --all` closes only the automation Edge; the daily Edge is untouched.
- `edge://` pages are debuggable in live mode because the browser itself was started
  with CDP.
- Never change `--user-data-dir` on a profile that already has extensions or a
  signed-in account. Edge binds those settings to the profile path; changing it makes
  Edge treat them as tampered and clear them. The original default profile was damaged
  this way and is kept only as a backup.

## Core loop

Daily browser commands are shown with `live`; drop `live` to target the separate
automation profile.

1. **Open** — `dshedge live open <url>` (active tab) or `dshedge live new <url>`.
2. **Observe** — `dshedge live snapshot` for structure, `text` for prose, `shot` for pixels.
3. **Act** — `dshedge live click`, `type`, `press`, `upload`, `scroll`.
4. **Verify** — `dshedge live eval`, `text`, `wait`, `shot`.
5. **Debug** — `dshedge live console`, `net`, `cdp`.

For dynamic pages: `dshedge wait "<selector>"` or
`dshedge wait --fn "document.querySelector('#done') !== null"` before acting.
After any visual change, take a screenshot and look at it; do not assume the click
worked because the command returned `ok`.

## Commands

Prefix each command with `live` to target the daily browser (for example
`dshedge live eval ...`). Without `live`, the command targets the automation profile.

| Task | Command |
| --- | --- |
| Start / stop | `dshedge start [url]`, `dshedge stop [--edge]` |
| Tabs | `dshedge tabs`, `new <url>`, `activate <tab>`, `close [tab]` |
| Navigate | `dshedge open <url>` (alias `goto`) |
| JavaScript | `dshedge eval "<expr>"`, `--file script.js` |
| Read page | `dshedge snapshot`, `text [sel]`, `html [sel]` |
| Screenshot | `dshedge shot [path] [--full] [--selector sel]` |
| Click | `dshedge click "<selector>"` (or `--x/--y`) |
| Type | `dshedge type "<selector>" "<text>" [--clear] [--submit]` |
| Keys | `dshedge press "Control+a"`, `press "Enter"` |
| Wait | `dshedge wait "<selector>"`, `wait --fn "<expr>"` |
| Console | `dshedge console [--clear] [--level error]` |
| Network | `dshedge net [--clear] [--filter api]`, `body <requestId>` |
| Raw CDP | `dshedge cdp Page.navigate '{"url":"..."}'` |
| DevTools | `dshedge devtools --open` |
| State | `cookies`, `storage`, `dialog`, `downloads`, `pdf` |

Target a specific tab with `--tab <id|url-substring|title-substring|index>`. Prefer a
URL substring or a full tab id: the numeric index is positional and shifts when tabs
are opened or closed. Add `--json` to any command for a machine-readable envelope.
For multi-line JS or expressions containing shell metacharacters, use
`dshedge live eval --file script.js` (or `--file -` for stdin).

## Selectors

Resolution order, in one string:

- CSS: `#id`, `.class`, `[data-testid=...]`
- Text: `text=Sign in` (exact, then shortest containing element)
- XPath: `xpath=//button[contains(., "Save")]`
- Shadow DOM: `my-app >>> button.primary`

Prefer `text=` or role-like attributes over brittle nth-child chains. If an element
is covered by an overlay, `click` reports `covered`; use `--force` only when the
overlay is decorative, otherwise close the overlay first.

## Debugging a web app

1. `dshedge live console --clear` and `dshedge live net --clear`.
2. Reproduce the flow with `dshedge live click` / `type` / `open`.
3. `dshedge live console` for errors; `dshedge live net --failed-only` for failed requests.
4. `dshedge live body <requestId>` for a response payload.
5. For anything the CLI does not wrap, use raw CDP:
   `dshedge live cdp Network.setBlockedURLs '{"urls":["*.png"]}'`.
   Browser-level domains (`Target`, `Browser`, `Storage`) use `--tab browser`, e.g.
   `dshedge live cdp Target.getTargets --tab browser`.
6. `dshedge live devtools --open` shows the same tab in Edge DevTools for manual inspection.

Console and network buffers are in-memory per tab, capped at a few thousand entries,
and survive bridge restarts only as long as the bridge process lives. Clear before a
reproduction to keep signal high.

## Safety

- The daily and automation profiles contain the user's login state, cookies,
  extensions and sessions. Treat everything in them as private.
- Confirm before irreversible actions: payments, posting, sending messages, deleting
  data, changing account settings.
- Do not read cookies, stored passwords, or localStorage unless the task requires it.
- The bridge binds to `127.0.0.1` and requires a per-run token from
  `~/.dsh/browser/state.json`; live CDP on port 9449 has no token. Never expose either
  port; any local process that can reach 9449 controls the daily Edge.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `bridge did not start` | Read `~/.dsh/browser/logs/bridge.log`; check port 9333 |
| Edge is running but no CDP | `dshedge stop --all`, then `dshedge start` |
| `a JavaScript dialog is open` | `dshedge dialog --accept` or `--dismiss` |
| Click hits an overlay | `dshedge click --force "<sel>"` or close the overlay |
| Screenshot is blank | `dshedge activate <tab>` first; wait for `wait --fn "document.readyState==='complete'"` |
| 401 from bridge | `dshedge stop` then retry; state token rotated |
| `daily Edge: not connected` | `dshedge live ensure` (may restart Edge) |
| `live ensure` cannot open port 9449 | Close all Edge windows; then `dshedge live ensure` |

Full command, flag and HTTP API reference: `references/api.md`.

