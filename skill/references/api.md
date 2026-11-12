# dshedge reference

Complete command, flag and HTTP API reference for the DSH Edge bridge.

## Architecture

```
DSH agent / user
      │  dshedge CLI  (Node, zero deps)
      ▼
bridge daemon  127.0.0.1:9333   token auth
      │  Chrome DevTools Protocol over WebSocket
      ├── automation Edge  127.0.0.1:9334  ~/.dsh/browser/edge-profile
      └── daily Edge       127.0.0.1:9449  ~/.dsh/browser/edge-daily
```

- The bridge is lazy-started by any CLI command and stays resident.
- `live` commands target the daily profile on 9449; commands without `live` target
  the automation profile on 9334.
- If Edge is already running with the matching CDP port, the bridge attaches.
- Each tab gets its own CDP WebSocket; console and network events are buffered per tab.
- The CLI talks JSON over HTTP to the bridge; every response is `{ok:true,...}` or
  `{ok:false,error:{message,code}}`.

## Lifecycle

| Command | Meaning |
| --- | --- |
| `dshedge live ensure` | Start bridge + daily Edge if needed; attach if already running |
| `dshedge live status` | Daily Edge CDP status and tabs (read-only) |
| `dshedge live tabs` | List daily Edge tabs |
| `dshedge start [url] [--headless]` | Start automation Edge; navigate if url given |
| `dshedge status` | Bridge, automation Edge and daily live status |
| `dshedge stop` | Stop bridge, leave Edge and tabs open |
| `dshedge stop --edge` / `--all` | Also close the automation Edge |
| `dshedge profile [--open]` | Print the automation profile path |
| `dshedge version` | CLI version |

Ports and paths can be overridden with `DSH_EDGE_BRIDGE_PORT`,
`DSH_EDGE_CDP_PORT`, `DSH_EDGE_DATA`, `DSH_EDGE_PATH`.

## Tabs

```
dshedge tabs
dshedge new <url>
dshedge activate <tab>
dshedge close <tab>
```

`<tab>` accepts a full target id, an index from `tabs`, a URL/title substring, or
`active`. Every page command accepts `--tab`.

## Page

| Command | Notes |
| --- | --- |
| `open <url>` | Wait for `readyState=complete`; `--no-wait` to skip |
| `eval "<expr>"` | Awaits promises by default; `--no-await` to disable |
| `eval --file script.js` | Read the expression from a file (`-` = stdin) |
| `text [selector]` | `innerText` of body or element |
| `html [selector]` | `outerHTML`; `--inner` for innerHTML |
| `snapshot` | Accessibility tree, one node per line, deduplicated |
| `shot [path] [--full] [--selector sel]` | PNG/JPEG screenshot |
| `pdf [path]` | `Page.printToPDF` |
| `devtools [tab] [--open]` | Local DevTools frontend URL |

Screenshots without a path land in `~/.dsh/browser/screenshots/shot-<iso>.png`.
`--format jpeg --quality 80` produces JPEG.

## Input

| Command | Notes |
| --- | --- |
| `click <selector>` | Scrolls into view, checks coverage, dispatches real mouse events |
| `click --x 100 --y 200` | Raw coordinates |
| `click --force <sel>` | `element.click()` fallback for covered elements |
| `type <selector> <text>` | Focus + `Input.insertText`; `--clear`, `--submit`, `--delay ms` |
| `press "<combo>"` | `Control+a`, `Shift+Tab`, `Enter`, `F5`, `PageDown`, … |
| `hover <selector>` | Mouse move |
| `scroll [--dy 600] [--dx 0] [--selector sel]` | Wheel event |
| `wait <selector>` or `--fn "<expr>"` | Poll until truthy; `--timeout ms` |
| `upload <selector> <file...>` | `DOM.setFileInputFiles` |

`click` returns `{element:{tag,id,cls,text,x,y,w,h,visible,covered}}` and
`dialogPending:true` if a JavaScript dialog opened.

## Debugging

| Command | Notes |
| --- | --- |
| `console [--clear] [--level error] [--filter s]` | Console, exceptions and `Log` entries |
| `net [--clear] [--filter s] [--failed-only]` | Requests with status/type/size |
| `body <requestId>` | `Network.getResponseBody` |
| `cdp <Method> '<json>'` | Raw CDP on the current tab |
| `cdp ... --tab browser` | Browser-domain command |
| `cdp ... --session <id>` | OOPIF / worker session |
| `devtools --open` | Open the same tab in DevTools |

Useful raw CDP starting points:

```
dshedge cdp Network.setBlockedURLs '{"urls":["*.png","*.jpg"]}'
dshedge cdp Network.setCacheDisabled '{"cacheDisabled":true}'
dshedge cdp Emulation.setDeviceMetricsOverride '{"width":390,"height":844,"deviceScaleFactor":3,"mobile":true}'
dshedge cdp Performance.getMetrics
dshedge cdp Tracing.start '{"categories":["devtools.timeline"],"transferMode":"ReturnAsStream"}'
dshedge cdp Runtime.evaluate '{"expression":"JSON.stringify(performance.timing)","returnByValue":true}'
dshedge cdp Target.getTargets --tab browser
```

## State

```
dshedge cookies [--url <u>] [--set name=value] [--domain d] [--path /] [--secure] [--http-only] [--same-site Lax]
dshedge cookies --clear
dshedge storage [--area local|session] [--get key] [--set key=value] [--remove key] [--clear]
dshedge dialog [--accept|--dismiss] [--text prompt]
dshedge dialog-policy accept|dismiss|manual
dshedge emulate [--offline] [--latency 200] [--download 500] [--upload 200] [--width 390 --height 844 --mobile] [--ua "..."] [--reset]
dshedge downloads
```

Dialog policy defaults to `dismiss` (a dialog never blocks the bridge). With
`manual`, a click that opens a dialog returns `dialogPending` and later page
commands fail until `dshedge dialog --accept|--dismiss` is run. `accept` auto-accepts
every dialog.

## HTTP API

All POST endpoints require `x-dsh-token` from `~/.dsh/browser/state.json`.
`GET /health` is unauthenticated and returns bridge/Edge status.

Page endpoints accept `{live:true}` to target the daily profile instead of the
automation profile. The CLI adds this automatically for `dshedge live ...`.

| Endpoint | Body (important fields) |
| --- | --- |
| `POST /live/ensure` | `{}` — start/attach daily Edge |
| `POST /live/restart` | `{}` — restart only the daily Edge profile |
| `POST /live/status` | `{}` — daily Edge status/tabs (read-only) |
| `POST /ensure` | `{headless?, url?}` |
| `POST /tabs` | `{}` or `{live:true}` |
| `POST /tabs/new` | `{url, active?}` or `{live:true, url, active?}` |
| `POST /tabs/activate` | `{tab}` |
| `POST /tabs/close` | `{tab}` |
| `POST /navigate` | `{tab?, url, wait?, timeout?}` |
| `POST /back` / `/forward` | `{tab?, wait?, timeout?}` |
| `POST /reload` | `{tab?, ignoreCache?, wait?, timeout?}` |
| `POST /history` | `{tab?}` |
| `POST /window` | `{tab?, action?, left?, top?, width?, height?}` |
| `POST /frames` | `{tab?}` |
| `POST /eval` | `{tab?, expression, awaitPromise?, timeout?, frame?}` |
| `POST /screenshot` | `{tab?, file?, fullPage?, selector?, format?, quality?}` |
| `POST /click` | `{tab?, selector?, x?, y?, button?, count?, force?}` |
| `POST /type` | `{tab?, selector?, text, clear?, submit?, delay?}` |
| `POST /press` | `{tab?, keys}` |
| `POST /hover` | `{tab?, selector?, x?, y?}` |
| `POST /scroll` | `{tab?, selector?, x?, y?, deltaX?, deltaY?}` |
| `POST /wait` | `{tab?, selector?, fn?, timeout?}` |
| `POST /html` | `{tab?, selector?, outer?}` |
| `POST /text` | `{tab?, selector?}` |
| `POST /snapshot` | `{tab?, maxNodes?}` |
| `POST /console` | `{tab?, clear?, level?, filter?}` |
| `POST /network` | `{tab?, clear?, filter?, failedOnly?}` |
| `POST /network/body` | `{tab?, requestId}` |
| `POST /cookies` | `{tab?, action:"get|set|clear", cookie?, urls?, force?}` |
| `POST /storage` | `{tab?, area?, action:"get|set|remove|clear", key?, value?}` |
| `POST /upload` | `{tab?, selector, files:[]}` |
| `POST /pdf` | `{tab?, file?, landscape?}` |
| `POST /dialog` | `{tab?, accept?, promptText?, policy?}` |
| `POST /dialog/policy` | `{tab?, policy}` |
| `POST /emulate` | `{tab?, offline?, latency?, downloadKbps?, uploadKbps?, width?, height?, mobile?, userAgent?, reset?}` |
| `POST /devtools` | `{tab?}` |
| `POST /downloads` | `{}` or `{live:true}` — live is `managed:false` and leaves daily downloads alone |
| `POST /cdp` | `{tab?: "browser"|id, method, params, sessionId?}` |
| `POST /shutdown` | `{closeEdge?}` |

## Selector semantics

`selectorExpression()` in `page.mjs` compiles:

- `text=Foo` — exact `innerText` match, then shortest containing element
- `xpath=//...` — `document.evaluate`
- `a >>> b` — `a.querySelector`, then `shadowRoot.querySelector("b")`
- anything else — `document.querySelector`

Coordinates are CSS pixels relative to the viewport. `elementFromPoint` runs in the
element's root node, so shadow DOM coverage checks work.

## Files and logs

```
~/.dsh/browser/
├── app/                bridge.mjs, page.mjs, cdp.mjs, cli.mjs
├── edge-daily/         persistent daily profile used by live
├── edge-profile/       automation Edge profile (private)
├── screenshots/
├── downloads/
├── logs/bridge.log
└── state.json          {pid, port, cdpPort, token, profile}
```

Log rotation keeps one previous file at 5 MB. `state.json` is rewritten on every
bridge start; deleting it is safe while the bridge is stopped.

## Limitations

- Chrome/Edge 136+ refuse `--remote-debugging-port` on the **default** user-data-dir.
  The bridge therefore uses its own profile. Sign in once (or let Edge sync), and
  all future sessions keep those logins.
- `edge://` pages, the Web Store and some PDF viewer internals expose no debuggable
  target. Use raw CDP or a normal page instead.
- OOPIF/worker automation beyond `Runtime.evaluate` needs
  `Target.setAutoAttach`/`sessionId` via `cdp`.
- File pickers opened by the OS (not `<input type=file>`) cannot be driven; set the
  input directly with `upload`.
- Native dialogs (print, save-as) are outside CDP. Downloads are handled by
  `Browser.setDownloadBehavior`.
