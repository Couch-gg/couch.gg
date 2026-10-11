/**
 * couch.gg game bridge — protocol v1.
 *
 * SINGLE SOURCE OF TRUTH for the typed postMessage contract between a
 * third-party game (running in a sandboxed iframe) and the couch.gg host.
 *
 * This module is deliberately SELF-CONTAINED: it imports nothing. Game creators
 * consume `@couch/game-sdk` and never see `@couch/types`. The shapes here are a
 * curated, creator-facing subset that mirrors — but does not depend on — the
 * platform's internal types.
 *
 * Every message on the wire is an envelope `{ v: 1, type: 'couch:...' , ... }`.
 * The sandbox origin is opaque (`sandbox="allow-scripts"`, no `allow-same-origin`),
 * so origin-string validation is impossible by construction. The bridge is secured
 * by IDENTITY instead: the host validates `e.source === iframe.contentWindow`, the
 * SDK validates `e.source === window.parent`, and both post with targetOrigin `'*'`.
 * This is safe because bridge payloads never carry secrets (roster / seed / inputs
 * only — never management tokens, player tokens, or admin keys).
 */

/** Protocol version carried by every message. */
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

// ---------------------------------------------------------------------------
// Shared value shapes (self-contained mirrors of platform types)
// ---------------------------------------------------------------------------

/** A player in the couch, as the game sees them. */
export interface CouchPlayer {
  /** Stable per-lobby id. Games key their state off this. */
  id: string;
  /** Display name. */
  name: string;
  /** Palette index (0-based) the host assigned this player; use it for colors. */
  colorIdx: number;
  /** Whether the player's phone is currently connected. */
  connected: boolean;
  /**
   * The screen (TV) this player sits at, or null when unknown (joined by invite
   * link without scanning a TV). Compare with `couch.screen.id`.
   */
  screenId?: string | null;
}

/** This screen's place in the lobby. */
export interface CouchScreen {
  /** This screen's id, or null when it has none (e.g. the /dev harness). */
  id: string | null;
  /**
   * Whether this screen runs the game in host-authoritative mode: it simulates
   * and `broadcast`s, every other screen renders `on('state')`. Exactly one
   * screen per lobby is the host; on a single-screen couch it is that screen.
   */
  isHost: boolean;
}

/** A state broadcast from the host screen, as a non-host screen receives it. */
export interface CouchStateEnvelope<TState = unknown> {
  /**
   * Identifies one run of the host screen's game: it changes when the host TV
   * reloads or another screen becomes the host, and `seq` restarts with it.
   */
  epoch: string;
  /** The host's broadcast counter within `epoch`; strictly increasing, older ones are dropped. */
  seq: number;
  /** Server time (ms) the broadcast passed through. */
  at: number;
  state: TState;
}

/** Discrete input actions a control can emit. */
export type CouchInputAction = 'press' | 'release' | 'change';

/**
 * A single input event, as forwarded by the host. The host guarantees `seq`
 * order; `playerId` is authoritative (derived server-side from the player's
 * token, never from a client-supplied field).
 */
export interface CouchInputEnvelope {
  /** Monotonic per-lobby sequence number. Host guarantees strict ordering. */
  seq: number;
  /**
   * When the realtime server accepted the input (ms since epoch, server clock;
   * the local clock in the dev simulator). Compare it only with other inputs'
   * `at`, not with `Date.now()`: the screen's clock can be off by seconds.
   */
  at: number;
  /** Which player produced the input. */
  playerId: string;
  /** The control name, matching a `controllerLayout.controls[].control`. */
  control: string;
  /** What happened to the control. */
  action: CouchInputAction;
  /** Optional payload (e.g. slider value, select option, hold progress). */
  value?: unknown;
}

/** One control declared in the manifest's controller layout. */
export interface CouchControl {
  /** Machine name emitted on inputs (matches `CouchInputEnvelope.control`). */
  control: string;
  /**
   * Rendering kind the phone/simulator uses.
   * - `stick`: analog thumbstick. `change` with `{ x, y }` in -1..1 (y up),
   *   throttled; `release` with `{ x: 0, y: 0 }` when the thumb lifts.
   * - `dpad`: 8-way pad. `change` with `{ dir }` ('up' | 'up-right' | 'right' |
   *   ... ) whenever the direction changes; `release` with `{ dir: 'none' }`.
   */
  type: 'slider' | 'button' | 'hold' | 'select' | 'stick' | 'dpad';
  /** Human label shown on the controller. */
  label: string;
  /** Landscape layouts: which thumb zone the control sits in. */
  zone?: 'left' | 'right';
  /** For sliders: bounds/step. */
  min?: number;
  max?: number;
  step?: number;
  /** For selects: the option values. */
  options?: string[];
}

/** Controller layout as seen by the game. */
export interface CouchControllerLayout {
  /** Layout family. External games use `'generic-buttons'`. */
  kind: 'trebuchet-aim-fire' | 'generic-buttons' | string;
  /** `'landscape'`: the phone shows a left and a right thumb zone. */
  orientation?: 'portrait' | 'landscape';
  controls: CouchControl[];
}

/** CSS-based thumbnail descriptor (creator-facing subset). */
export interface CouchThumbnail {
  kind: 'css';
  gradient: string;
  icon: string;
  accent?: string;
}

/**
 * The game manifest, as the game receives it back in `couch:init`. This is the
 * creator-authored manifest echoed by the host (possibly enriched). Kept loose
 * enough that creators can extend it without fighting the type.
 */
export interface CouchManifest {
  id: string;
  title: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  controllerLayout: CouchControllerLayout;
  aspectRatio: '16:9' | '4:3';
  estimatedDurationMinutes: number;
  thumbnail?: CouchThumbnail;
  supportsRemote?: boolean;
  [key: string]: unknown;
}

/** How the game is running. `'test'` is the /dev harness; `'live'` is a real couch. */
export type CouchLiveMode = 'live' | 'test';
/** Full mode set the SDK exposes (`'dev'` is standalone / top-level simulator). */
export type CouchMode = CouchLiveMode | 'dev';

/** Round-trip latency class of the lobby. */
export type CouchLatencyTier = 'local' | 'remote';

/** A per-player score, as reported at game over. */
export interface CouchScore {
  playerId: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Game -> Host messages
// ---------------------------------------------------------------------------

/** Handshake ping. Repeated until the host answers with `couch:init`. */
export interface CouchHelloMessage {
  v: ProtocolVersion;
  type: 'couch:hello';
  sdkVersion: string;
  wantsProtocol: 1;
}

/** Sent automatically once `couch:init` is received; tells the host to reveal the game. */
export interface CouchReadyMessage {
  v: ProtocolVersion;
  type: 'couch:ready';
}

/** Final scores; ends the game. Idempotent on the host. */
export interface CouchGameOverMessage {
  v: ProtocolVersion;
  type: 'couch:gameOver';
  scores: CouchScore[];
}

/** Non-fatal error report from the game. */
export interface CouchErrorMessage {
  v: ProtocolVersion;
  type: 'couch:error';
  message: string;
}

/**
 * What a game can tell one player's phone. Omitted fields keep their current
 * value. Control names must be ones the manifest declares.
 */
export interface CouchControllerPatch {
  /** Replace this player's button labels, e.g. `{ a: 'SHIELD', b: 'BASH' }` (1-16 chars). */
  labels?: Record<string, string>;
  /** Replace the set of greyed-out controls. `[]` re-enables all. */
  disabled?: string[];
  /** Start a cooldown (ms, max 60000) on these controls now; the phone shows it draining. */
  cooldowns?: Record<string, number>;
  /** Vibrate once: a duration or an on/off pattern in ms (max 10 steps of 1000). */
  vibrate?: number | number[];
}

/** Limits a `CouchControllerPatch` must stay within. */
export const CONTROLLER_PATCH_LIMITS = {
  labelChars: 16,
  cooldownMs: 60_000,
  vibrateSteps: 10,
  vibrateStepMs: 1_000
} as const;

export type CouchControllerPatchCheck =
  | { ok: true; patch: CouchControllerPatch & { vibrate?: number[] } }
  | { ok: false; error: string };

/**
 * Check a controller patch the way the platform server does
 * (`sanitizeControllerPatch` in apps/realtime/src/lobbies.ts; keep the two in
 * step): an unknown control or a value out of range rejects the WHOLE patch.
 * On success returns the patch as the server stores it: trimmed labels,
 * de-duplicated `disabled`, whole milliseconds, `vibrate` as a list.
 */
export function checkControllerPatch(patch: unknown, controls: Iterable<string>): CouchControllerPatchCheck {
  const known = new Set(controls);
  const L = CONTROLLER_PATCH_LIMITS;
  const fail = (error: string): CouchControllerPatchCheck => ({ ok: false, error });
  const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!isRecord(patch)) return fail('the patch must be an object');
  const out: CouchControllerPatch & { vibrate?: number[] } = {};

  if (patch.labels !== undefined) {
    if (!isRecord(patch.labels)) return fail('labels must be an object');
    // Null-prototype maps: a control key can never hit Object.prototype.
    const labels = Object.create(null) as Record<string, string>;
    for (const [control, label] of Object.entries(patch.labels)) {
      if (!known.has(control)) return fail(`unknown control "${control}" in labels`);
      if (typeof label !== 'string' || !label.trim() || label.trim().length > L.labelChars) {
        return fail(`the label for "${control}" must be 1-${L.labelChars} characters`);
      }
      labels[control] = label.trim();
    }
    out.labels = labels;
  }
  if (patch.disabled !== undefined) {
    if (!Array.isArray(patch.disabled)) return fail('disabled must be a list of control names');
    const disabled: string[] = [];
    for (const control of patch.disabled) {
      if (typeof control !== 'string') return fail('disabled must be a list of control names');
      if (!known.has(control)) return fail(`unknown control "${control}" in disabled`);
      if (!disabled.includes(control)) disabled.push(control);
    }
    out.disabled = disabled;
  }
  if (patch.cooldowns !== undefined) {
    if (!isRecord(patch.cooldowns)) return fail('cooldowns must be an object');
    const cooldowns = Object.create(null) as Record<string, number>;
    for (const [control, ms] of Object.entries(patch.cooldowns)) {
      if (!known.has(control)) return fail(`unknown control "${control}" in cooldowns`);
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > L.cooldownMs) {
        return fail(`the cooldown for "${control}" must be 0-${L.cooldownMs} ms`);
      }
      cooldowns[control] = Math.round(ms);
    }
    out.cooldowns = cooldowns;
  }
  if (patch.vibrate !== undefined) {
    const steps = typeof patch.vibrate === 'number' ? [patch.vibrate] : patch.vibrate;
    if (
      !Array.isArray(steps) ||
      steps.length === 0 ||
      steps.length > L.vibrateSteps ||
      steps.some((ms) => typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > L.vibrateStepMs)
    ) {
      return fail(`vibrate must be 1-${L.vibrateSteps} steps of 0-${L.vibrateStepMs} ms`);
    }
    out.vibrate = (steps as number[]).map((ms) => Math.round(ms));
  }
  return { ok: true, patch: out };
}

/** Update one player's phone controller. */
export interface CouchSetControllerMessage {
  v: ProtocolVersion;
  type: 'couch:setController';
  playerId: string;
  patch: CouchControllerPatch;
}

/** Host-authoritative state from the host screen's game (max 32 KB serialized). */
export interface CouchBroadcastMessage {
  v: ProtocolVersion;
  type: 'couch:broadcast';
  state: unknown;
}

export type CouchGameToHostMessage =
  | CouchHelloMessage
  | CouchBroadcastMessage
  | CouchSetControllerMessage
  | CouchReadyMessage
  | CouchGameOverMessage
  | CouchErrorMessage;

// ---------------------------------------------------------------------------
// Host -> Game messages
// ---------------------------------------------------------------------------

/** The one-time bootstrap message. Resolves `CouchSDK.init()`. */
export interface CouchInitMessage {
  v: ProtocolVersion;
  type: 'couch:init';
  protocol: 1;
  mode: CouchLiveMode;
  manifest: CouchManifest;
  players: CouchPlayer[];
  seed: string;
  locale: string;
  reducedMotion: boolean;
  latencyTier: CouchLatencyTier;
  /** Optional for hosts older than this field: absent means a lone host screen. */
  screen?: CouchScreen;
}

/** A forwarded controller input (strict seq order). */
export interface CouchInputMessage {
  v: ProtocolVersion;
  type: 'couch:input';
  input: CouchInputEnvelope;
}

/** Full roster replacement. */
export interface CouchPlayersMessage {
  v: ProtocolVersion;
  type: 'couch:players';
  players: CouchPlayer[];
}

/** Roster delta: a player joined. */
export interface CouchPlayerJoinedMessage {
  v: ProtocolVersion;
  type: 'couch:playerJoined';
  player: CouchPlayer;
}

/** Roster delta: a player left. */
export interface CouchPlayerLeftMessage {
  v: ProtocolVersion;
  type: 'couch:playerLeft';
  playerId: string;
}

/** Host asked the game to pause. */
export interface CouchPauseMessage {
  v: ProtocolVersion;
  type: 'couch:pause';
  reason: string;
}

/** Host asked the game to resume. */
export interface CouchResumeMessage {
  v: ProtocolVersion;
  type: 'couch:resume';
}

/** Host aborted the session (lobby closed, kicked, etc.). */
export interface CouchAbortMessage {
  v: ProtocolVersion;
  type: 'couch:abort';
  reason: string;
}

/** State from the host screen, delivered to every other screen. */
export interface CouchStateMessage {
  v: ProtocolVersion;
  type: 'couch:state';
  envelope: CouchStateEnvelope;
}

/** This screen's role changed (e.g. the host player moved to another TV). */
export interface CouchScreenMessage {
  v: ProtocolVersion;
  type: 'couch:screen';
  screen: CouchScreen;
}

export type CouchHostToGameMessage =
  | CouchInitMessage
  | CouchStateMessage
  | CouchScreenMessage
  | CouchInputMessage
  | CouchPlayersMessage
  | CouchPlayerJoinedMessage
  | CouchPlayerLeftMessage
  | CouchPauseMessage
  | CouchResumeMessage
  | CouchAbortMessage;

// ---------------------------------------------------------------------------
// Union + type guards
// ---------------------------------------------------------------------------

/** Every valid protocol-v1 message, in either direction. */
export type CouchMessage = CouchGameToHostMessage | CouchHostToGameMessage;

/** All `type` string literals, for exhaustive validation. */
const COUCH_MESSAGE_TYPES = new Set<string>([
  // game -> host
  'couch:hello',
  'couch:ready',
  'couch:gameOver',
  'couch:error',
  'couch:setController',
  'couch:broadcast',
  // host -> game
  'couch:init',
  'couch:input',
  'couch:players',
  'couch:playerJoined',
  'couch:playerLeft',
  'couch:pause',
  'couch:resume',
  'couch:abort',
  'couch:state',
  'couch:screen'
]);

/**
 * Narrows arbitrary `event.data` to a well-formed protocol-v1 message.
 * Checks the envelope shape only (`v === 1` + a known `type`); it does not
 * deep-validate every field, which keeps the guard cheap and forward-tolerant.
 */
export function isCouchMessage(data: unknown): data is CouchMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as { v?: unknown; type?: unknown };
  if (msg.v !== PROTOCOL_VERSION) return false;
  if (typeof msg.type !== 'string') return false;
  return COUCH_MESSAGE_TYPES.has(msg.type);
}

/** Narrows to a specific host->game message by `type`. */
export function isHostMessage(data: unknown): data is CouchHostToGameMessage {
  return (
    isCouchMessage(data) &&
    (data.type === 'couch:init' ||
      data.type === 'couch:input' ||
      data.type === 'couch:players' ||
      data.type === 'couch:playerJoined' ||
      data.type === 'couch:playerLeft' ||
      data.type === 'couch:pause' ||
      data.type === 'couch:resume' ||
      data.type === 'couch:abort' ||
      data.type === 'couch:state' ||
      data.type === 'couch:screen')
  );
}
