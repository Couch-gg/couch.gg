// net.js — tiny robust event-emitter WebSocket wrapper.
//
// Public API (per CONTRACT.md §3):
//   import { net } from '/js/net.js';
//   net.connect();            // ws(s)://location.host/ws  (wss when page is https)
//   net.send(obj);            // JSON-encodes; queues until socket is open
//   net.on(type, fn);         // type = message .t, plus synthetic 'open' / 'close'
//   net.off(type, fn);
//   net.you;                  // your player id  (set from 'joined')
//   net.code;                 // current room code (set from 'joined')
//
// Multiple listeners per type are supported. No auto-reconnect (v1: refresh to
// rejoin); a 'close' event is emitted so the UI can surface a banner.

class Net {
  constructor() {
    /** @type {WebSocket|null} */
    this.ws = null;
    /** Outbound JSON strings buffered while the socket isn't OPEN. */
    this._queue = [];
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();

    this.you = null;
    this.code = null;

    // Guard so connect() is idempotent if called more than once.
    this._connecting = false;
    this._closedEmitted = false;
  }

  /** Open the WebSocket. Safe to call once; repeat calls are ignored. */
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (this._connecting) return;
    this._connecting = true;
    this._closedEmitted = false;

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/ws`;

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      // Construction itself can throw (e.g. bad URL). Treat as a close.
      this._connecting = false;
      this._emitClose();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this._connecting = false;
      // Flush anything queued while connecting.
      const pending = this._queue;
      this._queue = [];
      for (const raw of pending) {
        this._rawSend(raw);
      }
      this._emit('open', {});
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (err) {
        // Ignore malformed frames — never let bad input break the client.
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
        return;
      }

      // Auto-capture identity from the 'joined' handshake.
      if (msg.t === 'joined') {
        if (typeof msg.you === 'string') this.you = msg.you;
        if (typeof msg.code === 'string') this.code = msg.code;
      }

      this._emit(msg.t, msg);
    };

    ws.onerror = () => {
      // The browser fires 'error' then 'close'; we surface the banner on close.
      // Nothing to do here, but swallow so it never bubbles as uncaught.
    };

    ws.onclose = () => {
      this._connecting = false;
      this._emitClose();
    };
  }

  /**
   * Send a JSON-serializable object. If the socket is not yet OPEN, the message
   * is queued and flushed automatically on open.
   * @param {object} obj
   */
  send(obj) {
    let raw;
    try {
      raw = JSON.stringify(obj);
    } catch (err) {
      // Non-serializable payload — drop it rather than throw.
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._rawSend(raw);
    } else {
      this._queue.push(raw);
    }
  }

  _rawSend(raw) {
    try {
      this.ws.send(raw);
    } catch (err) {
      // If the socket died mid-send, re-queue so a future open can retry.
      this._queue.push(raw);
    }
  }

  /**
   * Subscribe to a message type ('open', 'close', or any server msg .t).
   * @param {string} type
   * @param {Function} fn
   */
  on(type, fn) {
    if (typeof type !== 'string' || typeof fn !== 'function') return;
    let set = this._listeners.get(type);
    if (!set) {
      set = new Set();
      this._listeners.set(type, set);
    }
    set.add(fn);
  }

  /**
   * Unsubscribe a previously registered listener.
   * @param {string} type
   * @param {Function} fn
   */
  off(type, fn) {
    const set = this._listeners.get(type);
    if (set) {
      set.delete(fn);
      if (set.size === 0) this._listeners.delete(type);
    }
  }

  _emit(type, payload) {
    const set = this._listeners.get(type);
    if (!set || set.size === 0) return;
    // Snapshot so listeners may safely off() themselves during dispatch.
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (err) {
        // A throwing listener must not stop the others.
        // eslint-disable-next-line no-console
        console.error('[net] listener error for', type, err);
      }
    }
  }

  _emitClose() {
    // Only emit a single 'close' per connection lifecycle.
    if (this._closedEmitted) return;
    this._closedEmitted = true;
    this._emit('close', {});
  }
}

// Singleton, per contract.
export const net = new Net();
