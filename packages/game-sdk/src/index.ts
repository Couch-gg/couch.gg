/**
 * @couch/game-sdk — the creator-facing SDK for third-party couch.gg games.
 *
 * Usage:
 *   import { CouchSDK } from '@couch/game-sdk';
 *   const couch = await CouchSDK.init({ manifest, onInput });
 *   couch.gameOver([{ playerId, score }]);
 *
 * Two runtimes, one API:
 *   - Embedded (window.self !== window.top): talks to the couch.gg host over the
 *     protocol-v1 postMessage bridge. `mode` is 'live' or 'test' (host-declared).
 *   - Standalone (window.self === window.top): boots the built-in dev simulator,
 *     `mode` is 'dev'. `init()` resolves immediately.
 */

import {
  PROTOCOL_VERSION,
  isHostMessage,
  type CouchControllerPatch,
  type CouchInputEnvelope,
  type CouchLatencyTier,
  type CouchManifest,
  type CouchMessage,
  type CouchMode,
  type CouchPlayer,
  type CouchScore,
  type CouchScreen,
  type CouchStateEnvelope
} from './protocol';
import { createSimulator, type Simulator } from './simulator';

export * from './protocol';

/** SDK build version, embedded in the `couch:hello` handshake. */
export const SDK_VERSION = '0.1.0';

/** How often the game re-sends `couch:hello` until the host answers (ms). */
const HELLO_INTERVAL_MS = 250;
/** Max hello attempts before the SDK stops pinging (but keeps listening). */
const HELLO_MAX_ATTEMPTS = 40;

/** Scores accepted by `gameOver`: array form or a playerId->score record. */
export type CouchScoreInput = CouchScore[] | Record<string, number>;

/** Lifecycle/event names a game can subscribe to via `couch.on(...)`. */
export type CouchEventName =
  | 'input'
  | 'playersChanged'
  | 'pause'
  | 'resume'
  | 'abort'
  | 'state'
  | 'screenChanged';

/** Payload shape per event. */
export interface CouchEventMap {
  input: CouchInputEnvelope;
  playersChanged: CouchPlayer[];
  pause: { reason: string };
  resume: void;
  abort: { reason: string };
  state: CouchStateEnvelope;
  screenChanged: CouchScreen;
}

/** Options passed to `CouchSDK.init`. */
export interface CouchInitOptions {
  /** The game's manifest (passed in, never fetched — works from file:// too). */
  manifest: CouchManifest;
  /** Convenience callback for forwarded inputs (same as `on('input')`). */
  onInput?: (input: CouchInputEnvelope) => void;
  /** Convenience callback for roster changes (same as `on('playersChanged')`). */
  onPlayersChanged?: (players: CouchPlayer[]) => void;
  /** Convenience callback for pause (same as `on('pause')`). */
  onPause?: (payload: { reason: string }) => void;
  /** Convenience callback for resume (same as `on('resume')`). */
  onResume?: () => void;
}

/** The public SDK handle returned by `CouchSDK.init`. */
export interface CouchGame {
  /** Current roster. */
  readonly players: CouchPlayer[];
  /** Deterministic seed for this session. Games must derive randomness from it. */
  readonly seed: string;
  /** 'live' | 'dev' | 'test'. */
  readonly mode: CouchMode;
  /** 'local' | 'remote'. */
  readonly latencyTier: CouchLatencyTier;
  /** BCP-47 locale hint. */
  readonly locale: string;
  /** Whether the player prefers reduced motion. */
  readonly reducedMotion: boolean;
  /** The manifest the game was initialised with. */
  readonly manifest: CouchManifest;
  /** Highest input `seq` seen so far (or -1 before any input). */
  readonly lastSeq: number;
  /** This screen: its id and whether it is the host screen (see `broadcast`). */
  readonly screen: CouchScreen;
  /** Players sitting at this screen (all players on a local couch). */
  readonly localPlayers: CouchPlayer[];
  /**
   * Host-authoritative mode: on the host screen, send the game state to every
   * other screen (they get it via `on('state')`). Ignored with a warning on a
   * non-host screen. Keep it small (≤ 32 KB) and ≤ 30 per second.
   */
  broadcast(state: unknown): void;
  /** Subscribe to an event. Returns an unsubscribe function. */
  on<E extends CouchEventName>(
    event: E,
    cb: (payload: CouchEventMap[E]) => void
  ): () => void;
  /** Report final scores exactly once. Array or Record form. */
  gameOver(scores: CouchScoreInput): void;
  /**
   * Tell one player's phone what to show: per-player labels, greyed-out
   * controls, cooldowns, a vibration. Omitted fields keep their value.
   *   couch.setController(p.id, { labels: { a: 'SHIELD', b: 'BASH' } });
   *   couch.setController(p.id, { cooldowns: { b: 3000 }, vibrate: 80 });
   */
  setController(playerId: string, patch: CouchControllerPatch): void;
}

// ---------------------------------------------------------------------------
// Internal core (shared by the live bridge AND the dev simulator)
// ---------------------------------------------------------------------------

type Listener = (payload: unknown) => void;

/**
 * The mutable runtime state + dispatch machinery. Both incoming `couch:*`
 * messages and simulator-generated events funnel through the SAME methods here,
 * so a game behaves identically in live and dev modes.
 */
class CouchCore {
  players: CouchPlayer[] = [];
  seed = '';
  mode: CouchMode = 'live';
  latencyTier: CouchLatencyTier = 'local';
  locale = 'en';
  reducedMotion = false;
  manifest: CouchManifest;
  lastSeq = -1;
  screen: CouchScreen = { id: null, isHost: true };
  private lastStateEpoch: string | null = null;
  private lastStateSeq = -1;
  private warnedNonHostBroadcast = false;

  private readonly listeners: Record<CouchEventName, Set<Listener>> = {
    input: new Set(),
    playersChanged: new Set(),
    pause: new Set(),
    resume: new Set(),
    abort: new Set(),
    state: new Set(),
    screenChanged: new Set()
  };

  private gameOverSent = false;

  /** How outbound messages leave this game. Swapped for the simulator sink. */
  send: (msg: CouchMessage) => void;

  constructor(manifest: CouchManifest, send: (msg: CouchMessage) => void) {
    this.manifest = manifest;
    this.send = send;
  }

  on(event: CouchEventName, cb: Listener): () => void {
    const set = this.listeners[event];
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  private emit(event: CouchEventName, payload: unknown): void {
    // Copy to a snapshot so unsubscribing during emit is safe.
    for (const cb of [...this.listeners[event]]) {
      cb(payload);
    }
  }

  /** Dispatch a forwarded input. Single funnel for live + simulator inputs. */
  dispatchInput(input: CouchInputEnvelope): void {
    this.lastSeq = input.seq;
    this.emit('input', input);
  }

  /** Replace the full roster, then notify. */
  setPlayers(players: CouchPlayer[]): void {
    this.players = players;
    this.emit('playersChanged', this.players);
  }

  /** Apply a join delta, then notify. */
  addPlayer(player: CouchPlayer): void {
    const idx = this.players.findIndex((p) => p.id === player.id);
    if (idx >= 0) {
      this.players[idx] = player;
    } else {
      this.players = [...this.players, player];
    }
    this.emit('playersChanged', this.players);
  }

  /** Apply a leave delta, then notify. */
  removePlayer(playerId: string): void {
    this.players = this.players.filter((p) => p.id !== playerId);
    this.emit('playersChanged', this.players);
  }

  pause(reason: string): void {
    this.emit('pause', { reason });
  }

  resume(): void {
    this.emit('resume', undefined);
  }

  abort(reason: string): void {
    this.emit('abort', { reason });
  }

  get localPlayers(): CouchPlayer[] {
    if (this.latencyTier === 'local' || this.screen.id === null) return this.players;
    return this.players.filter((p) => p.screenId === this.screen.id);
  }

  broadcast(state: unknown): void {
    if (!this.screen.isHost) {
      // Once: a frame loop on a screen that just lost the host role would
      // otherwise log 30 warnings a second.
      if (!this.warnedNonHostBroadcast) {
        this.warnedNonHostBroadcast = true;
        // eslint-disable-next-line no-console
        console.warn('[couch] broadcast() on a non-host screen — ignoring. Check couch.screen.isHost.');
      }
      return;
    }
    this.send({ v: PROTOCOL_VERSION, type: 'couch:broadcast', state });
  }

  /** Deliver host state; stale or duplicate envelopes are dropped. */
  receiveState(envelope: CouchStateEnvelope): void {
    // A new epoch is a new run of the host's game (it reloaded, or the host
    // moved) whose counter starts over.
    const epoch = typeof envelope.epoch === 'string' ? envelope.epoch : '';
    if (epoch !== this.lastStateEpoch) {
      this.lastStateEpoch = epoch;
      this.lastStateSeq = -1;
    }
    if (envelope.seq <= this.lastStateSeq) return;
    this.lastStateSeq = envelope.seq;
    this.emit('state', envelope);
  }

  setScreen(screen: CouchScreen): void {
    this.screen = screen;
    // A new host screen starts its own broadcast counter.
    this.lastStateSeq = -1;
    this.emit('screenChanged', screen);
  }

  setController(playerId: string, patch: CouchControllerPatch): void {
    this.send({ v: PROTOCOL_VERSION, type: 'couch:setController', playerId: String(playerId), patch });
  }

  gameOver(scores: CouchScoreInput): void {
    if (this.gameOverSent) {
      // eslint-disable-next-line no-console
      console.warn('[couch] gameOver() called more than once — ignoring.');
      return;
    }
    this.gameOverSent = true;
    const normalized = normalizeScores(scores);
    this.send({ v: PROTOCOL_VERSION, type: 'couch:gameOver', scores: normalized });
  }
}

/** Normalise array-or-record scores to the wire array form. */
export function normalizeScores(scores: CouchScoreInput): CouchScore[] {
  if (Array.isArray(scores)) {
    return scores.map((s) => ({ playerId: String(s.playerId), score: Number(s.score) }));
  }
  return Object.entries(scores).map(([playerId, score]) => ({
    playerId,
    score: Number(score)
  }));
}

/** Build the public handle over a core (identical for live + dev). */
function makeHandle(core: CouchCore): CouchGame {
  return {
    get players() {
      return core.players;
    },
    get seed() {
      return core.seed;
    },
    get mode() {
      return core.mode;
    },
    get latencyTier() {
      return core.latencyTier;
    },
    get locale() {
      return core.locale;
    },
    get reducedMotion() {
      return core.reducedMotion;
    },
    get manifest() {
      return core.manifest;
    },
    get lastSeq() {
      return core.lastSeq;
    },
    get screen() {
      return core.screen;
    },
    get localPlayers() {
      return core.localPlayers;
    },
    broadcast(state) {
      core.broadcast(state);
    },
    on(event, cb) {
      return core.on(event, cb as Listener);
    },
    gameOver(scores) {
      core.gameOver(scores);
    },
    setController(playerId, patch) {
      core.setController(playerId, patch);
    }
  };
}

/** Wire the convenience callbacks onto the event bus. */
function bindConvenienceCallbacks(core: CouchCore, opts: CouchInitOptions): void {
  if (opts.onInput) core.on('input', (p) => opts.onInput!(p as CouchInputEnvelope));
  if (opts.onPlayersChanged) {
    core.on('playersChanged', (p) => opts.onPlayersChanged!(p as CouchPlayer[]));
  }
  if (opts.onPause) core.on('pause', (p) => opts.onPause!(p as { reason: string }));
  if (opts.onResume) core.on('resume', () => opts.onResume!());
}

// ---------------------------------------------------------------------------
// Embedded (live/test) bootstrap
// ---------------------------------------------------------------------------

function initEmbedded(opts: CouchInitOptions): Promise<CouchGame> {
  const parent = window.parent;
  const core = new CouchCore(opts.manifest, (msg) => {
    // Opaque-origin bridge: targetOrigin '*' is correct (payloads carry no secrets).
    parent.postMessage(msg, '*');
  });
  bindConvenienceCallbacks(core, opts);

  return new Promise<CouchGame>((resolve) => {
    let resolved = false;
    let helloAttempts = 0;
    let helloTimer: ReturnType<typeof setInterval> | undefined;

    const stopHello = (): void => {
      if (helloTimer !== undefined) {
        clearInterval(helloTimer);
        helloTimer = undefined;
      }
    };

    const sendHello = (): void => {
      helloAttempts += 1;
      core.send({
        v: PROTOCOL_VERSION,
        type: 'couch:hello',
        sdkVersion: SDK_VERSION,
        wantsProtocol: 1
      });
      if (helloAttempts >= HELLO_MAX_ATTEMPTS) {
        // Stop pinging, but KEEP the listener alive — the host owns timeout UX.
        stopHello();
      }
    };

    const onMessage = (e: MessageEvent): void => {
      // Identity check: the opaque origin means we trust the source WINDOW, not a
      // string. Only the parent frame that embedded us may drive this game.
      if (e.source !== parent) return;
      if (!isHostMessage(e.data)) return;
      const msg = e.data;

      switch (msg.type) {
        case 'couch:init': {
          if (resolved) return;
          resolved = true;
          stopHello();

          core.mode = msg.mode; // 'live' | 'test'
          core.manifest = msg.manifest ?? core.manifest;
          core.seed = msg.seed;
          core.locale = msg.locale;
          core.reducedMotion = msg.reducedMotion;
          core.latencyTier = msg.latencyTier;
          core.players = msg.players ?? [];
          core.screen = msg.screen ?? { id: null, isHost: true };

          // Auto-acknowledge so the host reveals the game.
          core.send({ v: PROTOCOL_VERSION, type: 'couch:ready' });
          resolve(makeHandle(core));
          break;
        }
        case 'couch:input':
          core.dispatchInput(msg.input);
          break;
        case 'couch:players':
          core.setPlayers(msg.players);
          break;
        case 'couch:playerJoined':
          core.addPlayer(msg.player);
          break;
        case 'couch:playerLeft':
          core.removePlayer(msg.playerId);
          break;
        case 'couch:pause':
          core.pause(msg.reason);
          break;
        case 'couch:resume':
          core.resume();
          break;
        case 'couch:abort':
          core.abort(msg.reason);
          break;
        case 'couch:state':
          core.receiveState(msg.envelope);
          break;
        case 'couch:screen':
          core.setScreen(msg.screen);
          break;
        default:
          // Exhaustiveness guard.
          assertNever(msg);
      }
    };

    window.addEventListener('message', onMessage);

    // Ping immediately, then on an interval (handles the host attaching late).
    sendHello();
    helloTimer = setInterval(sendHello, HELLO_INTERVAL_MS);
  });
}

function assertNever(_x: never): void {
  /* type-level exhaustiveness only */
}

// ---------------------------------------------------------------------------
// Standalone (dev) bootstrap
// ---------------------------------------------------------------------------

function initDev(opts: CouchInitOptions): Promise<CouchGame> {
  // Outbound messages have no host; the simulator intercepts gameOver directly.
  let simulator: Simulator | undefined;
  const core = new CouchCore(opts.manifest, (msg) => {
    if (msg.type === 'couch:gameOver') {
      simulator?.showGameOver(msg.scores);
    } else if (msg.type === 'couch:setController') {
      simulator?.setController(msg.playerId, msg.patch);
    }
  });
  bindConvenienceCallbacks(core, opts);

  core.mode = 'dev';
  core.latencyTier = 'local';
  core.locale =
    typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en';
  core.reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  core.seed = makeDevSeed();

  simulator = createSimulator({
    manifest: opts.manifest,
    core: {
      get players() {
        return core.players;
      },
      get seed() {
        return core.seed;
      },
      setSeed(seed: string) {
        core.seed = seed;
      },
      dispatchInput: (input) => core.dispatchInput(input),
      setPlayers: (players) => core.setPlayers(players),
      addPlayer: (player) => core.addPlayer(player),
      removePlayer: (playerId) => core.removePlayer(playerId),
      pause: (reason) => core.pause(reason),
      resume: () => core.resume()
    }
  });

  return Promise.resolve(makeHandle(core));
}

/** Deterministic-per-load random-ish seed string for dev mode. */
function makeDevSeed(): string {
  return `dev-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/** The public namespace object exported as the IIFE global `CouchSDK`. */
export const CouchSDK = {
  version: SDK_VERSION,
  /**
   * Initialise the SDK. Resolves when the host has sent `couch:init` (embedded)
   * or immediately with a simulator (standalone). Never rejects — the host owns
   * handshake-timeout UX.
   */
  init(options: CouchInitOptions): Promise<CouchGame> {
    const embedded =
      typeof window !== 'undefined' && window.self !== window.top;
    return embedded ? initEmbedded(options) : initDev(options);
  }
};

export default CouchSDK;
