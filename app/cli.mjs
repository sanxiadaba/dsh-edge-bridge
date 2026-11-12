#!/usr/bin/env node
// dshedge — command line for the DSH Edge bridge.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, 'bridge.mjs');
const HOME = os.homedir();
const DATA_DIR = process.env.DSH_EDGE_DATA || path.join(HOME, '.dsh', 'browser');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const EXT_DIR = path.join(DATA_DIR, 'extension');
const EXT_TOKEN_FILE = path.join(DATA_DIR, 'extension-token');
const DEFAULT_PORT = Number(process.env.DSH_EDGE_BRIDGE_PORT || 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BOOL_FLAGS = new Set([
  'json',
  'full',
  'clear',
  'headless',
  'new',
  'edge',
  'all',
  'open',
  'accept',
  'dismiss',
  'reset',
  'mobile',
  'http-only',
  'secure',
  'no-wait',
  'outer',
  'failed-only',
  'help',
  'verbose',
  'force',
  'submit',
  'inner',
  'landscape',
  'no-await',
  'offline',
  'live',
  'no-shortcuts',
]);

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      pos.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    let name;
    let value;
    if (eq !== -1) {
      name = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      name = arg.slice(2);
      const next = argv[i + 1];
      if (!BOOL_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) {
        value = next;
        i++;
      } else {
        value = true;
      }
    }
    if (Object.prototype.hasOwnProperty.call(flags, name)) {
      flags[name] = Array.isArray(flags[name]) ? [...flags[name], value] : [flags[name], value];
    } else {
      flags[name] = value;
    }
  }
  return { flags, pos };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.ok ? data : null;
  } catch {
    return null;
  }
}

async function ensureBridge() {
  const state = readState();
  if (state?.port && (await health(state.port))) return state;

  const child = spawn(process.execPath, [BRIDGE, '--serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(150);
    const fresh = readState();
    if (fresh?.port && (await health(fresh.port))) return fresh;
  }
  throw new Error(
    `bridge did not start on port ${DEFAULT_PORT}. Check ${path.join(DATA_DIR, 'logs', 'bridge.log')} ` +
      'or run "dshedge status".',
  );
}

async function rawCall(state, pathname, body = {}, timeout = 180000) {
  const res = await fetch(`http://127.0.0.1:${state.port}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dsh-token': state.token,
      'x-dsh-bridge': '1',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data?.error?.message || `HTTP ${res.status}`);
  }
  return data;
}

async function call(pathname, body = {}, flags = {}) {
  if (flags.live && !pathname.startsWith('/ext') && pathname !== '/ensure' && pathname !== '/shutdown') {
    body.live = true;
    if (flags.browser) body.browser = String(flags.browser);
  }
  const state = await ensureBridge();
  return rawCall(state, pathname, body, Number(flags.timeout || 180000));
}

function emit(flags, data, human) {
  if (flags.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  if (human) human(data);
}

function clip(text, n) {
  const s = String(text ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function fmtTime(at) {
  if (!at) return '';
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function printTabs(tabs) {
  if (!tabs.length) {
    process.stdout.write('(no tabs)\n');
    return;
  }
  for (const t of tabs) {
    const mark = `${t.active ? '*' : ' '}${t.attached ? '+' : ' '}`;
    const id = String(t.id).includes(':') ? t.id : String(t.id).slice(0, 8);
    process.stdout.write(`${mark} ${t.index}  ${id}  ${clip(t.title || '(untitled)', 60)}  ${clip(t.url, 110)}\n`);
  }
}

function openPath(target) {
  try {
    spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* ignore */
  }
}

function openUrl(url) {
  try {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* ignore */
  }
}

function killAutomationEdge() {
  const profile = path.join(DATA_DIR, 'edge-profile');
  const script =
    'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" | ' +
    `Where-Object { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' } | ` +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      timeout: 15000,
    });
  } catch {
    /* ignore */
  }
}

function edgeExecutable() {
  const candidates = [
    process.env.DSH_EDGE_PATH,
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || 'msedge.exe';
}

function extensionArgs() {
  return [
    '--enable-developer-mode',
    `--load-extension=${EXT_DIR}`,
    '--restore-last-session',
  ];
}

function closeAllEdge() {
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', 'Stop-Process -Name msedge -Force -ErrorAction SilentlyContinue'],
      { stdio: 'ignore', windowsHide: true, timeout: 15000 },
    );
  } catch {
    /* ignore */
  }
}

function launchEdgeWithExtension() {
  const edge = edgeExecutable();
  spawn(edge, extensionArgs(), { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

function patchEdgeShortcuts() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$ext = ${JSON.stringify(EXT_DIR)}
$flags = '--enable-developer-mode --load-extension="' + $ext + '" --restore-last-session'
$dirs = @(
  (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar'),
  (Join-Path $env:USERPROFILE 'Desktop'),
  (Join-Path $env:PUBLIC 'Desktop'),
  (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs'),
  (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs')
)
$backup = '${path.join(DATA_DIR, 'backup', 'shortcuts').replace(/\\/g, '\\\\')}'
New-Item -ItemType Directory -Force -Path $backup | Out-Null
$ws = New-Object -ComObject WScript.Shell
$changed = @()
foreach ($dir in $dirs) {
  if (-not (Test-Path $dir)) { continue }
  Get-ChildItem -Path $dir -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    $s = $ws.CreateShortcut($_.FullName)
    if ($s.TargetPath -like '*msedge.exe') {
      if ($s.Arguments -notlike '*--load-extension*') {
        Copy-Item $_.FullName (Join-Path $backup $_.Name) -Force
        $s.Arguments = (($s.Arguments + ' ' + $flags).Trim())
        $s.Save()
        $changed += $_.FullName
      }
    }
  }
}
$changed | ConvertTo-Json -Compress
`;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    }).trim();
    return out ? JSON.parse(out) : [];
  } catch {
    return [];
  }
}

async function waitForExtension(timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const data = await call('/live/status', {}, {});
    const online = (data.clients || []).filter((client) => client.connected);
    if (online.length) return data;
    await sleep(1000);
  }
  return null;
}

function ensureExtension() {
  fs.mkdirSync(EXT_DIR, { recursive: true });
  let token = '';
  try {
    token = fs.readFileSync(EXT_TOKEN_FILE, 'utf8').trim();
  } catch {
    /* create below */
  }
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(EXT_TOKEN_FILE, token);
  }
  for (const file of ['manifest.json', 'background.js']) {
    const dest = path.join(EXT_DIR, file);
    if (!fs.existsSync(dest)) {
      const source = path.join(__dirname, 'extension-template', file);
      if (fs.existsSync(source)) fs.copyFileSync(source, dest);
    }
  }
  const config = `// Generated by dshedge. Do not share this file.\nself.DSH_CONFIG = ${JSON.stringify(
    { bridge: `http://127.0.0.1:${DEFAULT_PORT}`, token },
    null,
    2,
  )};\n`;
  fs.writeFileSync(path.join(EXT_DIR, 'config.js'), config);
  return { token, dir: EXT_DIR };
}

const help = `dshedge — control the user's Microsoft Edge over CDP

USAGE
  dshedge <command> [args] [--flags]

LIFECYCLE
  start [url] [--headless]       Start the bridge and Edge (idempotent)
  stop [--edge|--all]            Stop the bridge; --edge also closes Edge
  status                         Show bridge, Edge and tab state
  profile [--open]               Print the automation profile path
  tabs                           List tabs (index, id, title, url)
  new <url>                      Open a new tab
  close [tab]                    Close a tab
  activate <tab>                 Focus a tab

LIVE — your daily Edge profile, full CDP (no extension)
  live ensure                    Ensure daily Edge is running with CDP; restart if needed
  live restart                   Restart only the daily Edge profile
  live status                    Show daily Edge CDP status and tabs
  live tabs                      List tabs in your daily Edge
  live eval "<js>"               Any page command works with live mode
  live click "<sel>"             First command attaches to the daily tab
  live shot [path]               Screenshot the daily tab (brings it to front)
  live open <url>                Navigate the real active tab

PAGE
  open <url>                     Navigate the active tab (alias: goto, navigate)
  eval <js> | --file <path>      Evaluate JavaScript, print the value
  text [selector]                Visible text of the page or element
  html [selector]                HTML of the page or element
  snapshot                       Accessibility tree of the page
  shot [path] [--full]           Screenshot (default: ~/.dsh/browser/screenshots)
  pdf [path]                     Save the page as PDF
  devtools [tab] [--open]        URL of the DevTools frontend for a tab

INPUT
  click <selector>               Real mouse click (also --x/--y)
  type <selector> <text>         Focus and type (--clear, --submit, --delay)
  press <keys>                   Key combo, e.g. "Control+a", "Enter", "Shift+Tab"
  hover <selector>               Move the mouse to an element
  scroll [--dy 600]              Wheel scroll (also --selector)
  wait <selector> | --fn <js>    Wait until an element or predicate is truthy
  upload <selector> <file...>    Set files on a file input

DEBUG
  console [--clear] [--level]    Captured console/exception/log entries
  net [--clear] [--filter]       Captured network requests
  body <requestId>               Response body of a captured request
  cdp <Method> [json]            Raw CDP command (--tab browser for browser domain)
  cookies [--clear|--set name=value] [--domain d] [--url u]
  storage [--area session] [--get k|--set k=v|--remove k|--clear]
  dialog [--accept|--dismiss]    Handle a pending JavaScript dialog
  dialog-policy <policy>         accept | dismiss | manual (default: dismiss)
  emulate [--offline] [--latency ms] [--width px --height px] [--reset]
  downloads                      List downloads

COMMON FLAGS
  --tab <id|index|title-substring|active>   Target tab
  --json                                     Machine-readable output
  --timeout <ms>                             Request timeout

EXAMPLES
  dshedge start https://example.com
  dshedge eval "document.title"
  dshedge click "text=Sign in"
  dshedge type "#email" "me@example.com" --clear
  dshedge shot C:\\temp\\page.png --full
  dshedge console --clear
  dshedge cdp Runtime.evaluate '{"expression":"1+1"}' --tab browser
`;

async function main() {
  const argv = process.argv.slice(2);
  const { flags, pos } = parseArgs(argv);
  let cmd = (pos.shift() || 'help').toLowerCase();

  if (cmd === 'live') {
    const sub = (pos.shift() || '').toLowerCase();
    if (!sub) throw new Error('live needs a subcommand: ensure, status, tabs, eval, click, ...');
    if (sub === 'install' || sub === 'ensure' || sub === 'auto-install') {
      cmd = 'live-ensure';
    } else if (sub === 'restart') {
      cmd = 'live-restart';
    } else if (sub === 'status') {
      cmd = 'live-status';
    } else if (sub === 'wait') {
      cmd = 'live-wait';
    } else {
      flags.live = true;
      cmd = sub;
    }
  }

  if (cmd === 'help' || flags.help) {
    process.stdout.write(help);
    return;
  }

  switch (cmd) {
    case 'start':
    case 'ensure': {
      const data = await call('/ensure', { headless: Boolean(flags.headless) }, flags);
      if (pos[0]) await call('/navigate', { url: pos[0], wait: true, timeout: Number(flags.timeout || 45000) }, flags);
      emit(flags, data, (d) => {
        process.stdout.write(`Edge ${d.browser} ready\nprofile: ${d.profile}\ncdp: http://127.0.0.1:${d.cdpPort}\n`);
        printTabs(d.tabs);
      });
      return;
    }

    case 'stop':
    case 'shutdown': {
      const state = readState();
      if (!state?.port) {
        process.stdout.write('bridge is not running\n');
        return;
      }
      const closeEdge = Boolean(flags.edge || flags.all);
      try {
        const data = await rawCall(state, '/shutdown', { closeEdge }, 5000);
        for (let i = 0; i < 30; i++) {
          if (!(await health(state.port))) break;
          await sleep(100);
        }
        if (closeEdge) {
          killAutomationEdge();
          await sleep(1200);
        }
        process.stdout.write(data.closeEdge ? 'bridge stopped, Edge closed\n' : 'bridge stopped\n');
      } catch {
        if (closeEdge) killAutomationEdge();
        try {
          process.kill(state.pid);
          process.stdout.write('bridge process killed\n');
        } catch {
          process.stdout.write('bridge was not running\n');
        }
      }
      return;
    }

    case 'status': {
      const state = readState();
      const h = state?.port ? await health(state.port) : null;
      const data = { running: Boolean(h), state, health: h };
      emit(flags, data, (d) => {
        if (!d.running) {
          process.stdout.write('bridge: stopped\n');
          process.stdout.write(`profile: ${path.join(DATA_DIR, 'edge-profile')}\n`);
          return;
        }
        process.stdout.write(
          `bridge: running pid=${d.health.pid} http=127.0.0.1:${d.state.port} cdp=127.0.0.1:${d.health.cdpPort}\n`,
        );
        process.stdout.write(`automation edge: ${d.health.edge || 'not connected'}\n`);
        process.stdout.write(`automation profile: ${d.health.profile}\n`);
        process.stdout.write(`automation tabs: ${d.health.tabs}\n`);
        const live = d.health.live;
        if (live) {
          process.stdout.write(
            `live: ${live.connected ? 'connected' : 'disconnected'}  cdp=127.0.0.1:${live.port}  profile=${live.profile}\n`,
          );
          if (!live.connected) process.stdout.write('  run: dshedge live ensure\n');
        }
      });
      return;
    }

    case 'live-status': {
      const data = await call('/live/status', {}, flags);
      emit(flags, data, (d) => {
        if (!d.connected) {
          process.stdout.write('daily Edge: not connected (no CDP on the live port)\n');
          process.stdout.write('run: dshedge live ensure\n');
          return;
        }
        process.stdout.write(`daily Edge: connected  cdp=127.0.0.1:${d.cdpPort}  tabs=${d.tabs.length}\n`);
        for (const tab of d.tabs) {
          process.stdout.write(`${tab.active ? '*' : ' '} ${tab.index}  ${String(tab.id).slice(0, 8)}  ${clip(tab.title || '', 60)}  ${clip(tab.url, 100)}\n`);
        }
      });
      return;
    }

    case 'live-wait': {
      const data = await call('/live/ensure', {}, flags);
      const tabs = await call('/tabs', { live: true }, flags);
      emit(flags, { ...data, tabs: tabs.tabs }, (d) => {
        process.stdout.write(`daily Edge: connected  cdp=127.0.0.1:${d.cdpPort}\n`);
        printTabs(d.tabs);
      });
      return;
    }

    case 'live-auto-install':
    case 'live-ensure': {
      process.stdout.write('ensuring the daily Edge profile has CDP...\n');
      const data = await call('/live/ensure', {}, flags);
      const tabs = await call('/tabs', { live: true }, flags);
      emit(flags, { ...data, tabs: tabs.tabs }, (d) => {
        process.stdout.write(`daily Edge: connected  profile=${d.profile}  cdp=127.0.0.1:${d.cdpPort}\n`);
        printTabs(d.tabs);
      });
      return;
    }

    case 'live-restart': {
      process.stdout.write('restarting the daily Edge profile...\n');
      const data = await call('/live/restart', {}, flags);
      const tabs = await call('/tabs', { live: true }, flags);
      emit(flags, { ...data, tabs: tabs.tabs }, (d) => {
        process.stdout.write(`daily Edge: restarted  profile=${d.profile}  cdp=127.0.0.1:${d.cdpPort}\n`);
        printTabs(d.tabs);
      });
      return;
    }

    case 'detach': {
      const data = await call('/tabs/detach', { tab: pos[0] ?? flags.tab }, flags);
      emit(flags, data, (d) => process.stdout.write(`detached ${d.tab}\n`));
      return;
    }

    case 'tabs': {
      const data = await call('/tabs', {}, flags);
      emit(flags, data, (d) => printTabs(d.tabs));
      return;
    }

    case 'new': {
      const data = await call('/tabs/new', { url: pos[0] || 'about:blank', wait: !flags['no-wait'] }, flags);
      emit(flags, data, (d) => {
        process.stdout.write(`opened ${d.tab}\n`);
        printTabs(d.tabs);
      });
      return;
    }

    case 'close': {
      const data = await call('/tabs/close', { tab: pos[0] ?? flags.tab }, flags);
      emit(flags, data, (d) => {
        process.stdout.write(`closed ${d.closed}\n`);
        printTabs(d.tabs);
      });
      return;
    }

    case 'activate':
    case 'use': {
      if (!pos[0] && !flags.tab) throw new Error('activate needs a tab');
      const data = await call('/tabs/activate', { tab: pos[0] ?? flags.tab }, flags);
      emit(flags, data, () => process.stdout.write('activated\n'));
      return;
    }

    case 'open':
    case 'goto':
    case 'navigate': {
      if (!pos[0]) throw new Error('open needs a URL');
      const data = await call('/navigate', {
        tab: flags.tab,
        url: pos[0],
        wait: !flags['no-wait'],
        timeout: Number(flags.timeout || 45000),
      }, flags);
      emit(flags, data, (d) => {
        process.stdout.write(`${d.url}\n`);
        if (d.title) process.stdout.write(`${d.title}\n`);
      });
      return;
    }

    case 'eval':
    case 'js': {
      let expression = pos.join(' ');
      if (flags.file) expression = fs.readFileSync(flags.file === '-' ? 0 : flags.file, 'utf8');
      if (!expression) throw new Error('eval needs an expression or --file');
      const data = await call('/eval', {
        tab: flags.tab,
        expression,
        awaitPromise: !flags['no-await'],
        returnByValue: true,
        timeout: Number(flags.timeout || 120000),
      }, flags);
      emit(flags, data, (d) => {
        if (typeof d.value === 'string') process.stdout.write(d.value + '\n');
        else if (d.value === undefined) process.stdout.write('undefined\n');
        else process.stdout.write(JSON.stringify(d.value, null, 2) + '\n');
      });
      return;
    }

    case 'shot':
    case 'screenshot': {
      const file = pos[0] || flags.path;
      const data = await call('/screenshot', {
        tab: flags.tab,
        file,
        fullPage: Boolean(flags.full),
        selector: flags.selector,
        format: flags.format || 'png',
        quality: flags.quality ? Number(flags.quality) : undefined,
      }, flags);
      emit(flags, data, (d) => {
        process.stdout.write(`${d.path}\n${d.width || '?'}x${d.height || '?'} ${d.bytes} bytes\n`);
        if (d.warning) process.stdout.write(`warning: ${d.warning}\n`);
        if (flags.open) openPath(d.path);
      });
      return;
    }

    case 'click': {
      const data = await call('/click', {
        tab: flags.tab,
        selector: pos[0] || flags.selector,
        x: flags.x !== undefined ? Number(flags.x) : undefined,
        y: flags.y !== undefined ? Number(flags.y) : undefined,
        button: flags.button || 'left',
        count: flags.count ? Number(flags.count) : 1,
        force: Boolean(flags.force),
      }, flags);
      emit(flags, data, (d) => {
        process.stdout.write(`clicked ${d.element ? `${d.element.tag} "${clip(d.element.text, 60)}"` : `${d.x},${d.y}`}\n`);
        if (d.dialogPending) process.stdout.write('a JavaScript dialog is open; handle it with "dshedge dialog"\n');
        else if (d.element?.covered) process.stdout.write('warning: element was covered by another element\n');
      });
      return;
    }

    case 'type': {
      const selector = flags.selector ?? pos[0];
      let text = flags.text ?? (flags.selector ? pos.join(' ') : pos.slice(1).join(' '));
      if (typeof text !== 'string') text = String(text ?? '');
      if (!selector) throw new Error('type needs a selector, or --selector with --text');
      const data = await call('/type', {
        tab: flags.tab,
        selector,
        text,
        clear: Boolean(flags.clear),
        submit: Boolean(flags.submit),
        delay: flags.delay ? Number(flags.delay) : 0,
      }, flags);
      emit(flags, data, (d) => process.stdout.write(`typed ${d.length} characters\n`));
      return;
    }

    case 'press':
    case 'key': {
      const keys = pos.length ? (pos.length === 1 ? pos[0] : pos) : flags.keys;
      if (!keys) throw new Error('press needs a key combo, e.g. "Control+a" or "Enter"');
      const data = await call('/press', { tab: flags.tab, keys }, flags);
      emit(flags, data, () => process.stdout.write('pressed\n'));
      return;
    }

    case 'hover': {
      if (!pos[0] && !flags.selector) throw new Error('hover needs a selector');
      const data = await call('/hover', { tab: flags.tab, selector: pos[0] || flags.selector }, flags);
      emit(flags, data, () => process.stdout.write('hovered\n'));
      return;
    }

    case 'scroll': {
      const data = await call('/scroll', {
        tab: flags.tab,
        selector: flags.selector,
        x: flags.x !== undefined ? Number(flags.x) : undefined,
        y: flags.y !== undefined ? Number(flags.y) : undefined,
        deltaX: Number(flags.dx || 0),
        deltaY: Number(flags.dy || 600),
      }, flags);
      emit(flags, data, (d) => process.stdout.write(`scrolled ${d.deltaX},${d.deltaY}\n`));
      return;
    }

    case 'wait': {
      const selector = pos[0] || flags.selector;
      const fn = flags.fn;
      if (!selector && !fn) throw new Error('wait needs a selector or --fn');
      const data = await call('/wait', {
        tab: flags.tab,
        selector,
        fn,
        timeout: Number(flags.timeout || 20000),
      }, flags);
      emit(flags, data, () => process.stdout.write('ready\n'));
      return;
    }

    case 'text': {
      const data = await call('/text', { tab: flags.tab, selector: pos[0] || flags.selector }, flags);
      emit(flags, data, (d) => process.stdout.write(d.text + '\n'));
      return;
    }

    case 'html': {
      const data = await call('/html', {
        tab: flags.tab,
        selector: pos[0] || flags.selector,
        outer: !flags.inner,
      }, flags);
      emit(flags, data, (d) => process.stdout.write(d.html + '\n'));
      return;
    }

    case 'snapshot':
    case 'snap': {
      const data = await call('/snapshot', { tab: flags.tab }, flags);
      emit(flags, data, (d) => {
        process.stdout.write(`${d.title || ''} — ${d.url}\n${d.text}\n`);
      });
      return;
    }

    case 'console':
    case 'logs': {
      const data = await call('/console', {
        tab: flags.tab,
        clear: Boolean(flags.clear),
        level: flags.level,
        filter: flags.filter,
      }, flags);
      emit(flags, data, (d) => {
        for (const e of d.entries) {
          process.stdout.write(`[${fmtTime(e.at)}] ${String(e.level).toUpperCase().padEnd(9)} ${e.text}\n`);
        }
        process.stdout.write(`(${d.count} entries)\n`);
      });
      return;
    }

    case 'net':
    case 'network': {
      const data = await call('/network', {
        tab: flags.tab,
        clear: Boolean(flags.clear),
        filter: flags.filter,
        failedOnly: Boolean(flags['failed-only']),
      }, flags);
      emit(flags, data, (d) => {
        for (const e of d.entries) {
          const status = e.failed ? 'ERR' : e.status || '---';
          const size = e.encodedDataLength !== undefined ? `${Math.round(e.encodedDataLength / 1024)}k` : '';
          process.stdout.write(
            `${String(status).padEnd(4)} ${String(e.method || '').padEnd(6)} ${String(e.resourceType || '').padEnd(10)} ${size.padEnd(6)} ${clip(e.url, 150)}\n`,
          );
        }
        process.stdout.write(`(${d.count} requests)\n`);
      });
      return;
    }

    case 'body': {
      if (!pos[0]) throw new Error('body needs a requestId');
      const data = await call('/network/body', { tab: flags.tab, requestId: pos[0] }, flags);
      emit(flags, data, (d) => {
        process.stdout.write(d.body + '\n');
        if (d.base64Encoded) process.stdout.write('(base64 encoded)\n');
      });
      return;
    }

    case 'cookies': {
      const body = { tab: flags.tab, action: 'get', urls: flags.url ? [flags.url] : undefined };
      if (flags.clear) body.action = 'clear';
      else if (flags.set) {
        const raw = String(flags.set);
        const eq = raw.indexOf('=');
        if (eq === -1) throw new Error('--set needs name=value');
        body.action = 'set';
        body.cookie = {
          name: raw.slice(0, eq),
          value: raw.slice(eq + 1),
          domain: flags.domain,
          url: flags.url,
          path: flags.path,
          secure: Boolean(flags.secure),
          httpOnly: Boolean(flags['http-only']),
          sameSite: flags['same-site'],
        };
      }
      const data = await call('/cookies', body, flags);
      emit(flags, data, (d) => {
        if (d.cookies) {
          for (const c of d.cookies) process.stdout.write(`${c.domain}${c.path} ${c.name}=${clip(c.value, 80)}\n`);
          process.stdout.write(`(${d.cookies.length} cookies)\n`);
        } else {
          process.stdout.write('ok\n');
        }
      });
      return;
    }

    case 'storage': {
      let action = 'get';
      if (flags.clear) action = 'clear';
      else if (flags.remove) action = 'remove';
      else if (flags.set) action = 'set';
      let key;
      let value;
      if (action === 'set') {
        const raw = String(flags.set);
        const eq = raw.indexOf('=');
        if (eq === -1) throw new Error('--set needs key=value');
        key = raw.slice(0, eq);
        value = raw.slice(eq + 1);
      } else {
        key = flags.get ?? flags.remove;
      }
      const data = await call('/storage', {
        tab: flags.tab,
        area: flags.area || 'local',
        action,
        key,
        value,
      }, flags);
      emit(flags, data, (d) => {
        if (['set', 'remove', 'clear'].includes(action)) process.stdout.write('ok\n');
        else if (typeof d.value === 'string') process.stdout.write(d.value + '\n');
        else process.stdout.write(JSON.stringify(d.value, null, 2) + '\n');
      });
      return;
    }

    case 'upload': {
      if (!pos[0]) throw new Error('upload needs a selector');
      const files = flags.file ? (Array.isArray(flags.file) ? flags.file : [flags.file]) : pos.slice(1);
      if (!files.length) throw new Error('upload needs at least one file');
      const data = await call('/upload', { tab: flags.tab, selector: pos[0], files }, flags);
      emit(flags, data, (d) => process.stdout.write(`uploaded ${d.files.length} file(s)\n`));
      return;
    }

    case 'pdf': {
      const data = await call('/pdf', { tab: flags.tab, file: pos[0] || flags.path, landscape: Boolean(flags.landscape) }, flags);
      emit(flags, data, (d) => process.stdout.write(`${d.path}\n${d.bytes} bytes\n`));
      return;
    }

    case 'dialog': {
      const data = await call('/dialog', {
        tab: flags.tab,
        accept: Boolean(flags.accept),
        promptText: flags.text || flags.prompt,
        policy: flags.policy,
      }, flags);
      emit(flags, data, (d) => process.stdout.write(d.dialog ? `${d.dialog.type}: ${d.dialog.message}\n` : 'no dialog\n'));
      return;
    }

    case 'dialog-policy': {
      const policy = pos[0];
      if (!policy) throw new Error('dialog-policy needs accept, dismiss or manual');
      const data = await call('/dialog/policy', { tab: flags.tab, policy }, flags);
      emit(flags, data, (d) => process.stdout.write(`dialog policy: ${d.policy}\n`));
      return;
    }

    case 'emulate': {
      const data = await call('/emulate', {
        tab: flags.tab,
        offline: flags.offline ? true : undefined,
        latency: flags.latency !== undefined ? Number(flags.latency) : undefined,
        downloadKbps: flags.download !== undefined ? Number(flags.download) : undefined,
        uploadKbps: flags.upload !== undefined ? Number(flags.upload) : undefined,
        width: flags.width !== undefined ? Number(flags.width) : undefined,
        height: flags.height !== undefined ? Number(flags.height) : undefined,
        deviceScaleFactor: flags.scale !== undefined ? Number(flags.scale) : undefined,
        mobile: flags.mobile ? true : undefined,
        userAgent: flags.ua,
        reset: Boolean(flags.reset),
      }, flags);
      emit(flags, data, () => process.stdout.write('emulation updated\n'));
      return;
    }

    case 'cdp': {
      if (!pos[0]) throw new Error('cdp needs a method, e.g. Runtime.evaluate');
      let params = {};
      if (pos[1]) params = JSON.parse(pos[1]);
      else if (flags.params) params = JSON.parse(String(flags.params));
      const data = await call('/cdp', {
        tab: flags.tab === 'browser' ? 'browser' : flags.tab,
        method: pos[0],
        params,
        sessionId: flags.session,
        timeout: Number(flags.timeout || 120000),
      }, flags);
      emit(flags, data, (d) => process.stdout.write(JSON.stringify(d.result, null, 2) + '\n'));
      return;
    }

    case 'devtools': {
      const data = await call('/devtools', { tab: pos[0] || flags.tab }, flags);
      emit(flags, data, (d) => {
        process.stdout.write(d.url + '\n');
        if (flags.open) openUrl(d.url);
      });
      return;
    }

    case 'downloads': {
      const data = await call('/downloads', {}, flags);
      emit(flags, data, (d) => {
        for (const item of d.downloads) {
          process.stdout.write(`${item.state.padEnd(10)} ${clip(item.suggestedFilename, 60)}  ${clip(item.url, 100)}\n`);
        }
        process.stdout.write(`(${d.downloads.length}) in ${d.directory}\n`);
      });
      return;
    }

    case 'profile': {
      const profile = path.join(DATA_DIR, 'edge-profile');
      emit(flags, { profile, exists: fs.existsSync(profile) }, (d) => {
        process.stdout.write(d.profile + '\n');
        if (flags.open) openPath(d.profile);
      });
      return;
    }

    case 'version': {
      process.stdout.write('dshedge 1.1.1\n');
      return;
    }

    default:
      process.stderr.write(`unknown command: ${cmd}\n\n`);
      process.stdout.write(help);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err.message}\n`);
  process.exitCode = 1;
});




