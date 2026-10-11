import type {
  ActivityMessage,
  ChatMessage,
  ControllerEvent,
  ControllerPatch,
  ControllerState,
  ExternalGameManifest,
  ExternalGameSnapshot,
  GameEventEnvelope,
  GameId,
  GameInputEnvelope,
  GameManifest,
  GameSession,
  InputAction,
  JoinLobbyResponse,
  Lobby,
  LobbySlug,
  Player,
  PlayerId,
  PlayerToken,
  RenamePlayerResponse
} from '@couch/types';
import {
  createId,
  createRoomName,
  getDefaultGameId,
  getGameManifest,
  randomSlug,
  sanitizePlayerName
} from '@couch/game-runtime';
import { TrebuchetEngine, type TrebuchetEvent, type TrebuchetSnapshot } from '@couch/trebuchet';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Resolves a game id to its manifest (built-in or env-registered external),
// returning null for unknown ids. Injected into LobbyStore so the store never
// calls the throwing getGameManifest directly and can see external games.
export type ManifestResolver = (id: GameId) => GameManifest | null;

const INPUT_ACTIONS: readonly InputAction[] = ['press', 'release', 'change'];
const MAX_INPUT_VALUE_BYTES = 1024;
const INPUT_LOG_LIMIT = 128;
const INPUT_LOG_PUBLIC_LIMIT = 64;

// The snapshot union the server may hold: the built-in Trebuchet snapshot or the
// thin external snapshot (seed + reported scores, no authoritative state).
export type LobbySnapshot = TrebuchetSnapshot | ExternalGameSnapshot;

// Narrow a stored snapshot to the Trebuchet shape. External snapshots have no
// `units`, so this guards every code path that reaches into Trebuchet internals.
export function isTrebuchetSnapshot(snapshot: unknown): snapshot is TrebuchetSnapshot {
  return !!snapshot && typeof snapshot === 'object' && 'units' in (snapshot as Record<string, unknown>);
}

// Narrow a stored snapshot to the external shape (`kind: 'external'`).
export function isExternalSnapshot(snapshot: unknown): snapshot is ExternalGameSnapshot {
  return !!snapshot && typeof snapshot === 'object' && (snapshot as Record<string, unknown>).kind === 'external';
}

// Narrow a manifest to an external (iframe-hosted) game.
function isExternalManifest(manifest: GameManifest): manifest is ExternalGameManifest {
  return manifest.origin === 'external';
}

// A URL-safe random seed for an external game run. Uses the OS CSPRNG (same
// rationale as randomSlug/createId — Math.random can repeat across snapshot-
// restored serverless instances). 16 chars, well over the 12-char minimum.
function createSeed(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const length = 16;
  const cryptoRef = globalThis.crypto;
  let out = '';
  if (cryptoRef?.getRandomValues) {
    const bytes = new Uint8Array(length);
    cryptoRef.getRandomValues(bytes);
    for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

// Wraps the throwing built-in getGameManifest into the nullable resolver shape.
function builtinManifestResolver(id: GameId): GameManifest | null {
  try {
    return getGameManifest(id);
  } catch {
    return null;
  }
}

export const LOBBY_TTL_MS = 4 * 60 * 60 * 1000;
// Activity keeps a lobby alive for another LOBBY_TTL_MS, but never past this age.
export const LOBBY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const RECONNECT_GRACE_MS = 10 * 60 * 1000;

export interface InternalPlayer extends Player {
  token: PlayerToken;
  disconnectedAt: number | null;
  // The socket this player last joined with: only its disconnect counts (see
  // noteDropped). Absent in records persisted before it existed.
  connectionId?: string | null;
  // When that socket dropped, while the player still shows as connected (see
  // noteDropped and markDroppedGone). Null or absent otherwise.
  droppedAt?: number | null;
}

export interface SerializedLobbyRecord {
  // Always the first key: the commit script reads it off the front of the
  // stored JSON (see persistence.ts). Absent in records persisted before it.
  rev?: number;
  id: string;
  slug: LobbySlug;
  name: string;
  hostPlayerId: PlayerId | null;
  createdAt: number;
  expiresAt: number;
  currentGameId: GameId;
  state: Lobby['state'];
  players: InternalPlayer[];
  activity: ActivityMessage[];
  chat?: ChatMessage[]; // optional for backward compatibility with records persisted before chat existed
  gameSession: GameSession<LobbySnapshot> | null;
  lastEvent?: GameEventEnvelope | null; // optional for backward compatibility with records persisted before lastEvent existed
  // All optional for back-compat with records persisted before external-game support:
  // default mode 'local', inputSeq 0, inputLog [].
  mode?: 'local' | 'remote';
  inputSeq?: number;
  inputLog?: GameInputEnvelope[];
  controllerState?: Record<PlayerId, ControllerState>;
  screens?: string[];
  // A bare hash: a binding persisted before its bind time was kept.
  screenSecrets?: Record<string, ScreenSecret | string>;
  screenPresence?: Record<string, ScreenPresence>;
}

// The hashed secret a screen id is bound to, and when it was bound.
export interface ScreenSecret {
  hash: string;
  at: number;
}

// The socket a listed screen last joined with, and when that socket dropped
// (null while it is connected).
export interface ScreenPresence {
  socketId: string;
  leftAt: number | null;
}

export interface LobbyRecord {
  // Bumped by every committed change (see nextLobbyRev), so clients can tell
  // an older snapshot from a newer one and the commit can tell whether the
  // stored lobby moved on since it was loaded.
  rev: number;
  id: string;
  slug: LobbySlug;
  name: string;
  hostPlayerId: PlayerId | null;
  createdAt: number;
  expiresAt: number;
  currentGameId: GameId;
  state: Lobby['state'];
  players: Map<PlayerId, InternalPlayer>;
  activity: ActivityMessage[];
  chat: ChatMessage[];
  gameSession: GameSession<LobbySnapshot> | null;
  lastEvent: GameEventEnvelope | null;
  engine: TrebuchetEngine | null;
  mode: 'local' | 'remote';
  inputSeq: number;
  inputLog: GameInputEnvelope[];
  controllerState: Record<PlayerId, ControllerState>;
  screens: string[];
  // sha256 of each screen id's secret token (see joinScreen). Never public.
  screenSecrets: Record<string, ScreenSecret>;
  // Whether each listed screen is still connected, kept in the record so any
  // instance can tell (see markScreenLeft). Never public.
  screenPresence: Record<string, ScreenPresence>;
}

// What removing a player changed: the lobby, and the Trebuchet snapshot when
// a running game lost a unit.
export interface PlayerRemoval {
  lobby: Lobby;
  gameEvent: TrebuchetSnapshot | null;
}

export class LobbyError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

export class LobbyStore {
  readonly lobbies = new Map<LobbySlug, LobbyRecord>();
  private readonly resolveManifest: ManifestResolver;
  // Counts adopt calls; each adopted lobby remembers its count (see adopt).
  private adoptions = 0;
  private readonly adoptedAt = new WeakMap<LobbyRecord, number>();

  constructor(getManifest: ManifestResolver = builtinManifestResolver) {
    this.resolveManifest = getManifest;
  }

  // Resolve a manifest or throw the standard 404 LobbyError. Used where the
  // caller expects the game to exist (join/select/start).
  private manifestOrThrow(id: GameId): GameManifest {
    const manifest = this.resolveManifest(id);
    if (!manifest) throw new LobbyError('Spiel nicht gefunden', 404);
    return manifest;
  }

  createLobby(now = Date.now(), mode: 'local' | 'remote' = 'local'): LobbyRecord {
    let slug = randomSlug();
    while (this.lobbies.has(slug)) slug = randomSlug();
    const lobby: LobbyRecord = {
      rev: 0,
      id: createId('lobby'),
      slug,
      name: createRoomName(slug),
      hostPlayerId: null,
      createdAt: now,
      expiresAt: now + LOBBY_TTL_MS,
      currentGameId: getDefaultGameId(),
      state: 'waiting',
      players: new Map(),
      activity: [],
      chat: [],
      gameSession: null,
      lastEvent: null,
      engine: null,
      mode,
      inputSeq: 0,
      inputLog: [],
      controllerState: {},
      screens: [],
      screenSecrets: {},
      screenPresence: {}
    };
    this.addActivity(lobby, 'Lobby erstellt');
    this.lobbies.set(slug, lobby);
    return lobby;
  }

  getLobby(slug: string): LobbyRecord {
    const lobby = this.lobbies.get(slug.toUpperCase());
    if (!lobby) throw new LobbyError('Lobby nicht gefunden', 404);
    if (lobby.expiresAt <= Date.now()) {
      this.lobbies.delete(lobby.slug);
      throw new LobbyError('Lobby ist abgelaufen', 410);
    }
    return lobby;
  }

  // Something happened in the lobby: keep it for another LOBBY_TTL_MS (up to
  // LOBBY_MAX_AGE_MS after it was created), so a long evening of play doesn't
  // run into the TTL mid-game.
  keepAlive(lobby: LobbyRecord, now = Date.now()): void {
    const latest = lobby.createdAt + LOBBY_MAX_AGE_MS;
    lobby.expiresAt = Math.max(lobby.expiresAt, Math.min(now + LOBBY_TTL_MS, latest));
  }

  // The lobby is about to be committed with a change: give it the next rev
  // and keep it alive.
  markChanged(lobby: LobbyRecord, now = Date.now()): void {
    lobby.rev = nextLobbyRev(lobby.rev, now);
    this.keepAlive(lobby, now);
  }

  // Where a read of storage starts, for adopt.
  readMark(): number {
    return this.adoptions;
  }

  // Keep a lobby read from (`readMark` from before the read) or committed to
  // storage, unless the one held here is newer: a read that started before a
  // commit can finish after it. A read that started after the held lobby was
  // taken is what storage holds, though, even if its rev is lower (a deploy
  // from before revs stored it). Returns the one now held.
  adopt(record: LobbyRecord, readMark?: number): LobbyRecord {
    const held = this.lobbies.get(record.slug);
    if (held && held !== record && held.id === record.id && held.rev > record.rev) {
      if (readMark === undefined || (this.adoptedAt.get(held) ?? 0) > readMark) return held;
    }
    this.lobbies.set(record.slug, record);
    this.adoptedAt.set(record, ++this.adoptions);
    return record;
  }

  publicLobby(slugOrLobby: string | LobbyRecord): Lobby {
    const lobby = typeof slugOrLobby === 'string' ? this.getLobby(slugOrLobby) : slugOrLobby;
    return {
      id: lobby.id,
      rev: lobby.rev,
      slug: lobby.slug,
      name: lobby.name,
      hostPlayerId: lobby.hostPlayerId,
      createdAt: new Date(lobby.createdAt).toISOString(),
      expiresAt: new Date(lobby.expiresAt).toISOString(),
      currentGameId: lobby.currentGameId,
      state: lobby.state,
      players: [...lobby.players.values()].map((player) => this.publicPlayer(lobby, player)),
      activity: lobby.activity.slice(-8),
      chat: lobby.chat.slice(-50),
      gameSession: lobby.gameSession,
      lastEvent: lobby.lastEvent,
      mode: lobby.mode,
      inputLog: lobby.inputLog.slice(-INPUT_LOG_PUBLIC_LIMIT),
      controllerState: lobby.controllerState,
      screens: lobby.screens.slice(),
      hostScreenId: hostScreenId(lobby)
    };
  }

  // `connectionId` is the joining socket (none for the REST join).
  joinPlayer(slug: string, name: unknown, existingToken?: string, screenId?: unknown, connectionId?: string): JoinLobbyResponse {
    const lobby = this.getLobby(slug);
    const seat = cleanScreenId(screenId);
    const reconnect = existingToken
      ? [...lobby.players.values()].find((player) => player.token === existingToken)
      : undefined;

    if (reconnect) {
      const wasGone = !reconnect.connected;
      reconnect.connected = true;
      reconnect.disconnectedAt = null;
      reconnect.droppedAt = null;
      if (connectionId) reconnect.connectionId = connectionId;
      reconnect.name = sanitizePlayerName(name || reconnect.name);
      if (seat) reconnect.screenId = seat;
      // A phone back before it was even marked gone (see markDroppedGone)
      // reconnected quietly.
      if (wasGone) this.addActivity(lobby, `${reconnect.name} ist wieder verbunden`);
      return {
        lobby: this.publicLobby(lobby),
        player: this.publicPlayer(lobby, reconnect),
        playerToken: reconnect.token
      };
    }

    const manifest = this.manifestOrThrow(lobby.currentGameId);
    if (lobby.players.size >= manifest.maxPlayers) {
      throw new LobbyError('Lobby ist voll', 409);
    }
    if (lobby.state === 'playing') {
      throw new LobbyError('Dieses Spiel läuft schon', 409);
    }

    const player: InternalPlayer = {
      id: createId('player'),
      name: sanitizePlayerName(name),
      joinedAt: new Date().toISOString(),
      isHost: lobby.hostPlayerId === null,
      connected: true,
      colorIdx: this.nextColor(lobby),
      token: createId('token'),
      disconnectedAt: null,
      connectionId: connectionId ?? null,
      screenId: seat
    };
    lobby.players.set(player.id, player);
    if (!lobby.hostPlayerId) {
      lobby.hostPlayerId = player.id;
      player.isHost = true;
    }
    this.addActivity(lobby, `${player.name} ist beigetreten`);
    return {
      lobby: this.publicLobby(lobby),
      player: this.publicPlayer(lobby, player),
      playerToken: player.token
    };
  }

  renamePlayer(slug: string, playerToken: string, name: unknown): RenamePlayerResponse & { gameEvent: TrebuchetSnapshot | null } {
    const lobby = this.getLobby(slug);
    const player = this.playerByToken(lobby, playerToken);
    const nextName = sanitizePlayerName(name);
    const previousName = player.name;
    player.name = nextName;

    let gameEvent: TrebuchetSnapshot | null = null;
    if (lobby.engine) {
      gameEvent = lobby.engine.renamePlayer(player.id, nextName);
      this.updateGameSession(lobby, gameEvent);
    } else if (isTrebuchetSnapshot(lobby.gameSession?.snapshot)) {
      const snapshot = lobby.gameSession.snapshot;
      gameEvent = {
        ...snapshot,
        units: snapshot.units.map((unit) => (unit.id === player.id ? { ...unit, name: nextName } : unit))
      };
      this.updateGameSession(lobby, gameEvent);
    }

    if (previousName !== nextName) this.addActivity(lobby, `${previousName} heißt jetzt ${nextName}`);
    return {
      lobby: this.publicLobby(lobby),
      player: this.publicPlayer(lobby, player),
      gameEvent
    };
  }

  selectGame(slug: string, playerToken: string, gameId: GameId): Lobby {
    const lobby = this.getLobby(slug);
    this.assertHost(lobby, playerToken);
    const manifest = this.manifestOrThrow(gameId);
    if (manifest.comingSoon) throw new LobbyError('Dieses Spiel ist noch nicht spielbar', 409);
    // After a round ('ended') the host may pick the next game right away.
    if (lobby.state === 'playing') throw new LobbyError('Spielauswahl ist nur in der Lobby möglich');
    if (lobby.mode === 'remote' && isExternalManifest(manifest) && !manifest.supportsRemote) {
      throw new LobbyError('Dieses Spiel unterstützt Remote Couch nicht', 409);
    }
    lobby.currentGameId = gameId;
    this.addActivity(lobby, `Spiel gewählt: ${manifest.title}`);
    return this.publicLobby(lobby);
  }

  startGame(slug: string, playerToken: string): TrebuchetEvent | null {
    const lobby = this.getLobby(slug);
    this.assertHost(lobby, playerToken);
    if (lobby.state === 'playing') throw new LobbyError('Spiel läuft bereits');
    const manifest = this.manifestOrThrow(lobby.currentGameId);
    if (manifest.comingSoon) throw new LobbyError('Dieses Spiel ist noch nicht spielbar', 409);
    if (lobby.players.size < manifest.minPlayers) {
      throw new LobbyError(`Mindestens ${manifest.minPlayers} Spieler nötig`, 409);
    }

    // External (iframe-hosted) games run with no server engine. The server holds
    // only a seed + relayed input log; the game is deterministic client-side.
    if (isExternalManifest(manifest)) {
      lobby.engine = null;
      lobby.state = 'playing';
      lobby.inputSeq = 0;
      lobby.inputLog = [];
      lobby.controllerState = {};
      lobby.gameSession = {
        id: createId('session'),
        lobbyId: lobby.id,
        gameId: lobby.currentGameId,
        state: 'running',
        startedAt: new Date().toISOString(),
        endedAt: null,
        snapshot: { kind: 'external', seed: createSeed() }
      };
      this.addActivity(lobby, `${manifest.title} gestartet`);
      return null;
    }

    const engine = new TrebuchetEngine();
    const roster = [...lobby.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      colorIdx: player.colorIdx
    }));
    const event = engine.start(roster);
    lobby.engine = engine;
    lobby.state = 'playing';
    lobby.gameSession = {
      id: createId('session'),
      lobbyId: lobby.id,
      gameId: lobby.currentGameId,
      state: 'running',
      startedAt: new Date().toISOString(),
      endedAt: null,
      snapshot: event.snapshot
    };
    this.addActivity(lobby, 'Trebuchet gestartet');
    return event;
  }

  fire(slug: string, playerToken: string, angle: unknown, power: unknown): TrebuchetEvent | null {
    const lobby = this.getLobby(slug);
    const player = this.playerByToken(lobby, playerToken);
    const event = lobby.engine?.fire(player.id, angle, power) ?? null;
    if (event) this.updateGameSession(lobby, event.snapshot);
    return event;
  }

  controllerForCurrentTurn(slug: string, playerToken: string): Player | null {
    const lobby = this.getLobby(slug);
    const player = this.playerByToken(lobby, playerToken);
    const snapshot = lobby.gameSession?.snapshot;
    const turn = isTrebuchetSnapshot(snapshot) ? snapshot.turn : null;
    if (lobby.state !== 'playing' || turn !== player.id) return null;
    return this.publicPlayer(lobby, player);
  }

  // Skip the turn that ends at `turnEndsAt`, once that time has come. A turn
  // timer may be stale: a shot or a skip elsewhere (another instance, a
  // removed player) already moved on, and the new turn gets its full time.
  skipTurn(slug: string, turnEndsAt: number, now = Date.now()): TrebuchetEvent | null {
    const lobby = this.getLobby(slug);
    if (lobby.state !== 'playing' || turnEndsAtOf(lobby) !== turnEndsAt || turnEndsAt > now) return null;
    const event = lobby.engine?.skipTurn() ?? null;
    if (event) this.updateGameSession(lobby, event.snapshot);
    return event;
  }

  // Stamp the latest game event onto the lobby state with a monotonic seq so it
  // rides along the persisted+polled snapshot (reaching clients on other serverless
  // instances, where Socket.IO broadcasts don't cross). Only ever the newest event
  // is kept — it's overwritten each shot/turn.
  recordGameEvent(slug: string, event: TrebuchetEvent): number {
    const lobby = this.getLobby(slug);
    const seq = (lobby.lastEvent?.seq ?? 0) + 1;
    lobby.lastEvent = { seq, at: new Date().toISOString(), event };
    return seq;
  }

  // Relay one external-game controller input into the lobby's ordered input log.
  // The player is derived from the token (payload playerId is never trusted); the
  // control is validated against the current game's declared layout; the action
  // must be in the enum; the value payload is capped at 1KB. Stamps a monotonic
  // seq from a per-game-start counter and trims the ring buffer to the last 128.
  recordGameInput(slug: string, playerToken: string, event: ControllerEvent): GameInputEnvelope {
    const lobby = this.getLobby(slug);
    const player = this.playerByToken(lobby, playerToken);
    if (lobby.state !== 'playing') throw new LobbyError('Kein laufendes Spiel', 409);

    const manifest = this.manifestOrThrow(lobby.currentGameId);
    if (!isExternalManifest(manifest)) throw new LobbyError('Kein externes Spiel', 409);

    const rawControl = event?.control;
    if (typeof rawControl !== 'string') throw new LobbyError('Ungültige Steuerung', 400);
    const declared = manifest.controllerLayout.controls.some((ctrl) => ctrl.control === rawControl);
    if (!declared) throw new LobbyError('Unbekannte Steuerung', 400);

    const value = event?.value as { action?: unknown; data?: unknown } | undefined;
    const action = value?.action;
    if (typeof action !== 'string' || !INPUT_ACTIONS.includes(action as InputAction)) {
      throw new LobbyError('Ungültige Aktion', 400);
    }

    const data = value?.data;
    if (data !== undefined) {
      const encoded = JSON.stringify(data);
      if (typeof encoded === 'string' && encoded.length > MAX_INPUT_VALUE_BYTES) {
        throw new LobbyError('Eingabe zu groß', 413);
      }
    }

    const envelope: GameInputEnvelope = {
      seq: ++lobby.inputSeq,
      at: new Date().toISOString(),
      playerId: player.id,
      control: rawControl,
      action: action as InputAction,
      value: data
    };
    lobby.inputLog.push(envelope);
    if (lobby.inputLog.length > INPUT_LOG_LIMIT) {
      lobby.inputLog = lobby.inputLog.slice(-INPUT_LOG_LIMIT);
    }
    return envelope;
  }

  // Apply a running external game's instructions for one player's phone. Only
  // the trusted screen shell calls this (checked by the socket handler). Labels
  // and disabled controls must name controls the manifest declares; one-shot
  // cooldowns/vibrate are replaced by each patch and replayed once per seq.
  setControllerState(slug: string, playerId: PlayerId, patch: ControllerPatch): ControllerState {
    const lobby = this.getLobby(slug);
    if (lobby.state !== 'playing') throw new LobbyError('Kein laufendes Spiel', 409);
    if (!lobby.players.has(playerId)) throw new LobbyError('Spieler nicht gefunden', 404);
    const manifest = this.manifestOrThrow(lobby.currentGameId);
    if (!isExternalManifest(manifest)) throw new LobbyError('Kein externes Spiel', 409);
    const clean = sanitizeControllerPatch(patch, new Set(manifest.controllerLayout.controls.map((c) => c.control)));

    const prev = lobby.controllerState[playerId];
    const next: ControllerState = {
      seq: (prev?.seq ?? 0) + 1,
      labels: clean.labels ?? prev?.labels ?? {},
      disabled: clean.disabled ?? prev?.disabled ?? [],
      cooldowns: clean.cooldowns ?? {},
      vibrate: clean.vibrate ?? null
    };
    lobby.controllerState[playerId] = next;
    return next;
  }

  // Finish an external game with reported scores (from the trusted screen shell).
  // Idempotent: a duplicate report (e.g. from a second TV) is a no-op returning
  // false. So is a report for another round than the running one (`sessionId`,
  // left out by older TVs): a late retry must not end the next round with the
  // last one's scores. Scores are filtered to the current roster, one per
  // player. Entries that don't fit (a NaN score from a game bug, a bot, a
  // duplicate) are left out rather than refusing the whole report, which
  // would leave the round running with nobody able to end it.
  finishExternalGame(slug: string, scores: unknown, sessionId?: unknown): boolean {
    const lobby = this.getLobby(slug);
    const session = lobby.gameSession;
    if (!session || !isExternalSnapshot(session.snapshot)) return false;
    if (sessionId !== undefined && sessionId !== session.id) return false;
    if (session.state === 'finished' || lobby.state === 'ended') return false;

    if (!Array.isArray(scores)) throw new LobbyError('Ungültige Punktestände', 400);
    const clean: Array<{ playerId: PlayerId; score: number }> = [];
    for (const entry of scores) {
      if (!entry || typeof entry !== 'object') continue;
      const playerId = (entry as { playerId?: unknown }).playerId;
      const score = (entry as { score?: unknown }).score;
      if (typeof playerId !== 'string' || typeof score !== 'number' || !Number.isFinite(score)) continue;
      if (!lobby.players.has(playerId) || clean.some((row) => row.playerId === playerId)) continue;
      clean.push({ playerId, score });
    }

    session.snapshot = { ...session.snapshot, scores: clean };
    session.state = 'finished';
    session.endedAt = new Date().toISOString();
    lobby.state = 'ended';

    const winner = clean.slice().sort((a, b) => b.score - a.score)[0];
    const winnerName = winner ? lobby.players.get(winner.playerId)?.name : undefined;
    this.addActivity(lobby, winnerName ? `Spiel beendet — ${winnerName} gewinnt` : 'Spiel beendet');
    return true;
  }

  postChat(slug: string, playerToken: string, text: unknown): ChatMessage {
    const lobby = this.getLobby(slug);
    const player = this.playerByToken(lobby, playerToken);
    const clean = sanitizeChatText(text);
    if (!clean) throw new LobbyError('Nachricht ist leer');
    const message: ChatMessage = {
      id: createId('msg'),
      at: new Date().toISOString(),
      playerId: player.id,
      name: player.name,
      colorIdx: player.colorIdx,
      text: clean
    };
    lobby.chat.push(message);
    lobby.chat = lobby.chat.slice(-50);
    return message;
  }

  // The socket `connectionId` of a player dropped: they show as gone now.
  // Only the player's latest socket counts: a phone that already joined again
  // (here or on another instance, e.g. before the server noticed its old
  // connection die) stays connected. Returns null when nothing changed.
  markDisconnected(slug: string, playerId: PlayerId, at = Date.now(), connectionId?: string): Lobby | null {
    const lobby = this.lobbies.get(slug.toUpperCase());
    if (!lobby) return null;
    const player = lobby.players.get(playerId);
    if (!player || !player.connected) return null;
    if (connectionId && player.connectionId && player.connectionId !== connectionId) return null;
    this.showGone(lobby, player, at);
    return this.publicLobby(lobby);
  }

  // The socket `connectionId` of a player dropped, but they don't show as
  // gone yet: the platform closes long-lived connections every few minutes,
  // and the phone is back within a second or two. The drop is kept in the
  // record, so any instance can turn it into "gone" later (markDroppedGone).
  // Only the player's latest socket counts, as in markDisconnected. Returns
  // whether the record changed.
  noteDropped(slug: string, playerId: PlayerId, connectionId: string, at = Date.now()): boolean {
    const player = this.lobbies.get(slug.toUpperCase())?.players.get(playerId);
    if (!player || !player.connected || player.droppedAt != null) return false;
    if (player.connectionId && player.connectionId !== connectionId) return false;
    player.droppedAt = at;
    return true;
  }

  // Players whose socket dropped at least quietMs ago, without them joining
  // again since, now show as gone (from the time they dropped). Returns them.
  markDroppedGone(slug: string, now: number, quietMs: number): Array<{ playerId: PlayerId; since: number }> {
    const lobby = this.getLobby(slug);
    const gone: Array<{ playerId: PlayerId; since: number }> = [];
    for (const player of lobby.players.values()) {
      const since = player.droppedAt;
      if (since == null || !player.connected || now - since < quietMs) continue;
      this.showGone(lobby, player, since);
      gone.push({ playerId: player.id, since });
    }
    return gone;
  }

  // Whether dropGoneScreens or markDroppedGone would change anything now.
  // Read-only, so a poll can check without writing the lobby.
  hasPresenceToSettle(slug: string, now: number, graceMs: number, quietMs: number): boolean {
    const lobby = this.getLobby(slug);
    for (const id of lobby.screens) {
      const leftAt = lobby.screenPresence[id]?.leftAt;
      if (leftAt != null && now - leftAt >= graceMs) return true;
    }
    for (const player of lobby.players.values()) {
      if (player.droppedAt != null && player.connected && now - player.droppedAt >= quietMs) return true;
    }
    return false;
  }

  // Remove a player that has been gone since `since` (and didn't come back).
  // Returns null when nothing changed.
  removeIfStillDisconnected(slug: string, playerId: PlayerId, since: number): PlayerRemoval | null {
    const lobby = this.lobbies.get(slug.toUpperCase());
    if (!lobby) return null;
    const player = lobby.players.get(playerId);
    if (!player || player.connected || player.disconnectedAt !== since) return null;
    return this.removePlayer(lobby, player, `${player.name} wurde entfernt`);
  }

  // A player left on purpose (the phone's Leave button): drop them now
  // instead of after the reconnect grace, so the host role and the seat free
  // up right away.
  leavePlayer(slug: string, playerToken: string): PlayerRemoval {
    const lobby = this.getLobby(slug);
    const player = this.playerByToken(lobby, playerToken);
    return this.removePlayer(lobby, player, `${player.name} hat die Lobby verlassen`);
  }

  // The host ends the running game and takes everyone back to the lobby, e.g.
  // when the game never reported its end. No scores.
  endGame(slug: string, playerToken: string): Lobby {
    const lobby = this.getLobby(slug);
    this.assertHost(lobby, playerToken);
    if (lobby.state !== 'playing') throw new LobbyError('Kein laufendes Spiel', 409);
    this.endSession(lobby);
    this.addActivity(lobby, 'Spiel vom Host beendet');
    return this.publicLobby(lobby);
  }

  // The token of a player, for a socket that joined as that player.
  tokenOf(slug: string, playerId: PlayerId): PlayerToken | undefined {
    return this.lobbies.get(slug.toUpperCase())?.players.get(playerId)?.token;
  }

  pruneExpired(now = Date.now()): number {
    let removed = 0;
    for (const [slug, lobby] of this.lobbies) {
      if (lobby.expiresAt <= now) {
        this.lobbies.delete(slug);
        removed++;
      }
    }
    return removed;
  }

  // Take a player out of the lobby (and out of a running Trebuchet game). The
  // host role moves on. An emptied lobby is kept, so a TV still showing it
  // keeps working and the next player to join becomes its host; a game still
  // running in it ends, or nobody could join again.
  private removePlayer(lobby: LobbyRecord, player: InternalPlayer, activity: string): PlayerRemoval {
    lobby.players.delete(player.id);
    let gameSnapshot: TrebuchetSnapshot | null = null;
    if (lobby.engine && lobby.state === 'playing') {
      gameSnapshot = lobby.engine.removePlayer(player.id);
      this.updateGameSession(lobby, gameSnapshot);
    }
    this.addActivity(lobby, activity);
    if (lobby.hostPlayerId === player.id) this.promoteHost(lobby);
    if (lobby.players.size === 0 && lobby.state === 'playing') this.endSession(lobby);
    return { lobby: this.publicLobby(lobby), gameEvent: gameSnapshot };
  }

  private endSession(lobby: LobbyRecord): void {
    lobby.engine = null;
    if (lobby.gameSession && lobby.gameSession.state !== 'finished') {
      lobby.gameSession.state = 'finished';
      lobby.gameSession.endedAt = new Date().toISOString();
    }
    lobby.state = 'ended';
  }

  private updateGameSession(lobby: LobbyRecord, snapshot: TrebuchetSnapshot): void {
    if (!lobby.gameSession) return;
    lobby.gameSession.snapshot = snapshot;
    if (snapshot.phase === 'finished') {
      lobby.gameSession.state = 'finished';
      lobby.gameSession.endedAt = new Date().toISOString();
      lobby.state = 'ended';
    }
  }

  private publicPlayer(lobby: LobbyRecord, player: InternalPlayer): Player {
    return {
      id: player.id,
      name: player.name,
      joinedAt: player.joinedAt,
      isHost: lobby.hostPlayerId === player.id,
      connected: player.connected,
      colorIdx: player.colorIdx,
      screenId: player.screenId ?? null
    };
  }

  // A TV showing this lobby. The first join of a screen id binds it to a
  // secret token (only its hash is kept; the token goes back once, to that
  // TV) and every later join with that id must present it, so the public
  // screen ids can't be taken over. Screens are remembered in join order so
  // the host screen is stable; a new one is refused once the lobby is full
  // (nobody gets evicted). `socketId` is the joining connection, see
  // markScreenLeft. `changed` says whether the record needs saving.
  joinScreen(
    slug: string,
    screenId: unknown,
    screenToken: unknown,
    socketId?: string,
    now = Date.now()
  ): { screenId: string | null; changed: boolean; screenToken?: string } {
    const lobby = this.getLobby(slug);
    const id = cleanScreenId(screenId);
    if (!id) return { screenId: null, changed: false };
    const listed = lobby.screens.includes(id);
    const bound = lobby.screenSecrets[id];
    if (bound && (typeof screenToken !== 'string' || !sameHash(hashScreenToken(screenToken), bound.hash))) {
      throw new LobbyError('Dieser Screen gehört zu einem anderen Gerät', 403);
    }
    if (!listed && lobby.screens.length >= MAX_LOBBY_SCREENS) throw new LobbyError('Diese Lobby hat schon genug Screens', 409);
    let minted: string | undefined;
    if (!bound) {
      this.forgetOldScreenSecrets(lobby);
      minted = randomBytes(24).toString('base64url');
      lobby.screenSecrets[id] = { hash: hashScreenToken(minted), at: now };
    }
    if (!listed) lobby.screens.push(id);
    let present = false;
    if (socketId !== undefined) {
      const before = lobby.screenPresence[id];
      present = before?.socketId !== socketId || before.leftAt !== null;
      lobby.screenPresence[id] = { socketId, leftAt: null };
    }
    return { screenId: id, changed: !listed || !!minted || present, screenToken: minted };
  }

  // The socket a screen joined with dropped. Only its latest socket counts: a
  // TV that already joined again (here or on another instance) stays as it
  // is. Returns whether the record changed.
  markScreenLeft(slug: string, screenId: string, socketId: string, at = Date.now()): boolean {
    const lobby = this.lobbies.get(slug.toUpperCase());
    const presence = lobby?.screenPresence[screenId];
    if (!lobby || !presence || presence.socketId !== socketId || presence.leftAt !== null) return false;
    if (!lobby.screens.includes(screenId)) return false;
    presence.leftAt = at;
    return true;
  }

  // Drop every screen whose socket left at least graceMs ago without the TV
  // joining again since. Their token binding stays, so the same TV can come
  // back later. Returns whether any screen was dropped.
  dropGoneScreens(slug: string, now: number, graceMs: number): boolean {
    const lobby = this.getLobby(slug);
    const gone = lobby.screens.filter((id) => {
      const leftAt = lobby.screenPresence[id]?.leftAt;
      return leftAt != null && now - leftAt >= graceMs;
    });
    for (const id of gone) this.removeScreen(slug, id);
    return gone.length > 0;
  }

  // Take a screen out of lobby.screens (its binding stays).
  removeScreen(slug: string, screenId: string): boolean {
    const lobby = this.getLobby(slug);
    if (!lobby.screens.includes(screenId)) return false;
    lobby.screens = lobby.screens.filter((id) => id !== screenId);
    delete lobby.screenPresence[screenId];
    return true;
  }

  // Make room for one more screen binding by forgetting the oldest ones of
  // ids that are neither listed nor a player's seat. Such a TV left long ago;
  // if it comes back it is simply bound anew. So ids that joined and left
  // can't lock new TVs out, and a seat id can't be freed up for someone else.
  private forgetOldScreenSecrets(lobby: LobbyRecord): void {
    const ids = Object.keys(lobby.screenSecrets);
    if (ids.length < MAX_SCREEN_SECRETS) return;
    const kept = new Set<string>(lobby.screens);
    for (const player of lobby.players.values()) if (player.screenId) kept.add(player.screenId);
    const stale = ids
      .filter((id) => !kept.has(id))
      .sort((a, b) => lobby.screenSecrets[a].at - lobby.screenSecrets[b].at)
      .slice(0, ids.length - MAX_SCREEN_SECRETS + 1);
    if (ids.length - stale.length >= MAX_SCREEN_SECRETS) throw new LobbyError('Diese Lobby hat schon genug Screens', 409);
    for (const id of stale) {
      delete lobby.screenSecrets[id];
      delete lobby.screenPresence[id];
    }
  }

  private nextColor(lobby: LobbyRecord): number {
    const used = new Set([...lobby.players.values()].map((player) => player.colorIdx));
    for (let i = 0; i < 8; i++) {
      if (!used.has(i)) return i;
    }
    return lobby.players.size;
  }

  private assertHost(lobby: LobbyRecord, token: string): void {
    const player = this.playerByToken(lobby, token);
    if (lobby.hostPlayerId !== player.id) throw new LobbyError('Nur der Host kann das tun', 403);
  }

  private playerByToken(lobby: LobbyRecord, token: string): InternalPlayer {
    const player = [...lobby.players.values()].find((candidate) => candidate.token === token);
    if (!player) throw new LobbyError('Controller nicht verbunden', 401);
    return player;
  }

  private promoteHost(lobby: LobbyRecord): void {
    const next = lobby.players.values().next().value as InternalPlayer | undefined;
    lobby.hostPlayerId = next?.id ?? null;
    for (const player of lobby.players.values()) player.isHost = player.id === lobby.hostPlayerId;
    if (next) this.addActivity(lobby, `${next.name} ist jetzt Host`);
  }

  private showGone(lobby: LobbyRecord, player: InternalPlayer, at: number): void {
    player.connected = false;
    player.disconnectedAt = at;
    player.droppedAt = null;
    this.addActivity(lobby, `${player.name} Verbindung verloren`);
  }

  private addActivity(lobby: LobbyRecord, text: string): void {
    lobby.activity.push({ id: createId('activity'), at: new Date().toISOString(), text });
    lobby.activity = lobby.activity.slice(-20);
  }
}

export function sanitizeChatText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

export function serializeLobbyRecord(lobby: LobbyRecord): SerializedLobbyRecord {
  return {
    rev: lobby.rev,
    id: lobby.id,
    slug: lobby.slug,
    name: lobby.name,
    hostPlayerId: lobby.hostPlayerId,
    createdAt: lobby.createdAt,
    expiresAt: lobby.expiresAt,
    currentGameId: lobby.currentGameId,
    state: lobby.state,
    players: [...lobby.players.values()].map((player) => ({ ...player })),
    activity: lobby.activity.slice(),
    chat: lobby.chat.slice(),
    gameSession: lobby.gameSession
      ? {
          ...lobby.gameSession,
          snapshot: cloneSnapshot(lobby.gameSession.snapshot)
        }
      : null,
    lastEvent: lobby.lastEvent,
    mode: lobby.mode,
    inputSeq: lobby.inputSeq,
    inputLog: lobby.inputLog.slice(),
    controllerState: structuredClone(lobby.controllerState),
    screens: lobby.screens.slice(),
    screenSecrets: structuredClone(lobby.screenSecrets),
    screenPresence: structuredClone(lobby.screenPresence)
  };
}

// A copy of a lobby to change, which shares nothing it could change with the
// original (the engine is rebuilt from the snapshot).
export function cloneLobbyRecord(lobby: LobbyRecord): LobbyRecord {
  return deserializeLobbyRecord(serializeLobbyRecord(lobby));
}

// The rev of a lobby's next committed change. Never below the clock, so it
// still moves forward when a writer without revs (a deploy from before them)
// stored the lobby in between and it reads as 0.
export function nextLobbyRev(rev: number, now = Date.now()): number {
  return Math.max(rev + 1, now);
}

export function deserializeLobbyRecord(serialized: SerializedLobbyRecord): LobbyRecord {
  const snapshot = serialized.gameSession?.snapshot ?? null;
  return {
    rev: serialized.rev ?? 0,
    id: serialized.id,
    slug: serialized.slug.toUpperCase(),
    name: serialized.name,
    hostPlayerId: serialized.hostPlayerId,
    createdAt: serialized.createdAt,
    expiresAt: serialized.expiresAt,
    currentGameId: serialized.currentGameId,
    state: serialized.state,
    players: new Map(serialized.players.map((player) => [player.id, { ...player }])),
    activity: serialized.activity.slice(),
    chat: serialized.chat ?? [],
    gameSession: serialized.gameSession
      ? {
          ...serialized.gameSession,
          snapshot: cloneSnapshot(serialized.gameSession.snapshot)
        }
      : null,
    lastEvent: serialized.lastEvent ?? null,
    // Only rebuild a Trebuchet engine for a live Trebuchet snapshot — external
    // games have no engine, and fromSnapshot would fault on their shape.
    engine:
      isTrebuchetSnapshot(snapshot) && serialized.state === 'playing'
        ? TrebuchetEngine.fromSnapshot(snapshot)
        : null,
    // Back-compat: records persisted before external-game support lack these.
    mode: serialized.mode ?? 'local',
    inputSeq: serialized.inputSeq ?? 0,
    inputLog: serialized.inputLog ? serialized.inputLog.slice() : [],
    controllerState: serialized.controllerState ? structuredClone(serialized.controllerState) : {},
    screens: serialized.screens ? serialized.screens.slice() : [],
    screenSecrets: readScreenSecrets(serialized.screenSecrets),
    screenPresence: serialized.screenPresence ? structuredClone(serialized.screenPresence) : {}
  };
}

const MAX_LOBBY_SCREENS = 8;
// Screen ids bound in one lobby at a time (screens that left keep their
// binding until room is needed, see forgetOldScreenSecrets).
const MAX_SCREEN_SECRETS = 32;
const SCREEN_ID_RE = /^scr_[A-Za-z0-9_-]{1,60}$/;

function cleanScreenId(value: unknown): string | null {
  return typeof value === 'string' && SCREEN_ID_RE.test(value) ? value : null;
}

// Bindings persisted as a bare hash count as the oldest.
function readScreenSecrets(raw: SerializedLobbyRecord['screenSecrets']): Record<string, ScreenSecret> {
  const out: Record<string, ScreenSecret> = {};
  for (const [id, value] of Object.entries(raw ?? {})) {
    out[id] = typeof value === 'string' ? { hash: value, at: 0 } : { hash: value.hash, at: value.at };
  }
  return out;
}

function hashScreenToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Constant-time compare of two sha256 hex digests.
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

// The screen that runs a host-authoritative game: wherever the host player
// sits, else the first screen that showed up. Local lobbies have one screen,
// so it's simply that one. `screens` only lists live screens (a TV that left
// is dropped after a grace period), so a dead seat is never the host.
export function hostScreenId(lobby: LobbyRecord): string | null {
  const host = lobby.hostPlayerId ? lobby.players.get(lobby.hostPlayerId) : undefined;
  if (host?.screenId && lobby.screens.includes(host.screenId)) return host.screenId;
  return lobby.screens[0] ?? null;
}

// When the current Trebuchet turn runs out (null without a running turn).
export function turnEndsAtOf(lobby: LobbyRecord): number | null {
  const snapshot = lobby.gameSession?.snapshot;
  if (lobby.state !== 'playing' || !isTrebuchetSnapshot(snapshot)) return null;
  return typeof snapshot.turnEndsAt === 'number' ? snapshot.turnEndsAt : null;
}

const MAX_LABEL_CHARS = 16;
const MAX_COOLDOWN_MS = 60_000;
const MAX_VIBRATE_STEPS = 10;
const MAX_VIBRATE_STEP_MS = 1_000;

// Validate a game's controller patch against the declared control names.
// Throws LobbyError(400) on anything malformed rather than silently trimming,
// so a creator sees the mistake in /dev.
export function sanitizeControllerPatch(
  patch: unknown,
  controls: Set<string>
): { labels?: Record<string, string>; disabled?: string[]; cooldowns?: Record<string, number>; vibrate?: number[] } {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new LobbyError('Ungültiger Controller-Patch');
  const raw = patch as Record<string, unknown>;
  const out: ReturnType<typeof sanitizeControllerPatch> = {};
  const known = (control: string) => {
    if (!controls.has(control)) throw new LobbyError(`Unbekannte Steuerung: ${control}`);
  };

  if (raw.labels !== undefined) {
    if (!raw.labels || typeof raw.labels !== 'object' || Array.isArray(raw.labels)) throw new LobbyError('labels muss ein Objekt sein');
    // Null-prototype maps: a control key can never hit Object.prototype.
    out.labels = Object.create(null) as Record<string, string>;
    for (const [control, label] of Object.entries(raw.labels)) {
      known(control);
      if (typeof label !== 'string' || !label.trim() || label.trim().length > MAX_LABEL_CHARS) {
        throw new LobbyError(`Label für ${control} muss 1-${MAX_LABEL_CHARS} Zeichen haben`);
      }
      out.labels[control] = label.trim();
    }
  }
  if (raw.disabled !== undefined) {
    if (!Array.isArray(raw.disabled)) throw new LobbyError('disabled muss eine Liste sein');
    out.disabled = [];
    for (const control of raw.disabled) {
      if (typeof control !== 'string') throw new LobbyError('disabled enthält keinen Steuerungsnamen');
      known(control);
      if (!out.disabled.includes(control)) out.disabled.push(control);
    }
  }
  if (raw.cooldowns !== undefined) {
    if (!raw.cooldowns || typeof raw.cooldowns !== 'object' || Array.isArray(raw.cooldowns)) throw new LobbyError('cooldowns muss ein Objekt sein');
    out.cooldowns = Object.create(null) as Record<string, number>;
    for (const [control, ms] of Object.entries(raw.cooldowns)) {
      known(control);
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > MAX_COOLDOWN_MS) {
        throw new LobbyError(`Cooldown für ${control} muss 0-${MAX_COOLDOWN_MS} ms sein`);
      }
      out.cooldowns[control] = Math.round(ms);
    }
  }
  if (raw.vibrate !== undefined) {
    const steps = typeof raw.vibrate === 'number' ? [raw.vibrate] : raw.vibrate;
    if (
      !Array.isArray(steps) ||
      steps.length === 0 ||
      steps.length > MAX_VIBRATE_STEPS ||
      steps.some((ms) => typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > MAX_VIBRATE_STEP_MS)
    ) {
      throw new LobbyError(`vibrate muss 1-${MAX_VIBRATE_STEPS} Werte von 0-${MAX_VIBRATE_STEP_MS} ms haben`);
    }
    out.vibrate = (steps as number[]).map((ms) => Math.round(ms));
  }
  return out;
}

// Deep-clone a stored snapshot. External snapshots are shallow (seed + scores)
// so a spread suffices; Trebuchet snapshots need their nested arrays copied.
function cloneSnapshot(snapshot: LobbySnapshot): LobbySnapshot {
  if (!isTrebuchetSnapshot(snapshot)) {
    return { ...snapshot, ...(snapshot.scores ? { scores: snapshot.scores.map((s) => ({ ...s })) } : {}) };
  }
  return {
    ...snapshot,
    heights: snapshot.heights.slice(),
    units: snapshot.units.map((unit) => ({ ...unit })),
    castles: snapshot.castles.map((castle) => ({
      id: castle.id,
      blocks: castle.blocks.map((block) => ({ ...block }))
    })),
    order: snapshot.order.slice()
  };
}
