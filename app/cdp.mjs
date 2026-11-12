// Minimal Chrome DevTools Protocol client for Node 24+ (global WebSocket, no deps).

import { EventEmitter } from 'node:events';

export class CdpError extends Error {
  constructor(message, code, data) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
    this.data = data;
  }
}

export class Cdp extends EventEmitter {
  constructor(wsUrl, { label = 'cdp', timeout = 30000, connectTimeout = 10000 } = {}) {
    super();
    this.wsUrl = wsUrl;
    this.label = label;
    this.defaultTimeout = timeout;
    this.connectTimeout = connectTimeout;
    this.nextId = 0;
    this.pending = new Map();
    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.sessions = new Map();
  }

  async connect() {
    if (this.ws && this.ws.readyState === 1) return this;
    this.closed = false;
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.addEventListener('message', (ev) => {
      this.#onMessage(ev).catch((err) => {
        this.emit('protocolError', err);
      });
    });
    ws.addEventListener('close', () => {
      this.connected = false;
      this.closed = true;
      this.#rejectAll(new CdpError(`${this.label}: connection closed`, 'CLOSED'));
      this.emit('close');
    });
    // A listener is required so a socket error does not become an unhandled EventEmitter error.
    ws.addEventListener('error', () => {});

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new CdpError(`${this.label}: connect timeout (${this.wsUrl})`, 'CONNECT_TIMEOUT'));
      }, this.connectTimeout);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new CdpError(`${this.label}: cannot connect (${this.wsUrl})`, 'CONNECT_FAILED'));
        },
        { once: true },
      );
    });

    this.connected = true;
    return this;
  }

  async #onMessage(ev) {
    let raw = ev.data;
    if (typeof raw !== 'string') {
      if (raw instanceof ArrayBuffer) raw = Buffer.from(raw).toString('utf8');
      else if (typeof raw?.text === 'function') raw = await raw.text();
      else raw = String(raw);
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new CdpError(`${entry.method}: ${msg.error.message || 'CDP error'}`, msg.error.code, msg.error.data));
      } else {
        entry.resolve(msg.result ?? {});
      }
      return;
    }

    if (msg.method === 'Target.attachedToTarget') {
      const p = msg.params || {};
      this.sessions.set(p.sessionId, { targetId: p.targetInfo?.targetId, type: p.targetInfo?.type, url: p.targetInfo?.url });
      this.emit('attached', p);
    } else if (msg.method === 'Target.detachedFromTarget') {
      this.sessions.delete(msg.params?.sessionId);
      this.emit('detached', msg.params);
    }

    this.emit('*', msg.method, msg.params || {}, msg.sessionId);
    this.emit(msg.method, msg.params || {}, msg.sessionId);
  }

  #rejectAll(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  send(method, params = {}, { sessionId, timeout } = {}) {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new CdpError(`${this.label}: not connected`, 'NOT_CONNECTED'));
    }
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${this.label}: ${method} timed out after ${timeout ?? this.defaultTimeout}ms`, 'TIMEOUT'));
      }, timeout ?? this.defaultTimeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpError(`${this.label}: send failed: ${err.message}`, 'SEND_FAILED'));
      }
    });
  }

  close() {
    this.closed = true;
    this.connected = false;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.#rejectAll(new CdpError(`${this.label}: closed`, 'CLOSED'));
  }
}
