// DSH Edge bridge: long-lived local daemon that launches/attaches Edge over CDP
// and exposes a small JSON API on 127.0.0.1.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Cdp, CdpError } from './cdp.mjs';
import { PageSession } from './page.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const DATA_DIR = process.env.DSH_EDGE_DATA || path.join(HOME, '.dsh', 'browser');
const PROFILE_DIR = path.join(DATA_DIR, 'edge-profile');
const DAILY_PROFILE = path.join(DATA_DIR, 'edge-daily');
const SHOTS_DIR = path.join(DATA_DIR, 'screenshots');
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'bridge.log');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const EXT_DIR = path.join(DATA_DIR, 'extension');
const EXT_TOKEN_FILE = path.join(DATA_DIR, 'extension-token');
const EXT_PEM = path.join(DATA_DIR, 'extension.pem');
const EXT_CRX = path.join(DATA_DIR, 'extension.crx');
const LIVE_CDP_PORT = Number(process.env.DSH_EDGE_LIVE_CDP_PORT || 9449);

const BRIDGE_PORT = Number(process.env.DSH_EDGE_BRIDGE_PORT || 9333);
const CDP_PORT = Number(process.env.DSH_EDGE_CDP_PORT || 9334);
const CDP_ORIGIN = `http://127.0.0.1:${CDP_PORT}`;
const VERSION = '1.0.0';
const stateToken = crypto.randomBytes(24).toString('hex');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const dir of [DATA_DIR, PROFILE_DIR, SHOTS_DIR, DOWNLOADS_DIR, LOG_DIR, EXT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

let EXT_TOKEN = '';
try {
  EXT_TOKEN = fs.readFileSync(EXT_TOKEN_FILE, 'utf8').trim();
} catch {
  /* create below */
}
if (!EXT_TOKEN) {
  EXT_TOKEN = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(EXT_TOKEN_FILE, EXT_TOKEN);
}

let EXT_ID = '';
try {
  const key = crypto.createPublicKey(fs.readFileSync(EXT_PEM));
  const der = key.export({ type: 'spki', format: 'der' });
  const hash = crypto.createHash('sha256').update(der).digest();
  for (const byte of hash.subarray(0, 16)) {
    EXT_ID += String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15));
  }
} catch {
  /* no packed CRX yet */
}
try {
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  }
} catch {
  /* ignore */
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
  try {
    process.stdout.write(line + '\n');
  } catch {
    /* ignore */
  }
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* ignore */
  }
}

async function fetchJson(url, timeout = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function findEdge() {
  const candidates = [
    process.env.DSH_EDGE_PATH,
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe', '/ve'],
      { encoding: 'utf8', windowsHide: true },
    );
    const match = out.match(/REG_SZ\s+(.+?)\s*$/m);
    if (match) {
      const found = match[1].trim().replace(/^"|"$/g, '');
      if (fs.existsSync(found)) return found;
    }
  } catch {
    /* ignore */
  }
  throw new Error('Microsoft Edge (msedge.exe) not found. Set DSH_EDGE_PATH to its full path.');
}

async function cdpVersion(port = CDP_PORT) {
  try {
    return await fetchJson(`http://127.0.0.1:${port}/json/version`, 1500);
  } catch {
    return null;
  }
}

function stopAllEdge() {  const script =
    '$p = Get-Process msedge -ErrorAction SilentlyContinue; ' +
    '$p | ForEach-Object { $_.CloseMainWindow() | Out-Null }; ' +
    'Start-Sleep -Seconds 2; ' +
    'Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue';
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 20000,
    });
  } catch {
    /* ignore */
  }
}

function edgeProcessesUsingProfile(profileDir = PROFILE_DIR) {
  try {
    const script =
      'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" | Select-Object -ExpandProperty CommandLine';
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    });
    return out
      .split(/\r?\n/)
      .filter((line) => line.toLowerCase().includes(profileDir.toLowerCase()))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function ensureEdge({
  headless = false,
  url,
  profileDir = PROFILE_DIR,
  cdpPort = CDP_PORT,
  restore = false,
  killOthers = false,
  withExtension = true,
} = {}) {
  const existing = await cdpVersion(cdpPort);
  if (existing) return existing;

  if (killOthers) {
    stopAllEdge();
    await sleep(2500);
  }

  const edge = findEdge();
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--noerrdialogs',
    '--disable-session-crashed-bubble',
    '--remote-allow-origins=*',
    ...(profileDir === DAILY_PROFILE ? [] : ['--disable-blink-features=AutomationControlled']),
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=msEdgeFirstRunExperience,CalculateNativeWinOcclusion,msEdgeSleepingTabs,msEdgeTabPreloading',
    '--start-maximized',
    '--window-size=1600,1000',
    ...(withExtension && process.env.DSH_EDGE_EXTENSION === '1' && fs.existsSync(path.join(EXT_DIR, 'manifest.json'))
      ? [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`]
      : []),
    ...(restore ? ['--restore-last-session'] : []),
    ...(headless ? ['--headless=new', '--hide-scrollbars'] : []),
    url || 'about:blank',
  ];

  log('launching Edge', edge, args.join(' '));
  const child = spawn(edge, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();

  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    await sleep(300);
    const version = await cdpVersion(cdpPort);
    if (version) {
      log(`${profileDir === PROFILE_DIR ? 'Edge' : 'Edge (daily)'} CDP ready`, version.Browser);
      return version;
    }
  }

  const busy = edgeProcessesUsingProfile(profileDir);
  if (busy.length) {
    throw new Error(
      `Edge is already running with the profile (${profileDir}) but without the CDP port. ` +
        'Close that Edge window, then retry.',
    );
  }
  throw new Error(
    `Edge did not expose CDP on http://127.0.0.1:${cdpPort} within 35s. Try "dshedge stop --all" then "dshedge start", ` +
      `or check ${LOG_FILE}.`,
  );
}

class Browser {
  constructor({
    profileDir = PROFILE_DIR,
    cdpPort = CDP_PORT,
    label = 'automation',
    restore = false,
    killOthers = false,
    withExtension = true,
  } = {}) {
    this.profileDir = profileDir;
    this.cdpPort = cdpPort;
    this.cdpOrigin = `http://127.0.0.1:${cdpPort}`;
    this.label = label;
    this.restore = restore;
    this.killOthers = killOthers;
    this.withExtension = withExtension;
    this.pages = new Map();
    this.browserCdp = null;
    this.activeId = null;
    this.downloads = [];
    this.edgeInfo = null;
    this.headless = false;
  }

  async ensure({ headless } = {}) {
    if (headless !== undefined) this.headless = Boolean(headless);
    if (this.browserCdp?.connected) return this.edgeInfo;
    const version = await ensureEdge({
      headless: this.headless,
      profileDir: this.profileDir,
      cdpPort: this.cdpPort,
      restore: this.restore,
      killOthers: this.killOthers,
      withExtension: this.withExtension,
    });
    this.edgeInfo = version;
    const cdp = new Cdp(version.webSocketDebuggerUrl, { label: 'browser', timeout: 30000 });
    await cdp.connect();
    this.browserCdp = cdp;
    cdp.on('*', (method, params) => this.#onBrowserEvent(method, params));
    cdp.on('close', () => {
      if (this.browserCdp === cdp) this.browserCdp = null;
    });
    await cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
    await cdp
      .send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: DOWNLOADS_DIR,
        eventsEnabled: true,
      })
      .catch(() => {});
    return this.edgeInfo;
  }

  #onBrowserEvent(method, params) {
    if (method === 'Target.targetDestroyed') {
      const page = this.pages.get(params.targetId);
      if (page) {
        page.dispose();
        this.pages.delete(params.targetId);
      }
      if (this.activeId === params.targetId) this.activeId = null;
    } else if (method === 'Browser.downloadWillBegin') {
      this.downloads.push({
        guid: params.guid,
        url: params.url,
        suggestedFilename: params.suggestedFilename,
        at: Date.now(),
        state: 'started',
      });
      if (this.downloads.length > 500) this.downloads.shift();
    } else if (method === 'Browser.downloadProgress') {
      const item = this.downloads.find((d) => d.guid === params.guid);
      if (item) {
        item.state = params.state;
        item.receivedBytes = params.receivedBytes;
        item.totalBytes = params.totalBytes;
      }
    }
  }

  async listTargets() {
    await this.ensure();
    try {
      return await fetchJson(`${this.cdpOrigin}/json/list`, 5000);
    } catch (err) {
      throw new Error(`cannot list Edge targets: ${err.message}`);
    }
  }

  async list() {
    const targets = (await this.listTargets()).filter((t) => t.type === 'page');
    return targets.map((t, index) => ({
      index,
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.id === this.activeId,
      attached: this.pages.has(t.id),
    }));
  }

  async attach(targetId) {
    const existing = this.pages.get(targetId);
    if (existing?.connected) return existing;
    const targets = await this.listTargets();
    const target = targets.find((t) => t.id === targetId);
    if (!target) throw new Error(`tab not found: ${targetId}`);
    if (!target.webSocketDebuggerUrl) throw new Error(`tab has no debugger URL: ${targetId} (${target.url})`);

    const cdp = new Cdp(target.webSocketDebuggerUrl, { label: `tab:${targetId}`, timeout: 30000 });
    await cdp.connect();
    const page = new PageSession({ target, cdp, log });
    page.live = this.label === 'live';
    page.defaultScreenshotPath = () =>
      path.join(SHOTS_DIR, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    cdp.on('close', () => {
      page.connected = false;
      if (this.pages.get(targetId) === page) this.pages.delete(targetId);
    });
    await page.enable();
    this.pages.set(targetId, page);
    if (!this.activeId) this.activeId = targetId;
    return page;
  }

  async resolve(ref) {
    const targets = (await this.listTargets()).filter((t) => t.type === 'page');
    if (!targets.length) {
      const id = await this.newTab('about:blank', { active: true });
      return this.attach(id);
    }
    let target;
    if (ref === undefined || ref === null || ref === '' || ref === 'active') {
      target = targets.find((t) => t.id === this.activeId) || targets[0];
    } else if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
      target = targets[Number(ref)];
    } else if (/^[0-9a-f]{32}$/i.test(String(ref))) {
      target = targets.find((t) => t.id.toLowerCase() === String(ref).toLowerCase());
    } else {
      target = targets.find((t) => (t.url || '').includes(String(ref)) || (t.title || '').includes(String(ref)));
    }
    if (!target) {
      const available = targets.map((t, i) => `${i}:${t.title || t.url}`).join(' | ');
      throw new Error(`tab not found: ${ref}. Available: ${available}`);
    }
    if (this.activeId !== target.id) this.activeId = target.id;
    return this.attach(target.id);
  }

  async newTab(url = 'about:blank', { active = true, wait = true } = {}) {
    await this.ensure();
    const { targetId } = await this.browserCdp.send('Target.createTarget', { url });
    if (active) {
      this.activeId = targetId;
      await this.browserCdp.send('Target.activateTarget', { targetId }).catch(() => {});
    }
    for (let i = 0; i < 60; i++) {
      const targets = await this.listTargets();
      if (targets.some((t) => t.id === targetId)) break;
      await sleep(100);
    }
    const page = await this.attach(targetId);
    if (wait) await page.waitForLoad(20000).catch(() => {});
    return targetId;
  }

  async activate(ref) {
    const page = await this.resolve(ref);
    this.activeId = page.id;
    await this.browserCdp.send('Target.activateTarget', { targetId: page.id }).catch(() => {});
    return { ok: true, tab: page.id };
  }

  async close(ref) {
    await this.ensure();
    const targets = (await this.listTargets()).filter((t) => t.type === 'page');
    let id;
    if (ref === undefined || ref === null || ref === 'active') id = this.activeId || targets[0]?.id;
    else if (/^\d+$/.test(String(ref))) id = targets[Number(ref)]?.id;
    else if (/^[0-9a-f]{32}$/i.test(String(ref))) id = targets.find((t) => t.id.toLowerCase() === String(ref).toLowerCase())?.id;
    else id = targets.find((t) => (t.url || '').includes(String(ref)) || (t.title || '').includes(String(ref)))?.id;
    if (!id) throw new Error(`tab not found: ${ref}`);
    const page = this.pages.get(id);
    if (page) page.dispose();
    this.pages.delete(id);
    await this.browserCdp.send('Target.closeTarget', { targetId: id });
    if (this.activeId === id) this.activeId = null;
    return { ok: true, closed: id };
  }

  async navigate(ref, url, opts) {
    const page = await this.resolve(ref);
    const result = await page.navigate(url, opts);
    this.activeId = page.id;
    return result;
  }

  async closeBrowser() {
    if (!this.browserCdp?.connected) return;
    await this.browserCdp.send('Browser.close', {}, { timeout: 3000 }).catch(() => {});
    this.browserCdp = null;
    this.pages.clear();
    this.activeId = null;
  }
}

class ExtCdp extends EventEmitter {
  constructor(ext, browserId, tabId) {
    super();
    this.ext = ext;
    this.browserId = browserId;
    this.tabId = tabId;
    this.connected = true;
  }

  send(method, params = {}, opts = {}) {
    return this.ext.command(
      this.browserId,
      { kind: 'cdp', tabId: this.tabId, method, params },
      opts?.timeout ?? 30000,
    );
  }

  close() {
    this.connected = false;
    this.emit('close');
  }
}

// Controls Edge through the "DSH Edge Bridge" extension (chrome.debugger), which
// works on the user's real, already-running browser instead of a separate profile.
class ExtBridge {
  constructor() {
    this.clients = new Map();
    this.pending = new Map();
    this.nextId = 0;
    this.activeBrowserId = null;
  }

  #client(browserId) {
    let client = this.clients.get(browserId);
    if (!client) {
      client = {
        id: browserId,
        short: browserId.slice(0, 8),
        lastSeen: 0,
        version: '',
        tabs: [],
        queue: [],
        waiter: null,
        pages: new Map(),
      };
      this.clients.set(browserId, client);
    }
    return client;
  }

  #wake(client) {
    if (!client.waiter || !client.queue.length) return;
    const waiter = client.waiter;
    client.waiter = null;
    waiter(client.queue.shift());
  }

  #ingest(client, events) {
    for (const event of events || []) {
      if (!event || typeof event.tabId !== 'number') continue;
      if (event.method === '__detached') {
        this.detach(client.id, event.tabId, event.params?.reason);
        continue;
      }
      const page = client.pages.get(event.tabId);
      if (page?.cdp) page.cdp.emit('*', event.method, event.params || {});
    }
  }

  poll(browserId, version, events) {
    const client = this.#client(browserId);
    client.lastSeen = Date.now();
    if (version) client.version = version;
    this.activeBrowserId = browserId;
    this.#ingest(client, events);

    for (const [id, other] of this.clients) {
      if (id !== browserId && Date.now() - other.lastSeen > 3600000 && other.pages.size === 0) {
        this.clients.delete(id);
      }
    }

    if (client.queue.length) return Promise.resolve(client.queue.shift());

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (client.waiter === finish) client.waiter = null;
        resolve(null);
      }, 15000);
      const finish = (cmd) => {
        clearTimeout(timer);
        resolve(cmd);
      };
      if (client.waiter) client.waiter(null);
      client.waiter = finish;
    });
  }

  command(browserId, cmd, timeout = 30000) {
    const client = this.clients.get(browserId);
    if (!client) {
      return Promise.reject(
        new Error(
          'the Edge extension is not connected. Run "dshedge live-install", load the extension in Edge, then retry.',
        ),
      );
    }
    const id = `x${++this.nextId}`;
    const payload = { id, ...cmd };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`extension command timed out: ${cmd.kind} ${cmd.method || ''}`.trim()));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      client.queue.push(payload);
      this.#wake(client);
    });
  }

  result(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return { ok: true, ignored: true };
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || 'extension command failed'));
    return { ok: true };
  }

  async listTabs(browserId) {
    const ids = browserId ? [...this.clients.keys()].filter((id) => id === browserId || id.startsWith(browserId)) : [...this.clients.keys()];
    const out = [];
    for (const id of ids) {
      const client = this.clients.get(id);
      if (!client) continue;
      if (!browserId && Date.now() - client.lastSeen > 45000) continue;
      let tabs = client.tabs;
      try {
        tabs = (await this.command(id, { kind: 'tabs' }, 8000)) || [];
        client.tabs = tabs;
      } catch {
        /* keep last known */
      }
      tabs.forEach((tab, index) => {
        out.push({
          ...tab,
          index,
          id: `${client.short}:${tab.tabId}`,
          browser: client.id,
          browserShort: client.short,
          attached: client.pages.has(tab.tabId),
        });
      });
    }
    return out;
  }

  async #clientFor(browserId) {
    const now = Date.now();
    if (browserId) {
      const match = [...this.clients.keys()].find((id) => id === browserId || id.startsWith(browserId));
      if (match) return this.clients.get(match);
    }
    const fresh = [...this.clients.values()].filter((client) => now - client.lastSeen < 45000);
    if (this.activeBrowserId) {
      const active = fresh.find((client) => client.id === this.activeBrowserId);
      if (active) return active;
    }
    return fresh[0] || [...this.clients.values()][0] || null;
  }

  async resolve(ref, browserId) {
    const clients = [...this.clients.keys()];
    if (!clients.length) {
      throw new Error(
        'the Edge extension is not connected. Run "dshedge live-install" and load the extracted extension in Edge (edge://extensions).',
      );
    }
    await this.listTabs(browserId).catch(() => null);

    let client = null;
    let tab = null;
    let tabId = null;

    if (typeof ref === 'string' && ref.includes(':')) {
      const [short, rest] = ref.split(':');
      client = [...this.clients.values()].find((c) => c.id.startsWith(short));
      tabId = Number(rest);
    } else {
      client = await this.#clientFor(browserId);
      if (!client) throw new Error('the Edge extension is not connected');
      if (ref === undefined || ref === null || ref === '' || ref === 'active') {
        tab = client.tabs.find((t) => t.active) || client.tabs[0];
      } else if (/^\d+$/.test(String(ref))) {
        const n = Number(ref);
        if (client.tabs[n]) tab = client.tabs[n];
        else tab = client.tabs.find((t) => t.tabId === n);
      } else {
        tab = client.tabs.find((t) => (t.title || '').includes(String(ref)) || (t.url || '').includes(String(ref)));
      }
      tabId = tab?.tabId;
    }

    if (!client) throw new Error(`no Edge extension client matches: ${ref}`);
    if (!tabId) {
      const list = client.tabs.map((t, i) => `${i}:${t.title || t.url}`).join(' | ');
      throw new Error(`live tab not found: ${ref}. Available: ${list}`);
    }
    return this.ensurePage(client.id, tabId);
  }

  async ensurePage(browserId, tabId) {
    const client = this.clients.get(browserId);
    if (!client) throw new Error('the Edge extension is not connected');
    const existing = client.pages.get(tabId);
    if (existing?.connected) return existing;

    await this.command(browserId, { kind: 'attach', tabId }, 15000);
    let tab = client.tabs.find((t) => t.tabId === tabId);
    if (!tab) {
      const tabs = await this.command(browserId, { kind: 'tabs' }, 8000).catch(() => []);
      client.tabs = tabs || [];
      tab = client.tabs.find((t) => t.tabId === tabId);
    }

    const cdp = new ExtCdp(this, browserId, tabId);
    const page = new PageSession({
      target: { id: `${client.short}:${tabId}`, url: tab?.url || '', title: tab?.title || '' },
      cdp,
      log,
    });
    page.live = true;
    page.ext = { browserId, tabId };
    page.activate = () => this.command(browserId, { kind: 'activate', tabId }, 8000);
    page.defaultScreenshotPath = () =>
      path.join(SHOTS_DIR, `live-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    cdp.on('close', () => {
      if (client.pages.get(tabId) === page) client.pages.delete(tabId);
    });
    await page.enable();
    client.pages.set(tabId, page);
    return page;
  }

  detach(browserId, tabId, reason) {
    const client = this.clients.get(browserId);
    const page = client?.pages.get(tabId);
    if (page) {
      page.dispose();
      client.pages.delete(tabId);
      if (reason) log(`extension detached tab ${tabId}: ${reason}`);
    }
  }

  async detachTab(ref, browserId) {
    const page = await this.resolve(ref, browserId);
    const { browserId: id, tabId } = page.ext;
    await this.command(id, { kind: 'detach', tabId }, 8000).catch(() => {});
    this.detach(id, tabId, 'requested');
    return { ok: true, tab: page.id };
  }

  async activateTab(ref, browserId) {
    const page = await this.resolve(ref, browserId);
    await page.activate();
    return { ok: true, tab: page.id };
  }

  async newTab(url, { active = true, browserId } = {}) {
    const client = await this.#clientFor(browserId);
    if (!client) throw new Error('the Edge extension is not connected');
    const result = await this.command(client.id, { kind: 'new', url, active }, 15000);
    await this.listTabs(client.id).catch(() => {});
    const tab = client.tabs.find((t) => t.tabId === result?.tabId);
    return { tab: tab ? `${client.short}:${tab.tabId}` : `${client.short}:${result?.tabId}`, tabs: await this.listTabs(client.id) };
  }

  async closeTab(ref, browserId) {
    const page = await this.resolve(ref, browserId);
    const { browserId: id, tabId } = page.ext;
    this.detach(id, tabId, 'closing');
    await this.command(id, { kind: 'close', tabId }, 8000);
    return { ok: true, closed: page.id, tabs: await this.listTabs(id) };
  }

  status() {
    return [...this.clients.values()].map((client) => ({
      browser: client.id,
      short: client.short,
      version: client.version,
      lastSeen: client.lastSeen,
      connected: Date.now() - client.lastSeen < 30000,
      tabs: client.tabs.length,
      attached: client.pages.size,
      active: client.id === this.activeBrowserId,
    }));
  }
}

const ext = new ExtBridge();

const browser = new Browser();
const liveBrowser = new Browser({
  profileDir: DAILY_PROFILE,
  cdpPort: LIVE_CDP_PORT,
  label: 'live',
  restore: true,
  killOthers: true,
  withExtension: false,
});

async function resolvePage(body) {
  if (body.live) return liveBrowser.resolve(body.tab);
  return browser.resolve(body.tab);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

const routes = {
  '/ensure': async (body) => {
    const version = await browser.ensure({ headless: body.headless });
    return {
      ok: true,
      browser: version.Browser,
      userAgent: version['User-Agent'],
      profile: DAILY_PROFILE,
      cdpPort: CDP_PORT,
      tabs: await browser.list(),
    };
  },

  '/live/status': async () => {
    if (!liveBrowser.browserCdp?.connected) {
      const version = await cdpVersion(LIVE_CDP_PORT).catch(() => null);
      if (version) await liveBrowser.ensure().catch(() => null);
    }
    const connected = Boolean(liveBrowser.browserCdp?.connected);
    let tabs = [];
    if (connected) tabs = await liveBrowser.list().catch(() => []);
    return {
      ok: true,
      connected,
      profile: DAILY_PROFILE,
      cdpPort: LIVE_CDP_PORT,
      clients: connected
        ? [
            {
              browser: 'real',
              short: 'real',
              version: liveBrowser.edgeInfo?.Browser || '',
              lastSeen: Date.now(),
              connected: true,
              tabs: tabs.length,
              attached: liveBrowser.pages.size,
              active: true,
            },
          ]
        : [],
      tabs,
    };
  },

  '/live/ensure': async () => {
    await liveBrowser.ensure();
    const tabs = await liveBrowser.list();
    return { ok: true, connected: true, profile: DAILY_PROFILE, cdpPort: LIVE_CDP_PORT, tabs };
  },

  '/tabs': async (body) => ({
    ok: true,
    tabs: body.live ? await liveBrowser.list() : await browser.list(),
  }),

  '/tabs/new': async (body) => {
    const wait = body.wait !== false;
    if (body.live) {
      const id = await liveBrowser.newTab(body.url || 'about:blank', { active: body.active !== false, wait });
      return { ok: true, tab: id, tabs: await liveBrowser.list() };
    }
    const id = await browser.newTab(body.url || 'about:blank', { active: body.active !== false, wait });
    return { ok: true, tab: id, tabs: await browser.list() };
  },

  '/tabs/activate': async (body) => {
    if (body.live) return { ...(await liveBrowser.activate(body.tab)), tabs: await liveBrowser.list() };
    const result = await browser.activate(body.tab);
    return { ...result, tabs: await browser.list() };
  },

  '/tabs/close': async (body) => {
    if (body.live) {
      const result = await liveBrowser.close(body.tab);
      return { ...result, tabs: await liveBrowser.list() };
    }
    const result = await browser.close(body.tab);
    return { ...result, tabs: await browser.list() };
  },

  '/tabs/detach': async (body) => {
    if (!body.live) throw new Error('tabs/detach is only meaningful in live mode');
    throw new Error('live CDP mode has no per-tab debugger attachment; just stop using the tab');
  },

  '/navigate': async (body) => {
    if (!body.url) throw new Error('navigate needs url');
    const page = await resolvePage(body);
    return { ok: true, ...(await page.navigate(body.url, body)) };
  },

  '/eval': async (body) => {
    if (!body.expression) throw new Error('eval needs expression');
    const page = await resolvePage(body);
    const value = await page.evaluate(body.expression, body);
    return { ok: true, tab: page.id, value, type: typeof value };
  },

  '/screenshot': async (body) => {
    const page = await resolvePage(body);
    if (body.live) await page.cdp.send('Page.bringToFront').catch(() => {});
    return await page.screenshot(body);
  },

  '/click': async (body) => {
    const page = await resolvePage(body);
    return await page.click(body);
  },

  '/hover': async (body) => {
    const page = await resolvePage(body);
    return await page.hover(body);
  },

  '/type': async (body) => {
    const page = await resolvePage(body);
    return await page.type(body);
  },

  '/press': async (body) => {
    const page = await resolvePage(body);
    return await page.press(body.keys ?? body.key);
  },

  '/scroll': async (body) => {
    const page = await resolvePage(body);
    return await page.scroll(body);
  },

  '/wait': async (body) => {
    const page = await resolvePage(body);
    return await page.waitFor(body);
  },

  '/html': async (body) => {
    const page = await resolvePage(body);
    return await page.getHtml(body);
  },

  '/text': async (body) => {
    const page = await resolvePage(body);
    return await page.getText(body);
  },

  '/snapshot': async (body) => {
    const page = await resolvePage(body);
    return await page.snapshot(body);
  },

  '/console': async (body) => {
    const page = await resolvePage(body);
    let entries = page.console.slice();
    if (body.level) entries = entries.filter((e) => e.level === body.level);
    if (body.filter) entries = entries.filter((e) => e.text.includes(body.filter));
    if (body.clear) page.console.length = 0;
    return { ok: true, tab: page.id, entries, count: entries.length };
  },

  '/network': async (body) => {
    const page = await resolvePage(body);
    let entries = [...page.network.values()];
    if (body.filter) entries = entries.filter((e) => (e.url || '').includes(body.filter));
    if (body.failedOnly) entries = entries.filter((e) => e.failed || (e.status && e.status >= 400));
    if (body.clear) page.network.clear();
    return { ok: true, tab: page.id, entries, count: entries.length };
  },

  '/network/body': async (body) => {
    const page = await resolvePage(body);
    if (!body.requestId) throw new Error('network/body needs requestId');
    const res = await page.cdp.send('Network.getResponseBody', { requestId: body.requestId }, { timeout: 30000 });
    return { ok: true, tab: page.id, body: res.body, base64Encoded: res.base64Encoded };
  },

  '/cookies': async (body) => {
    const page = await resolvePage(body);
    const action = body.action || 'get';
    if (action === 'get') return await page.getCookies(body.urls);
    if (action === 'set') {
      const cookie = body.cookie || {};
      if (!cookie.name) throw new Error('cookies set needs cookie.name');
      if (cookie.url === undefined && cookie.domain === undefined) cookie.url = page.url;
      return await page.setCookie(cookie);
    }
    if (action === 'clear') return await page.clearCookies();
    throw new Error(`unknown cookies action: ${action}`);
  },

  '/storage': async (body) => {
    const page = await resolvePage(body);
    const value = await page.storage(body);
    return { ok: true, tab: page.id, value };
  },

  '/upload': async (body) => {
    const page = await resolvePage(body);
    return await page.upload(body);
  },

  '/pdf': async (body) => {
    const page = await resolvePage(body);
    return await page.pdf(body);
  },

  '/dialog': async (body) => {
    const page = await resolvePage(body);
    if (body.policy) page.setDialogPolicy(body.policy);
    return await page.dialog(body);
  },

  '/dialog/policy': async (body) => {
    const page = await resolvePage(body);
    return page.setDialogPolicy(body.policy);
  },

  '/emulate': async (body) => {
    const page = await resolvePage(body);
    return await page.emulate(body);
  },

  '/devtools': async (body) => {
    const page = await resolvePage(body);
    return { ok: true, tab: page.id, url: page.devtoolsUrl(body.live ? liveBrowser.cdpOrigin : browser.cdpOrigin) };
  },

  '/downloads': async () => ({ ok: true, directory: DOWNLOADS_DIR, downloads: browser.downloads }),

  '/cdp': async (body) => {
    if (!body.method) throw new Error('cdp needs method');
    if (body.tab === 'browser' && !body.live) {
      const result = await browser.browserCdp.send(body.method, body.params || {}, { timeout: body.timeout ?? 60000 });
      return { ok: true, result };
    }
    const page = await resolvePage(body);
    const result = await page.cdp.send(body.method, body.params || {}, {
      timeout: body.timeout ?? 60000,
      sessionId: body.sessionId,
    });
    return { ok: true, result };
  },
};

function httpStatusFor(err) {
  if (err instanceof CdpError) {
    if (err.code === 'TIMEOUT') return 504;
    if (err.code === 'NOT_CONNECTED' || err.code === 'CLOSED') return 502;
    return 502;
  }
  if (/not found/i.test(err.message)) return 404;
  return 400;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`);

  if (url.pathname === '/ext-update.xml') {
    let version = '1.0.0';
    try {
      version = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8')).version || version;
    } catch {
      /* keep default */
    }
    if (!EXT_ID || !fs.existsSync(EXT_CRX)) {
      sendJson(res, 404, { ok: false, error: { message: 'extension.crx is not packed yet' } });
      return;
    }
    const xml =
      `<?xml version='1.0' encoding='UTF-8'?>\n` +
      `<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n` +
      `  <app appid='${EXT_ID}'>\n` +
      `    <updatecheck codebase='http://127.0.0.1:${BRIDGE_PORT}/ext.crx' version='${version}' />\n` +
      `  </app>\n` +
      `</gupdate>\n`;
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' });
    res.end(xml);
    return;
  }

  if (url.pathname === '/ext.crx') {
    if (!fs.existsSync(EXT_CRX)) {
      sendJson(res, 404, { ok: false, error: { message: 'extension.crx is not packed yet' } });
      return;
    }
    const buffer = fs.readFileSync(EXT_CRX);
    res.writeHead(200, {
      'content-type': 'application/x-chrome-extension',
      'content-length': buffer.length,
      'cache-control': 'no-store',
    });
    res.end(buffer);
    return;
  }

  if (url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      app: 'dsh-edge-bridge',
      version: VERSION,
      pid: process.pid,
      cdpPort: CDP_PORT,
      profile: PROFILE_DIR,
      edgeConnected: Boolean(browser.browserCdp?.connected),
      edge: browser.edgeInfo?.Browser || null,
      tabs: browser.pages.size,
      extensions: ext.status(),
      live: {
        connected: Boolean(liveBrowser.browserCdp?.connected),
        port: LIVE_CDP_PORT,
        profile: DAILY_PROFILE,
      },
    });
    return;
  }

  if (url.pathname.startsWith('/ext/')) {
    if (req.headers['x-dsh-ext-token'] !== EXT_TOKEN) {
      sendJson(res, 401, { ok: false, error: { message: 'invalid or missing x-dsh-ext-token' } });
      return;
    }
    let extBody;
    try {
      extBody = await readBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: { message: err.message } });
      return;
    }
    if (url.pathname === '/ext/poll') {
      const command = await ext.poll(extBody.browserId || 'unknown', extBody.version, extBody.events);
      if (!command) {
        res.writeHead(204);
        res.end();
        return;
      }
      sendJson(res, 200, command);
      return;
    }
    if (url.pathname === '/ext/result') {
      sendJson(res, 200, ext.result(extBody));
      return;
    }
    sendJson(res, 404, { ok: false, error: { message: `unknown extension endpoint: ${url.pathname}` } });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const token = stateToken;
  if (req.headers['x-dsh-token'] !== token) {
    sendJson(res, 401, { ok: false, error: { message: 'invalid or missing x-dsh-token' } });
    return;
  }

  let body;
  try {
    body = req.method === 'POST' ? await readBody(req) : {};
  } catch (err) {
    sendJson(res, 400, { ok: false, error: { message: err.message } });
    return;
  }

  try {
    if (url.pathname === '/shutdown') {
      const closeEdge = Boolean(body.closeEdge);
      sendJson(res, 200, { ok: true, closing: true, closeEdge });
      setTimeout(async () => {
        try {
          if (closeEdge) await browser.closeBrowser();
        } catch {
          /* ignore */
        }
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1500);
      }, 100);
      return;
    }

    const handler = routes[url.pathname];
    if (!handler) {
      sendJson(res, 404, { ok: false, error: { message: `unknown endpoint: ${url.pathname}` } });
      return;
    }
    const result = await handler(body);
    sendJson(res, 200, result);
  } catch (err) {
    log('request failed', url.pathname, err.message);
    sendJson(res, httpStatusFor(err), {
      ok: false,
      error: {
        message: err.message,
        code: err.code,
        data: err.data,
      },
    });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`bridge port ${BRIDGE_PORT} already in use`);
    process.exit(2);
  }
  log('server error', err.message);
  process.exit(1);
});

server.listen(BRIDGE_PORT, '127.0.0.1', () => {
  const state = {
    app: 'dsh-edge-bridge',
    version: VERSION,
    pid: process.pid,
    port: BRIDGE_PORT,
    cdpPort: CDP_PORT,
    token: stateToken,
    profile: PROFILE_DIR,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  log(`bridge listening on http://127.0.0.1:${BRIDGE_PORT} (cdp ${CDP_PORT}, profile ${PROFILE_DIR})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`received ${signal}, exiting`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000);
  });
}

