// Couch.gg bridge for the original Trebuchet scene.
//
// The upstream Trebuchet client imports a tiny `net` singleton and listens for
// server-shaped messages: start, shot, turn, left. In couch.gg those messages
// arrive through the React/Socket.IO shell, so this module keeps the original
// scene API intact while delegating transport to `window.__couchTrebuchetBridge`.

class CouchTrebuchetNet {
  constructor() {
    this.you = null;
    this.code = null;
    this.local = null;
    this._listeners = new Map();
  }

  connect() {
    this.emit('open', {});
  }

  send(message) {
    const bridge = window.__couchTrebuchetBridge;
    if (bridge && typeof bridge.send === 'function') {
      bridge.send(message);
    }
  }

  on(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }

  off(type, fn) {
    const set = this._listeners.get(type);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) this._listeners.delete(type);
  }

  emit(type, payload) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (err) {
        console.error('Trebuchet listener failed', err);
      }
    }
  }
}

export const net = window.__couchTrebuchetNet || new CouchTrebuchetNet();
window.__couchTrebuchetNet = net;

export default net;
