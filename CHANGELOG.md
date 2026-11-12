# Changelog

## 1.3.0

- Fix navigation waits to wait for a new document rather than the old page's
  `readyState`; accept `beforeunload` so navigation is not cancelled.
- Add in-flight locks for browser ensure/attach and avoid leaked CDP sockets.
- Only restart the daily profile when explicitly requested; live status/tabs are
  read-only and never kill or relaunch the user's browser.
- Stop redirecting daily-profile downloads into the bridge's private folder.
- Add `history`, `back`, `forward`, `reload [--hard]`, `window` bounds control,
  `frames`, and frame-scoped `eval`/`text`/`html`/`wait`.
- Fix tab targeting so a background `--tab` does not move the active pointer; refuse
  to close an unknown active tab.
- Remove `--remote-allow-origins=*`; keep Chromium's DevTools origin gate.
- UTF-8-safe request bodies, CLI-relative file path resolution, safe `type --clear`
  on number inputs, JPEG screenshot extensions, emulation restore, and tall-page caps.
- Refuse `cookies --clear` on the live profile without `--force`.
- Add a 30-scenario integration suite, a standalone fixture server, isolated
  profile/ports, and a Windows GitHub Actions workflow.
- Version 1.3.0.

## 1.2.0

- Add history navigation, window bounds, frame listing and frame-scoped operations.
- Add true `live restart`.
- Harden active-tab semantics and profile-scoped restarts.

## 1.1.0

- Initial public release. Zero-dependency CDP bridge with daily and automation
  profiles, tabs, DOM/input, screenshots/PDF, console/network, cookies/storage,
  dialogs, downloads and raw CDP.
