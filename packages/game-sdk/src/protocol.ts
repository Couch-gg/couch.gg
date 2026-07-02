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
  /** Milliseconds timestamp (host clock) when the input was recorded. */
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
  /** Rendering kind the phone/simulator uses. */
  type: 'slider' | 'button' | 'hold' | 'select';
  /** Human label shown on the controller. */
  label: string;
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

export type CouchGameToHostMessage =
  | CouchHelloMessage
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

export type CouchHostToGameMessage =
  | CouchInitMessage
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
  // host -> game
  'couch:init',
  'couch:input',
  'couch:players',
  'couch:playerJoined',
  'couch:playerLeft',
  'couch:pause',
  'couch:resume',
  'couch:abort'
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
      data.type === 'couch:abort')
  );
}
