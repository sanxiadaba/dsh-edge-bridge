// One attached browser tab: navigation, input, screenshots, console and network capture.

import fs from 'node:fs';
import path from 'node:path';

const MAX_CONSOLE = 3000;
const MAX_NETWORK = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SPECIAL_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Esc: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Insert: { key: 'Insert', code: 'Insert', vk: 45 },
  F1: { key: 'F1', code: 'F1', vk: 112 },
  F2: { key: 'F2', code: 'F2', vk: 113 },
  F3: { key: 'F3', code: 'F3', vk: 114 },
  F4: { key: 'F4', code: 'F4', vk: 115 },
  F5: { key: 'F5', code: 'F5', vk: 116 },
  F6: { key: 'F6', code: 'F6', vk: 117 },
  F7: { key: 'F7', code: 'F7', vk: 118 },
  F8: { key: 'F8', code: 'F8', vk: 119 },
  F9: { key: 'F9', code: 'F9', vk: 120 },
  F10: { key: 'F10', code: 'F10', vk: 121 },
  F11: { key: 'F11', code: 'F11', vk: 122 },
  F12: { key: 'F12', code: 'F12', vk: 123 },
};

const PUNCT_CODE = {
  '-': 'Minus',
  '=': 'Equal',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  '`': 'Backquote',
};

export function formatRemoteObject(arg) {
  if (!arg) return 'undefined';
  if (Object.prototype.hasOwnProperty.call(arg, 'value')) {
    if (typeof arg.value === 'string') return arg.value;
    try {
      return JSON.stringify(arg.value);
    } catch {
      return String(arg.value);
    }
  }
  if (arg.unserializableValue !== undefined) return String(arg.unserializableValue);
  if (arg.preview) {
    if (arg.preview.description) return arg.preview.description;
    const props = (arg.preview.properties || [])
      .map((p) => `${p.name}: ${p.value ?? p.type}`)
      .join(', ');
    if (arg.preview.subtype === 'array') return `[${props}]`;
    return `{${props}}`;
  }
  return arg.description || arg.type || 'unknown';
}

function formatException(details) {
  const desc = details?.exception?.description;
  if (desc) return desc;
  const text = details?.text || 'JavaScript error';
  const where = details?.lineNumber !== undefined ? ` (line ${details.lineNumber + 1}:${(details.columnNumber ?? 0) + 1})` : '';
  return text + where;
}

// Build a page-context expression that evaluates to the selected element.
// Supported selectors: CSS, "text=...", "xpath=...", and shadow roots via ">>>".
export function selectorExpression(selector) {
  const raw = String(selector ?? '').trim();
  if (!raw) return 'null';
  if (raw.startsWith('xpath=')) {
    return `document.evaluate(${JSON.stringify(raw.slice(6))}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`;
  }
  if (raw.startsWith('text=')) {
    const text = raw.slice(5);
    return `(() => {
      const t = ${JSON.stringify(text)};
      const els = [...document.querySelectorAll('body *')];
      const exact = els.filter((e) => ((e.innerText || '').trim() === t));
      if (exact.length) return exact[exact.length - 1];
      const partial = els.filter((e) => ((e.innerText || '').includes(t)));
      partial.sort((a, b) => ((a.innerText || '').length - (b.innerText || '').length));
      return partial[0] || null;
    })()`;
  }
  if (raw.includes('>>>')) {
    const parts = raw.split('>>>').map((s) => s.trim()).filter(Boolean);
    let expr = `document.querySelector(${JSON.stringify(parts[0])})`;
    for (let i = 1; i < parts.length; i++) {
      expr = `(${expr})?.shadowRoot?.querySelector(${JSON.stringify(parts[i])})`;
    }
    return expr;
  }
  return `document.querySelector(${JSON.stringify(raw)})`;
}

function normalizeKey(name, modifiers) {
  const special = SPECIAL_KEYS[name] || SPECIAL_KEYS[name.charAt(0).toUpperCase() + name.slice(1)];
  if (special) return { ...special, text: special.text };

  const char = name;
  if (char.length !== 1) return { key: char, code: '', vk: 0 };
  const shift = Boolean(modifiers & 8);
  const letter = /[a-z]/i.test(char);
  const digit = /[0-9]/.test(char);
  const key = letter && shift ? char.toUpperCase() : char;
  const code = letter ? `Key${char.toUpperCase()}` : digit ? `Digit${char}` : PUNCT_CODE[char] || '';
  const vk = letter ? char.toUpperCase().charCodeAt(0) : digit ? char.charCodeAt(0) : 0;
  const hasCommandModifier = Boolean(modifiers & (1 | 2 | 4));
  const text = hasCommandModifier ? undefined : key;
  return { key, code, vk, text };
}

export class PageSession {
  constructor({ target, cdp, log }) {
    this.id = target.id;
    this.target = target;
    this.cdp = cdp;
    this.log = log || (() => {});
    this.url = target.url || '';
    this.title = target.title || '';
    this.console = [];
    this.network = new Map();
    this.dialogs = [];
    this.pendingDialog = null;
    this.dialogPolicy = 'dismiss';
    this.downloads = [];
    this.connected = true;
    this.enabled = false;

    this.cdp.on('*', (method, params) => this.#onEvent(method, params));
    this.cdp.on('close', () => {
      this.connected = false;
    });
  }

  async enable() {
    if (this.enabled) return;
    await Promise.all([
      this.cdp.send('Page.enable'),
      this.cdp.send('Runtime.enable'),
      this.cdp.send('Log.enable'),
      this.cdp.send('DOM.enable'),
      this.cdp.send('Accessibility.enable'),
      this.cdp.send('Network.enable', {
        maxTotalBufferSize: 100 * 1024 * 1024,
        maxResourceBufferSize: 50 * 1024 * 1024,
      }),
    ]);
    await this.cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => {});
    this.enabled = true;
  }

  #onEvent(method, params) {
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const text = (params.args || []).map(formatRemoteObject).join(' ');
        this.console.push({
          at: Date.now(),
          level: params.type,
          text,
          url: params.stackTrace?.callFrames?.[0]?.url,
        });
        if (this.console.length > MAX_CONSOLE) this.console.splice(0, this.console.length - MAX_CONSOLE);
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = params.exceptionDetails || {};
        this.console.push({
          at: Date.now(),
          level: 'exception',
          text: formatException(d),
          url: d.url,
        });
        if (this.console.length > MAX_CONSOLE) this.console.splice(0, this.console.length - MAX_CONSOLE);
        break;
      }
      case 'Log.entryAdded': {
        const e = params.entry || {};
        this.console.push({
          at: Date.now(),
          level: e.level || 'log',
          text: e.text || '',
          url: e.url,
        });
        if (this.console.length > MAX_CONSOLE) this.console.splice(0, this.console.length - MAX_CONSOLE);
        break;
      }
      case 'Network.requestWillBeSent': {
        const req = params.request || {};
        const entry = this.network.get(params.requestId) || { requestId: params.requestId, redirects: 0 };
        entry.url = req.url;
        entry.method = req.method;
        entry.resourceType = params.type;
        entry.at = Date.now();
        entry.requestHeaders = req.headers;
        entry.postData = req.postData;
        if (params.redirectResponse) entry.redirects += 1;
        this.network.set(params.requestId, entry);
        if (this.network.size > MAX_NETWORK) {
          const first = this.network.keys().next().value;
          this.network.delete(first);
        }
        break;
      }
      case 'Network.responseReceived': {
        const entry = this.network.get(params.requestId);
        if (!entry) break;
        const r = params.response || {};
        entry.status = r.status;
        entry.statusText = r.statusText;
        entry.mimeType = r.mimeType;
        entry.responseHeaders = r.headers;
        entry.fromDiskCache = r.fromDiskCache;
        entry.fromServiceWorker = r.fromServiceWorker;
        entry.protocol = r.protocol;
        break;
      }
      case 'Network.loadingFinished': {
        const entry = this.network.get(params.requestId);
        if (!entry) break;
        entry.encodedDataLength = params.encodedDataLength;
        entry.done = true;
        break;
      }
      case 'Network.loadingFailed': {
        const entry = this.network.get(params.requestId);
        if (!entry) break;
        entry.failed = params.errorText;
        entry.done = true;
        break;
      }
      case 'Page.frameNavigated': {
        const frame = params.frame || {};
        if (!frame.parentId) {
          this.url = frame.url || this.url;
          if (frame.name) this.title = frame.name;
        }
        break;
      }
      case 'Page.javascriptDialogOpening': {
        const dialog = {
          at: Date.now(),
          type: params.type,
          message: params.message,
          defaultPrompt: params.defaultPrompt,
          url: params.url,
        };
        this.dialogs.push(dialog);
        this.pendingDialog = dialog;
        const policy = this.dialogPolicy;
        if (policy === 'accept' || policy === 'dismiss') {
          this.cdp
            .send('Page.handleJavaScriptDialog', {
              accept: policy === 'accept',
              promptText: dialog.defaultPrompt || '',
            })
            .catch(() => {});
        }
        break;
      }
      case 'Page.javascriptDialogClosed': {
        this.pendingDialog = null;
        break;
      }
      default:
        break;
    }
  }

  assertNoDialog() {
    if (this.pendingDialog) {
      const d = this.pendingDialog;
      throw new Error(
        `a JavaScript ${d.type} dialog is open ("${String(d.message).slice(0, 120)}"); ` +
          'run "dshedge dialog --accept" or "dshedge dialog --dismiss" first',
      );
    }
  }

  async evaluate(expression, opts = {}) {
    this.assertNoDialog();
    const res = await this.cdp.send(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: opts.returnByValue !== false,
        awaitPromise: opts.awaitPromise !== false,
        userGesture: true,
        includeCommandLineAPI: true,
        allowUnsafeEvalBlockedByCSP: true,
      },
      { timeout: opts.timeout ?? 60000 },
    );
    if (res.exceptionDetails) throw new Error(formatException(res.exceptionDetails));
    const r = res.result;
    if (!r) return undefined;
    if (r.type === 'undefined') return undefined;
    if (Object.prototype.hasOwnProperty.call(r, 'value')) return r.value;
    return formatRemoteObject(r);
  }

  async getTitle() {
    return this.evaluate('document.title', { awaitPromise: false });
  }

  async waitForLoad(timeout = 30000) {
    const deadline = Date.now() + timeout;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate('document.readyState', { awaitPromise: false, timeout: 5000 });
        if (state === 'complete') {
          await sleep(120);
          return true;
        }
      } catch (err) {
        lastError = err;
      }
      await sleep(100);
    }
    throw new Error(`navigation did not reach readyState=complete in ${timeout}ms${lastError ? ` (${lastError.message})` : ''}`);
  }

  async navigate(url, { wait = true, timeout = 30000, referrer } = {}) {
    this.assertNoDialog();
    const res = await this.cdp.send('Page.navigate', { url, referrer });
    if (res.errorText) throw new Error(`navigation failed: ${res.errorText}`);
    if (res.isDownload) {
      this.log(`download started from ${url}`);
      return { tab: this.id, url, isDownload: true };
    }
    if (wait) await this.waitForLoad(timeout);
    await sleep(50);
    this.url = (await this.evaluate('location.href', { awaitPromise: false }).catch(() => url)) || url;
    this.title = (await this.getTitle().catch(() => '')) || '';
    return { tab: this.id, url: this.url, title: this.title, frameId: res.frameId };
  }

  async elementInfo(selector, { scroll = true } = {}) {
    const expr = selectorExpression(selector);
    return this.evaluate(`(() => {
      const el = ${expr};
      if (!el) return null;
      if (${scroll ? 'true' : 'false'}) el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const root = el.getRootNode ? el.getRootNode() : document;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const top = root && root.elementFromPoint ? root.elementFromPoint(x, y) : document.elementFromPoint(x, y);
      return {
        tag: el.tagName,
        id: el.id || '',
        cls: el.className ? String(el.className).slice(0, 120) : '',
        text: String(el.innerText || el.value || el.getAttribute('aria-label') || '').slice(0, 160),
        x, y, w: r.width, h: r.height,
        visible: r.width > 0 && r.height > 0,
        covered: Boolean(top && top !== el && !el.contains(top) && !top.contains(el)),
        topTag: top ? top.tagName : null,
      };
    })()`);
  }

  async click({ selector, x, y, button = 'left', count = 1, modifiers = 0, force = false } = {}) {
    this.assertNoDialog();
    let info = null;
    if (selector) {
      info = await this.elementInfo(selector);
      if (!info) throw new Error(`element not found: ${selector}`);
      if (!info.visible) throw new Error(`element is not visible: ${selector}`);
      if (force) {
        await this.evaluate(`(() => { const el = ${selectorExpression(selector)}; el.click(); return true; })()`);
        return { ok: true, forced: true, tab: this.id, element: info };
      }
      x = info.x;
      y = info.y;
    }
    if (typeof x !== 'number' || typeof y !== 'number') throw new Error('click needs a selector or x/y coordinates');
    try {
      await this.cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x, y, button: 'none', modifiers },
        { timeout: 8000 },
      );
      for (let i = 1; i <= count; i++) {
        await this.cdp.send(
          'Input.dispatchMouseEvent',
          { type: 'mousePressed', x, y, button, modifiers, clickCount: i },
          { timeout: 8000 },
        );
        await this.cdp.send(
          'Input.dispatchMouseEvent',
          { type: 'mouseReleased', x, y, button, modifiers, clickCount: i },
          { timeout: 8000 },
        );
      }
    } catch (err) {
      if (err.code === 'TIMEOUT' && this.pendingDialog) {
        return { ok: true, tab: this.id, x, y, button, element: info, dialogPending: true };
      }
      throw err;
    }
    return { ok: true, tab: this.id, x, y, button, element: info };
  }

  async hover({ selector, x, y, modifiers = 0 } = {}) {
    this.assertNoDialog();
    let info = null;
    if (selector) {
      info = await this.elementInfo(selector);
      if (!info) throw new Error(`element not found: ${selector}`);
      x = info.x;
      y = info.y;
    }
    if (typeof x !== 'number' || typeof y !== 'number') throw new Error('hover needs a selector or x/y coordinates');
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', modifiers });
    return { ok: true, tab: this.id, x, y, element: info };
  }

  async type({ selector, text = '', clear = false, submit = false, delay = 0 } = {}) {
    this.assertNoDialog();
    if (selector) {
      const focused = await this.evaluate(`(() => {
        const el = ${selectorExpression(selector)};
        if (!el) return false;
        el.focus();
        if (el.select) el.select();
        return true;
      })()`);
      if (!focused) throw new Error(`element not found: ${selector}`);
    }
    if (clear) {
      await this.press('Control+a');
      await this.press('Backspace');
    }
    if (delay > 0) {
      for (const ch of text) {
        await this.cdp.send('Input.insertText', { text: ch });
        await sleep(delay);
      }
    } else {
      await this.cdp.send('Input.insertText', { text });
    }
    if (submit) await this.press('Enter');
    return { ok: true, tab: this.id, length: text.length, submitted: Boolean(submit) };
  }

  async press(keys) {
    this.assertNoDialog();
    const list = Array.isArray(keys) ? keys : [keys];
    for (const combo of list) await this.#pressCombo(String(combo));
    return { ok: true, tab: this.id, keys: list };
  }

  async #pressCombo(combo) {
    const parts = combo.split('+').filter((p) => p.length > 0);
    let modifiers = 0;
    while (parts.length > 1) {
      const head = parts[0].toLowerCase();
      if (head === 'alt') modifiers |= 1;
      else if (head === 'ctrl' || head === 'control') modifiers |= 2;
      else if (head === 'meta' || head === 'cmd' || head === 'command' || head === 'win') modifiers |= 4;
      else if (head === 'shift') modifiers |= 8;
      else break;
      parts.shift();
    }
    if (!parts.length) throw new Error(`invalid key combo: ${combo}`);
    const def = normalizeKey(parts.join('+'), modifiers);
    const base = {
      modifiers,
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.vk,
      nativeVirtualKeyCode: def.vk,
    };
    const down = { ...base, type: def.text !== undefined ? 'keyDown' : 'rawKeyDown' };
    if (def.text !== undefined) {
      down.text = def.text;
      down.unmodifiedText = def.text;
    }
    await this.cdp.send('Input.dispatchKeyEvent', down);
    await this.cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    await sleep(20);
  }

  async scroll({ x, y, deltaX = 0, deltaY = 0, selector } = {}) {
    this.assertNoDialog();
    if (selector) {
      const info = await this.elementInfo(selector);
      if (!info) throw new Error(`element not found: ${selector}`);
      x = info.x;
      y = info.y;
    }
    if (typeof x !== 'number' || typeof y !== 'number') {
      const vp = await this.evaluate('({ x: innerWidth / 2, y: innerHeight / 2 })', { awaitPromise: false });
      x = vp.x;
      y = vp.y;
    }
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
    });
    return { ok: true, tab: this.id, x, y, deltaX, deltaY };
  }

  async waitFor({ selector, fn, timeout = 15000, interval = 150 } = {}) {
    const deadline = Date.now() + timeout;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        if (selector) {
          const ok = await this.evaluate(`Boolean(${selectorExpression(selector)})`, {
            awaitPromise: false,
            timeout: 5000,
          });
          if (ok) return { ok: true, tab: this.id, selector, elapsed: timeout - (deadline - Date.now()) };
        } else if (fn) {
          const trimmed = fn.trim();
          const callable = trimmed.includes('=>') || trimmed.startsWith('function') || trimmed.startsWith('async');
          const expr = callable ? `Boolean((${trimmed})())` : `Boolean(${trimmed})`;
          const ok = await this.evaluate(expr, { awaitPromise: true, timeout: 5000 });
          if (ok) return { ok: true, tab: this.id, fn, elapsed: timeout - (deadline - Date.now()) };
        } else {
          throw new Error('wait needs a selector or fn');
        }
      } catch (err) {
        lastError = err;
      }
      await sleep(interval);
    }
    throw new Error(`wait timed out after ${timeout}ms${lastError ? ` (${lastError.message})` : ''}`);
  }

  async screenshot({ file, fullPage = false, format = 'png', quality, selector, clip } = {}) {
    this.assertNoDialog();
    let width;
    let height;
    let warning;
    let res;

    if (fullPage && !selector && !this.live) {
      const metrics = await this.cdp.send('Page.getLayoutMetrics');
      const size = metrics.cssContentSize || metrics.contentSize;
      const vp = await this.evaluate('({ width: innerWidth, height: innerHeight })', { awaitPromise: false });
      width = Math.max(Math.ceil(size.width), vp.width);
      const fullHeight = Math.ceil(size.height);

      if (fullHeight <= vp.height + 1) {
        res = await this.cdp.send('Page.captureScreenshot', { format, fromSurface: true }, { timeout: 20000 });
        width = vp.width;
        height = vp.height;
      } else {
        const targetHeight = Math.min(fullHeight, 16384);
        if (targetHeight < fullHeight) warning = `page is ${fullHeight}px tall; captured the first 16384px`;
        await this.cdp.send('Emulation.setDeviceMetricsOverride', {
          width,
          height: targetHeight,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await sleep(200);
        try {
          res = await this.cdp.send('Page.captureScreenshot', { format, fromSurface: true }, { timeout: 20000 });
          height = targetHeight;
        } finally {
          // Explicitly restore the window viewport first: clear alone can leave a stale
          // override behind when the renderer was busy.
          await this.cdp
            .send('Emulation.setDeviceMetricsOverride', {
              width: vp.width,
              height: vp.height,
              deviceScaleFactor: 1,
              mobile: false,
            })
            .catch(() => {});
          await this.cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
        }
      }
    } else {
      if (this.live && fullPage && !selector) {
        // Do not resize the user's real tab with emulation; capture a clipped surface.
        const metrics = await this.cdp.send('Page.getLayoutMetrics');
        const size = metrics.cssContentSize || metrics.contentSize;
        clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
        width = clip.width;
        height = clip.height;
      } else if (selector) {
        const rect = await this.evaluate(`(() => {
          const el = ${selectorExpression(selector)};
          if (!el) return null;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const r = el.getBoundingClientRect();
          return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
        })()`);
        if (!rect) throw new Error(`element not found: ${selector}`);
        clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 };
        width = Math.ceil(rect.width);
        height = Math.ceil(rect.height);
      } else {
        const vp = await this.evaluate('({ width: innerWidth, height: innerHeight })', { awaitPromise: false });
        width = vp.width;
        height = vp.height;
      }

      if (clip) {
        clip = {
          x: Math.max(0, Math.round(clip.x)),
          y: Math.max(0, Math.round(clip.y)),
          width: Math.round(clip.width),
          height: Math.round(clip.height),
          scale: 1,
        };
        if (clip.width <= 0 || clip.height <= 0) {
          clip = undefined;
          width = undefined;
          height = undefined;
        }
      }

      const params = { format, fromSurface: true, captureBeyondViewport: Boolean(clip) };
      if (quality !== undefined && format === 'jpeg') params.quality = quality;
      if (clip) params.clip = clip;

      try {
        res = await this.cdp.send('Page.captureScreenshot', params, { timeout: 20000 });
      } catch (err) {
        if (err.code !== 'TIMEOUT') throw err;
        // Edge occasionally hangs on clipped captures; a viewport capture still succeeds.
        res = await this.cdp.send('Page.captureScreenshot', { format, fromSurface: true }, { timeout: 20000 });
        warning = 'clipped screenshot timed out; captured the visible viewport instead';
        width = undefined;
        height = undefined;
      }
    }

    const buf = Buffer.from(res.data, 'base64');
    let outPath = file;
    if (!outPath && this.defaultScreenshotPath) outPath = this.defaultScreenshotPath();
    if (!outPath) outPath = path.join(process.cwd(), `screenshot-${Date.now()}.${format}`);
    outPath = path.resolve(outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
    return {
      ok: true,
      tab: this.id,
      path: outPath,
      bytes: buf.length,
      width,
      height,
      url: this.url,
      title: this.title,
      ...(warning ? { warning } : {}),
    };
  }

  async getHtml({ selector, outer = true } = {}) {
    const expr = selector
      ? `(() => { const el = ${selectorExpression(selector)}; return el ? (${outer ? 'el.outerHTML' : 'el.innerHTML'}) : null; })()`
      : 'document.documentElement.outerHTML';
    const html = await this.evaluate(expr, { awaitPromise: false });
    if (html == null) throw new Error(`element not found: ${selector}`);
    return { ok: true, tab: this.id, html: String(html).slice(0, 500000), length: String(html).length };
  }

  async getText({ selector } = {}) {
    const expr = selector
      ? `(() => { const el = ${selectorExpression(selector)}; return el ? (el.innerText || el.textContent || '') : null; })()`
      : `(document.body ? document.body.innerText : '')`;
    const text = await this.evaluate(expr, { awaitPromise: false });
    if (text == null) throw new Error(`element not found: ${selector}`);
    return { ok: true, tab: this.id, text: String(text).slice(0, 300000), length: String(text).length };
  }

  async snapshot({ maxNodes = 1200 } = {}) {
    this.assertNoDialog();
    const res = await this.cdp.send('Accessibility.getFullAXTree', {}, { timeout: 60000 });
    const nodes = res.nodes || [];
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const seen = new Set();
    const lines = [];
    const containerRoles = new Set(['button', 'link', 'heading', 'textbox', 'listitem', 'cell', 'tab', 'option']);
    for (const n of nodes) {
      if (lines.length >= maxNodes) break;
      if (n.ignored) continue;
      const role = n.role?.value;
      if (!role || role === 'none' || role === 'InlineTextBox') continue;
      const name = (n.name?.value || '').trim();
      const value = n.value?.value;
      const parent = n.parentId ? byId.get(n.parentId) : null;
      if (
        role === 'StaticText' &&
        parent &&
        containerRoles.has(parent.role?.value) &&
        (parent.name?.value || '').trim() === name
      ) {
        continue;
      }
      if (!name && value === undefined && ['generic', 'StaticText'].includes(role)) continue;
      const line = `${role}${name ? ` "${name.slice(0, 120)}"` : ''}${
        value !== undefined && value !== '' ? ` value="${String(value).slice(0, 100)}"` : ''
      }`;
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
    return {
      ok: true,
      tab: this.id,
      url: this.url,
      title: this.title,
      text: lines.join('\n'),
      nodes: lines.length,
    };
  }

  async getCookies(urls) {
    const res = await this.cdp.send('Network.getCookies', { urls: urls && urls.length ? urls : [this.url] });
    return { ok: true, tab: this.id, cookies: res.cookies || [] };
  }

  async setCookie(cookie) {
    const res = await this.cdp.send('Network.setCookie', cookie);
    return { ok: Boolean(res.success), tab: this.id, cookie };
  }

  async clearCookies() {
    await this.cdp.send('Network.clearBrowserCookies');
    return { ok: true, tab: this.id };
  }

  async storage({ area = 'local', action = 'get', key, value } = {}) {
    const store = area === 'session' ? 'sessionStorage' : 'localStorage';
    if (action === 'get') {
      return this.evaluate(`(() => {
        const s = ${store};
        const k = ${key === undefined ? 'null' : JSON.stringify(key)};
        if (k !== null) return s.getItem(k);
        const out = {};
        for (let i = 0; i < s.length; i++) { const kk = s.key(i); out[kk] = s.getItem(kk); }
        return out;
      })()`);
    }
    if (action === 'set') {
      if (key === undefined) throw new Error('storage set needs a key');
      await this.evaluate(`(() => { ${store}.setItem(${JSON.stringify(key)}, ${JSON.stringify(String(value))}); return true; })()`);
      return { ok: true, tab: this.id, area, key };
    }
    if (action === 'remove') {
      if (key === undefined) throw new Error('storage remove needs a key');
      await this.evaluate(`(() => { ${store}.removeItem(${JSON.stringify(key)}); return true; })()`);
      return { ok: true, tab: this.id, area, key };
    }
    if (action === 'clear') {
      await this.evaluate(`(() => { ${store}.clear(); return true; })()`);
      return { ok: true, tab: this.id, area };
    }
    throw new Error(`unknown storage action: ${action}`);
  }

  async upload({ selector, files } = {}) {
    if (!selector) throw new Error('upload needs a selector');
    if (!files || !files.length) throw new Error('upload needs at least one file');
    const resolved = files.map((f) => path.resolve(f));
    for (const f of resolved) {
      if (!fs.existsSync(f)) throw new Error(`file not found: ${f}`);
    }
    const { root } = await this.cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await this.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`file input not found: ${selector}`);
    await this.cdp.send('DOM.setFileInputFiles', { files: resolved, nodeId });
    return { ok: true, tab: this.id, selector, files: resolved };
  }

  async pdf({ file, landscape = false, printBackground = true } = {}) {
    const res = await this.cdp.send(
      'Page.printToPDF',
      { printBackground, landscape, preferCSSPageSize: true },
      { timeout: 60000 },
    );
    const buf = Buffer.from(res.data, 'base64');
    const outPath = path.resolve(file || path.join(process.cwd(), `page-${Date.now()}.pdf`));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
    return { ok: true, tab: this.id, path: outPath, bytes: buf.length };
  }

  async dialog({ accept = false, promptText } = {}) {
    if (!this.pendingDialog) return { ok: true, tab: this.id, dialog: null };
    const dialog = this.pendingDialog;
    await this.cdp.send('Page.handleJavaScriptDialog', {
      accept: Boolean(accept),
      promptText: promptText ?? dialog.defaultPrompt ?? '',
    });
    this.pendingDialog = null;
    return { ok: true, tab: this.id, dialog };
  }

  async emulate({ offline, latency, downloadKbps, uploadKbps, width, height, deviceScaleFactor, mobile, userAgent, reset } = {}) {
    if (reset) {
      await this.cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      await this.cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      return { ok: true, tab: this.id, reset: true };
    }
    if (offline !== undefined || latency !== undefined || downloadKbps !== undefined || uploadKbps !== undefined) {
      await this.cdp.send('Network.emulateNetworkConditions', {
        offline: Boolean(offline),
        latency: latency ?? 0,
        downloadThroughput: downloadKbps === undefined ? -1 : (downloadKbps * 1024) / 8,
        uploadThroughput: uploadKbps === undefined ? -1 : (uploadKbps * 1024) / 8,
      });
    }
    if (width && height) {
      await this.cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: deviceScaleFactor ?? 1,
        mobile: Boolean(mobile),
      });
    }
    if (userAgent) {
      await this.cdp.send('Emulation.setUserAgentOverride', { userAgent });
    }
    return { ok: true, tab: this.id };
  }

  setDialogPolicy(policy) {
    if (!['accept', 'dismiss', 'manual'].includes(policy)) {
      throw new Error(`unknown dialog policy: ${policy} (use accept, dismiss or manual)`);
    }
    this.dialogPolicy = policy;
    return { ok: true, tab: this.id, policy };
  }

  devtoolsUrl(cdpOrigin) {
    const ws = this.target.webSocketDebuggerUrl || '';
    const path = ws.replace(/^wss?:\/\//, '');
    return `${cdpOrigin}/devtools/inspector.html?ws=${path}`;
  }

  dispose() {
    this.connected = false;
    try {
      this.cdp.close();
    } catch {
      /* ignore */
    }
  }
}
