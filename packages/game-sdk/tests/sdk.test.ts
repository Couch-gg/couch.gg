import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CouchSDK } from '../src/index';
import {
  isCouchMessage,
  type CouchManifest,
  type CouchMessage,
  type CouchPlayer
} from '../src/protocol';

// ---------------------------------------------------------------------------
// Test harness: simulate an embedded iframe.
//
// In happy-dom, window.parent === window.self === window.top by default. We
// override `top` (so `self !== top` ⇒ embedded) and `parent` (a fake window with
// a postMessage spy that captures the game's outbound messages). Host->game
// messages are delivered as MessageEvents whose `source` is that same fake
// parent, satisfying the SDK's identity check.
// ---------------------------------------------------------------------------

interface Harness {
  posted: CouchMessage[];
  fakeParent: { postMessage: ReturnType<typeof vi.fn> };
  /** Deliver a host->game message with the given `source` (defaults to parent). */
  deliver(msg: unknown, source?: unknown): void;
  restore(): void;
}

const originalParent = Object.getOwnPropertyDescriptor(window, 'parent');
const originalTop = Object.getOwnPropertyDescriptor(window, 'top');

function embed(): Harness {
  const posted: CouchMessage[] = [];
  const fakeParent = {
    postMessage: vi.fn((msg: CouchMessage) => {
      posted.push(msg);
    })
  };
  Object.defineProperty(window, 'parent', { value: fakeParent, configurable: true });
  Object.defineProperty(window, 'top', { value: {}, configurable: true });

  return {
    posted,
    fakeParent,
    deliver(msg: unknown, source: unknown = fakeParent) {
      window.dispatchEvent(new MessageEvent('message', { data: msg, source: source as Window }));
    },
    restore() {
      if (originalParent) Object.defineProperty(window, 'parent', originalParent);
      if (originalTop) Object.defineProperty(window, 'top', originalTop);
    }
  };
}

/** Restore standalone (top-level) window relations for dev-mode tests. */
function standalone(): void {
  if (originalParent) Object.defineProperty(window, 'parent', originalParent);
  if (originalTop) Object.defineProperty(window, 'top', originalTop);
}

const manifest: CouchManifest = {
  id: 'test-game',
  title: 'Test Game',
  description: 'a game for tests',
  minPlayers: 1,
  maxPlayers: 8,
  aspectRatio: '16:9',
  estimatedDurationMinutes: 3,
  controllerLayout: {
    kind: 'generic-buttons',
    controls: [
      { control: 'tap', type: 'button', label: 'Tap' },
      { control: 'charge', type: 'hold', label: 'Charge' },
      { control: 'aim', type: 'slider', label: 'Aim', min: 0, max: 100, step: 1 },
      { control: 'mode', type: 'select', label: 'Mode', options: ['a', 'b'] }
    ]
  }
};

const players: CouchPlayer[] = [
  { id: 'p1', name: 'One', colorIdx: 0, connected: true },
  { id: 'p2', name: 'Two', colorIdx: 1, connected: true }
];

function initMessage(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    type: 'couch:init',
    protocol: 1,
    mode: 'live',
    manifest,
    players,
    seed: 'seed-xyz',
    locale: 'en-GB',
    reducedMotion: false,
    latencyTier: 'local',
    ...overrides
  };
}

afterEach(() => {
  // Always restore window relations + clean simulator DOM between tests.
  if (originalParent) Object.defineProperty(window, 'parent', originalParent);
  if (originalTop) Object.defineProperty(window, 'top', originalTop);
  document.getElementById('couch-sim-root')?.remove();
  document.getElementById('couch-sim-style')?.remove();
  vi.useRealTimers();
});

describe('CouchSDK.init — embedded handshake', () => {
  it('1. posts hello immediately, retries every 250ms, and stops after init', async () => {
    vi.useFakeTimers();
    const h = embed();

    const initPromise = CouchSDK.init({ manifest });

    // Immediate hello.
    expect(h.posted.filter((m) => m.type === 'couch:hello')).toHaveLength(1);

    // Two more intervals ⇒ 3 total.
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(250);
    expect(h.posted.filter((m) => m.type === 'couch:hello')).toHaveLength(3);

    // Deliver init; hello must stop.
    h.deliver(initMessage());
    await initPromise;

    const helloBefore = h.posted.filter((m) => m.type === 'couch:hello').length;
    vi.advanceTimersByTime(2000);
    const helloAfter = h.posted.filter((m) => m.type === 'couch:hello').length;
    expect(helloAfter).toBe(helloBefore);

    h.restore();
  });

  it('2. init resolves with players/seed/mode; auto-sends couch:ready', async () => {
    const h = embed();
    const p = CouchSDK.init({ manifest });
    h.deliver(initMessage({ mode: 'test', seed: 'abc123' }));
    const couch = await p;

    expect(couch.mode).toBe('test');
    expect(couch.seed).toBe('abc123');
    expect(couch.locale).toBe('en-GB');
    expect(couch.latencyTier).toBe('local');
    expect(couch.players.map((pl) => pl.id)).toEqual(['p1', 'p2']);
    expect(h.posted.some((m) => m.type === 'couch:ready')).toBe(true);

    h.restore();
  });
});

describe('CouchSDK.init — no host answers', () => {
  it('warns and falls back to the simulator after the last hello, then ignores a late init', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = embed();
    let settled = false;
    const p = CouchSDK.init({ manifest }).then((c) => {
      settled = true;
      return c;
    });

    // 40 hellos (one now, 39 more every 250 ms), then a grace period for the last answer.
    vi.advanceTimersByTime(39 * 250);
    expect(h.posted.filter((m) => m.type === 'couch:hello')).toHaveLength(40);
    vi.advanceTimersByTime(999);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    const couch = await p;
    expect(couch.mode).toBe('dev');
    expect(couch.players).toHaveLength(2);
    expect(document.getElementById('couch-sim-root')).not.toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('No couch.gg host answered'))).toBe(true);

    // No host can take over a game that already fell back.
    h.deliver(initMessage());
    expect(couch.mode).toBe('dev');
    expect(h.posted.some((m) => m.type === 'couch:ready')).toBe(false);
    warn.mockRestore();
    h.restore();
  });

  it('a host answering the last hello within the grace period still wins', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = embed();
    const p = CouchSDK.init({ manifest });
    vi.advanceTimersByTime(39 * 250 + 500);
    h.deliver(initMessage());
    const couch = await p;
    vi.advanceTimersByTime(5_000);
    expect(couch.mode).toBe('live');
    expect(warn).not.toHaveBeenCalled();
    expect(document.getElementById('couch-sim-root')).toBeNull();
    warn.mockRestore();
    h.restore();
  });
});

describe('CouchSDK abort on teardown', () => {
  it('fires abort once when the frame is torn down (pagehide), even if the host message also lands', async () => {
    const h = embed();
    const p = CouchSDK.init({ manifest });
    h.deliver(initMessage());
    const couch = await p;
    const aborted = vi.fn();
    couch.on('abort', aborted);

    window.dispatchEvent(new Event('pagehide'));
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(aborted).toHaveBeenCalledWith({ reason: 'host-unmounted' });

    h.deliver({ v: 1, type: 'couch:abort', reason: 'host-unmounted' });
    window.dispatchEvent(new Event('pagehide'));
    expect(aborted).toHaveBeenCalledTimes(1);
    h.restore();
  });

  it('ignores a pagehide into the back/forward cache (the page may come back)', async () => {
    const h = embed();
    const p = CouchSDK.init({ manifest });
    h.deliver(initMessage());
    const couch = await p;
    const aborted = vi.fn();
    couch.on('abort', aborted);

    window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
    expect(aborted).not.toHaveBeenCalled();
    h.restore();
  });
});

describe('CouchSDK listener isolation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a throwing listener is logged, reported as uncaught, and the others still run', async () => {
    const h = embed();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reported = vi.fn();
    vi.stubGlobal('reportError', reported);
    const p = CouchSDK.init({
      manifest,
      onInput(i) {
        throw new Error(`game bug ${i.seq}`);
      }
    });
    h.deliver(initMessage());
    const couch = await p;
    const seen: number[] = [];
    couch.on('input', (i) => seen.push(i.seq));

    for (const seq of [1, 2]) {
      h.deliver({ v: 1, type: 'couch:input', input: { seq, at: seq, playerId: 'p1', control: 'tap', action: 'press' } });
    }
    expect(seen).toEqual([1, 2]);
    expect(couch.lastSeq).toBe(2);
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0][0])).toContain("'input' listener threw");
    // Handed to the page's error handlers (window 'error', error trackers).
    expect(reported.mock.calls.map((c) => (c[0] as Error).message)).toEqual(['game bug 1', 'game bug 2']);
    error.mockRestore();
    h.restore();
  });

  it('without reportError the error is rethrown from a timer, after the other listeners ran', async () => {
    const h = embed();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('reportError', undefined);
    const p = CouchSDK.init({ manifest });
    h.deliver(initMessage());
    const couch = await p;
    vi.useFakeTimers();
    const seen: number[] = [];
    couch.on('input', () => {
      throw new Error('game bug');
    });
    couch.on('input', (i) => seen.push(i.seq));

    h.deliver({ v: 1, type: 'couch:input', input: { seq: 1, at: 1, playerId: 'p1', control: 'tap', action: 'press' } });
    expect(seen).toEqual([1]);
    expect(() => vi.runAllTimers()).toThrow('game bug');
    error.mockRestore();
    h.restore();
  });

  it('on() with an unknown event warns and returns a no-op unsubscribe', async () => {
    const h = embed();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = CouchSDK.init({ manifest });
    h.deliver(initMessage());
    const couch = await p;
    const on = couch.on as (event: string, cb: () => void) => () => void;

    for (const name of ['latency', 'toString', 'constructor']) {
      const off = on(name, () => {});
      expect(typeof off).toBe('function');
      expect(() => off()).not.toThrow();
    }
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0][0])).toContain("on('latency'): unknown event");
    warn.mockRestore();
    h.restore();
  });
});

describe('CouchSDK input delivery', () => {
  it('3. inputs dispatch in order to onInput + on("input"); unsubscribe works', async () => {
    const h = embed();
    const onInput = vi.fn();
    const subSeen: number[] = [];

    const couch = await (async () => {
      const p = CouchSDK.init({ manifest, onInput });
      h.deliver(initMessage());
      return p;
    })();

    const unsub = couch.on('input', (i) => subSeen.push(i.seq));

    for (let seq = 1; seq <= 3; seq += 1) {
      h.deliver({
        v: 1,
        type: 'couch:input',
        input: { seq, at: seq, playerId: 'p1', control: 'tap', action: 'press' }
      });
    }

    expect(onInput.mock.calls.map((c) => c[0].seq)).toEqual([1, 2, 3]);
    expect(subSeen).toEqual([1, 2, 3]);
    expect(couch.lastSeq).toBe(3);

    // Unsubscribe: subscriber stops, convenience callback keeps firing.
    unsub();
    h.deliver({
      v: 1,
      type: 'couch:input',
      input: { seq: 4, at: 4, playerId: 'p1', control: 'tap', action: 'press' }
    });
    expect(subSeen).toEqual([1, 2, 3]); // unchanged
    expect(onInput.mock.calls.map((c) => c[0].seq)).toEqual([1, 2, 3, 4]);
    expect(couch.lastSeq).toBe(4);

    h.restore();
  });
});

describe('CouchSDK setController', () => {
  it('posts couch:setController to the host with the player id and patch', async () => {
    const h = embed();
    const p = CouchSDK.init({ manifest });
    h.deliver(initMessage());
    const couch = await p;

    couch.setController('p1', { labels: { tap: 'SHIELD' }, cooldowns: { tap: 2000 }, vibrate: [40, 20, 40] });
    expect(h.posted.at(-1)).toEqual({
      v: 1,
      type: 'couch:setController',
      playerId: 'p1',
      patch: { labels: { tap: 'SHIELD' }, cooldowns: { tap: 2000 }, vibrate: [40, 20, 40] }
    });
    h.restore();
  });
});

describe('CouchSDK host-authoritative mode', () => {
  const seated: CouchPlayer[] = [
    { id: 'p1', name: 'One', colorIdx: 0, connected: true, screenId: 'scr_a' },
    { id: 'p2', name: 'Two', colorIdx: 1, connected: true, screenId: 'scr_b' }
  ];

  it('host screen broadcasts; localPlayers are the players at this screen', async () => {
    const h = embed();
    const p = CouchSDK.init({ manifest });
    h.deliver(initMessage({ latencyTier: 'remote', players: seated, screen: { id: 'scr_a', isHost: true } }));
    const couch = await p;

    expect(couch.screen).toEqual({ id: 'scr_a', isHost: true });
    expect(couch.localPlayers.map((pl) => pl.id)).toEqual(['p1']);
    couch.broadcast({ x: 1 });
    expect(h.posted.at(-1)).toEqual({ v: 1, type: 'couch:broadcast', state: { x: 1 } });
    h.restore();
  });

  it('a mirror screen ignores broadcast() and gets on("state") in seq order', async () => {
    const h = embed();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = CouchSDK.init({ manifest });
    h.deliver(initMessage({ latencyTier: 'remote', players: seated, screen: { id: 'scr_b', isHost: false } }));
    const couch = await p;
    const seen: number[] = [];
    couch.on('state', (e) => seen.push(e.seq));

    const before = h.posted.length;
    couch.broadcast({ x: 1 });
    expect(h.posted.length).toBe(before);
    expect(warn).toHaveBeenCalled();

    for (const seq of [1, 3, 2, 3, 4]) h.deliver({ v: 1, type: 'couch:state', envelope: { seq, at: 0, state: { seq } } });
    expect(seen).toEqual([1, 3, 4]);

    // Becoming the host (host player moved here) is announced and resets the counter.
    const changed = vi.fn();
    couch.on('screenChanged', changed);
    h.deliver({ v: 1, type: 'couch:screen', screen: { id: 'scr_b', isHost: true } });
    expect(changed).toHaveBeenCalledWith({ id: 'scr_b', isHost: true });
    expect(couch.screen.isHost).toBe(true);
    warn.mockRestore();
    h.restore();
  });

  it('restarts the seq check when the epoch changes (host reloaded or moved)', async () => {
    const h = embed();
    const p = CouchSDK.init({ manifest });
    h.deliver(initMessage({ latencyTier: 'remote', players: seated, screen: { id: 'scr_b', isHost: false } }));
    const couch = await p;
    const seen: string[] = [];
    couch.on('state', (e) => seen.push(`${e.epoch}:${e.seq}`));

    const state = (epoch: string, seq: number) =>
      h.deliver({ v: 1, type: 'couch:state', envelope: { epoch, seq, at: 0, state: {} } });
    for (let seq = 1; seq <= 500; seq++) state('first', seq);
    // The host TV reloads: a new run whose counter starts at 1 again.
    state('second', 1);
    state('second', 2);
    state('second', 2);
    expect(seen.slice(-3)).toEqual(['first:500', 'second:1', 'second:2']);
    h.restore();
  });

  it('warns once, not every frame, when a non-host screen broadcasts', async () => {
    const h = embed();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = CouchSDK.init({ manifest });
    h.deliver(initMessage({ latencyTier: 'remote', players: seated, screen: { id: 'scr_b', isHost: false } }));
    const couch = await p;
    const before = h.posted.length;
    for (let i = 0; i < 30; i++) couch.broadcast({ i });
    expect(h.posted.length).toBe(before);
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('broadcast()'))).toHaveLength(1);
    warn.mockRestore();
    h.restore();
  });

  it('a local couch (or an older host without screen info) is the host and seats everyone', async () => {
    const h = embed();
    const p = CouchSDK.init({ manifest });
    h.deliver(initMessage());
    const couch = await p;
    expect(couch.screen).toEqual({ id: null, isHost: true });
    expect(couch.localPlayers.map((pl) => pl.id)).toEqual(['p1', 'p2']);
    h.restore();
  });
});

describe('dev simulator setController', () => {
  it('reads labels as own keys, so a control named "constructor" keeps its label', async () => {
    standalone();
    const protoManifest: CouchManifest = {
      ...manifest,
      controllerLayout: { kind: 'generic-buttons', controls: [{ control: 'constructor', type: 'button', label: 'Build' }] }
    };
    const couch = await CouchSDK.init({ manifest: protoManifest });
    couch.setController('sim-p1', { disabled: [] });
    const btn = document.querySelector<HTMLButtonElement>('[data-player-id="sim-p1"] .couch-sim-pad-button')!;
    expect(btn.textContent).toBe('Build');
  });
});

describe('CouchSDK roster updates', () => {
  it('4. players message replaces roster + fires handler; joined/left deltas too', async () => {
    const h = embed();
    const changed = vi.fn();

    const p = CouchSDK.init({ manifest, onPlayersChanged: changed });
    h.deliver(initMessage());
    const couch = await p;

    const seen: string[][] = [];
    couch.on('playersChanged', (pl) => seen.push(pl.map((x) => x.id)));

    // full replace
    h.deliver({
      v: 1,
      type: 'couch:players',
      players: [{ id: 'a', name: 'A', colorIdx: 0, connected: true }]
    });
    expect(couch.players.map((x) => x.id)).toEqual(['a']);

    // join delta
    h.deliver({
      v: 1,
      type: 'couch:playerJoined',
      player: { id: 'b', name: 'B', colorIdx: 1, connected: true }
    });
    expect(couch.players.map((x) => x.id)).toEqual(['a', 'b']);

    // leave delta
    h.deliver({ v: 1, type: 'couch:playerLeft', playerId: 'a' });
    expect(couch.players.map((x) => x.id)).toEqual(['b']);

    expect(seen).toEqual([['a'], ['a', 'b'], ['b']]);
    // init assigns the roster silently (it is the bootstrap, not a change event);
    // the convenience callback fires once per delta ⇒ exactly 3.
    expect(changed.mock.calls.length).toBe(3);

    h.restore();
  });
});

describe('CouchSDK gameOver', () => {
  it('5. normalizes Record to array form; second call no-ops', async () => {
    const h = embed();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const p = CouchSDK.init({ manifest });
    h.deliver(initMessage());
    const couch = await p;

    couch.gameOver({ p1: 5, p2: 3 });

    const overs = h.posted.filter((m) => m.type === 'couch:gameOver');
    expect(overs).toHaveLength(1);
    const scores = (overs[0] as { scores: Array<{ playerId: string; score: number }> }).scores;
    expect(scores).toEqual([
      { playerId: 'p1', score: 5 },
      { playerId: 'p2', score: 3 }
    ]);

    // second call is a no-op + warns
    couch.gameOver([{ playerId: 'p1', score: 99 }]);
    expect(h.posted.filter((m) => m.type === 'couch:gameOver')).toHaveLength(1);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
    h.restore();
  });
});

describe('CouchSDK identity + shape validation', () => {
  it('6. ignores messages failing identity check or isCouchMessage', async () => {
    const h = embed();
    const onInput = vi.fn();

    const p = CouchSDK.init({ manifest, onInput });
    h.deliver(initMessage());
    const couch = await p;

    // wrong source ⇒ ignored
    const stranger = { postMessage: vi.fn() };
    h.deliver(
      {
        v: 1,
        type: 'couch:input',
        input: { seq: 10, at: 1, playerId: 'p1', control: 'tap', action: 'press' }
      },
      stranger
    );
    // malformed (missing v) from the real parent ⇒ ignored
    h.deliver({ type: 'couch:input', input: { seq: 11 } });
    // wrong version ⇒ ignored
    h.deliver({ v: 2, type: 'couch:input', input: { seq: 12 } });

    expect(onInput).not.toHaveBeenCalled();
    expect(couch.lastSeq).toBe(-1);

    h.restore();
  });

  it('isCouchMessage guard basics', () => {
    expect(isCouchMessage({ v: 1, type: 'couch:hello' })).toBe(true);
    expect(isCouchMessage({ v: 1, type: 'couch:input' })).toBe(true);
    expect(isCouchMessage({ v: 1, type: 'not:couch' })).toBe(false);
    expect(isCouchMessage({ v: 2, type: 'couch:hello' })).toBe(false);
    expect(isCouchMessage(null)).toBe(false);
    expect(isCouchMessage('couch:hello')).toBe(false);
  });
});

describe('CouchSDK dev mode', () => {
  it('7. top-level ⇒ dev mode resolves immediately, simulator DOM present', async () => {
    standalone(); // ensure self === top

    const couch = await CouchSDK.init({ manifest });

    expect(couch.mode).toBe('dev');
    expect(typeof couch.seed).toBe('string');
    expect(couch.seed.length).toBeGreaterThan(0);
    // simulator seeds 2 fake players
    expect(couch.players).toHaveLength(2);
    expect(couch.players[0].name).toBe('Alex');

    // overlay DOM injected
    const root = document.getElementById('couch-sim-root');
    expect(root).not.toBeNull();
    expect(document.getElementById('couch-sim-style')).not.toBeNull();
    // renders a fake phone per player
    expect(root!.querySelectorAll('.couch-sim-phone')).toHaveLength(2);
    // renders the manifest controls (button/hold/slider/select)
    expect(root!.querySelector('.couch-sim-pad-button')).not.toBeNull();
    expect(root!.querySelector('.couch-sim-pad-hold')).not.toBeNull();
    expect(root!.querySelector('.couch-sim-pad-slider')).not.toBeNull();
    expect(root!.querySelector('.couch-sim-pad-select')).not.toBeNull();
  });

  it('the starting roster is couch.players, not a playersChanged (as in a live couch)', async () => {
    standalone();
    const changed = vi.fn();
    // A callback that reads the handle must never run before init returns it.
    let couch: Awaited<ReturnType<typeof CouchSDK.init>> | undefined;
    const p = CouchSDK.init({
      manifest,
      onPlayersChanged: (players) => changed(players.map((pl) => pl.id), couch!.players.length)
    });
    expect(p).toBeInstanceOf(Promise);
    couch = await p;
    expect(changed).not.toHaveBeenCalled();
    expect(couch.players.map((pl) => pl.id)).toEqual(['sim-p1', 'sim-p2']);

    const root = document.getElementById('couch-sim-root')!;
    const addBtn = [...root.querySelectorAll<HTMLButtonElement>('.couch-sim-btn')].find((b) =>
      b.textContent?.includes('Add player')
    )!;
    addBtn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith(['sim-p1', 'sim-p2', 'sim-p3'], 3);
  });

  it('dev-mode simulator drives inputs + roster + gameOver through the core', async () => {
    standalone();
    const onInput = vi.fn();
    const couch = await CouchSDK.init({ manifest, onInput });

    const root = document.getElementById('couch-sim-root')!;

    // clicking a fake button dispatches an input through the same funnel
    const btn = root.querySelector<HTMLButtonElement>('.couch-sim-pad-button')!;
    btn.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput.mock.calls[0][0].control).toBe('tap');
    expect(onInput.mock.calls[0][0].action).toBe('press');
    expect(couch.lastSeq).toBe(1);

    // add player button grows the roster + repaints
    const addBtn = [...root.querySelectorAll<HTMLButtonElement>('.couch-sim-btn')].find(
      (b) => b.textContent?.includes('Add player')
    )!;
    addBtn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(couch.players).toHaveLength(3);
    expect(root.querySelectorAll('.couch-sim-phone')).toHaveLength(3);

    // gameOver shows the toast (dev mode has no host)
    couch.gameOver({ 'sim-p1': 7 });
    const toast = root.querySelector('.couch-sim-toast')!;
    expect(toast.classList.contains('is-hidden')).toBe(false);
    expect(toast.textContent).toContain('Game over');
  });
});
