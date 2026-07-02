import type {
  ActivityMessage,
  ChatMessage,
  ControllerEvent,
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

// Resolves a game id to its manifest (built-in or env-registered external),
// returning null for unknown ids. Injected into LobbyStore so the store never
// calls the throwing getGameManifest directly and can see external games.
export type ManifestResolver = (id: GameId) => GameManifest | null;

const INPUT_ACTIONS: readonly InputAction[] = ['press', 'release', 'change'];
const MAX_INPUT_VALUE_BYTES = 1024;
const INPUT_LOG_LIMIT = 128;
const INPUT_LOG_PUBLIC_LIMIT = 64;
const MAX_EXTERNAL_SCORES = 8;

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
export const RECONNECT_GRACE_MS = 10 * 60 * 1000;

export interface InternalPlayer extends Player {
  token: PlayerToken;
  disconnectedAt: number | null;
}

export interface SerializedLobbyRecord {
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
}

export interface LobbyRecord {
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
      inputLog: []
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

  publicLobby(slugOrLobby: string | LobbyRecord): Lobby {
    const lobby = typeof slugOrLobby === 'string' ? this.getLobby(slugOrLobby) : slugOrLobby;
    return {
      id: lobby.id,
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
      inputLog: lobby.inputLog.slice(-INPUT_LOG_PUBLIC_LIMIT)
    };
  }

  joinPlayer(slug: string, name: unknown, existingToken?: string): JoinLobbyResponse {
    const lobby = this.getLobby(slug);
    const reconnect = existingToken
      ? [...lobby.players.values()].find((player) => player.token === existingToken)
      : undefined;

    if (reconnect) {
      reconnect.connected = true;
      reconnect.disconnectedAt = null;
      reconnect.name = sanitizePlayerName(name || reconnect.name);
      this.addActivity(lobby, `${reconnect.name} ist wieder verbunden`);
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
      disconnectedAt: null
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
    if (lobby.state !== 'waiting') throw new LobbyError('Spielauswahl ist nur in der Lobby möglich');
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

  skipTurn(slug: string): TrebuchetEvent | null {
    const lobby = this.getLobby(slug);
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

  // Finish an external game with reported scores (from the trusted screen shell).
  // Idempotent: a duplicate report (e.g. from a second TV) is a no-op returning
  // false. Scores are validated and filtered to the current roster.
  finishExternalGame(slug: string, scores: unknown): boolean {
    const lobby = this.getLobby(slug);
    const session = lobby.gameSession;
    if (!session || !isExternalSnapshot(session.snapshot)) return false;
    if (session.state === 'finished' || lobby.state === 'ended') return false;

    if (!Array.isArray(scores) || scores.length > MAX_EXTERNAL_SCORES) {
      throw new LobbyError('Ungültige Punktestände', 400);
    }
    const roster = new Set(lobby.players.keys());
    const clean: Array<{ playerId: PlayerId; score: number }> = [];
    for (const entry of scores) {
      if (!entry || typeof entry !== 'object') continue;
      const playerId = (entry as { playerId?: unknown }).playerId;
      const score = (entry as { score?: unknown }).score;
      if (typeof playerId !== 'string' || typeof score !== 'number' || !Number.isFinite(score)) {
        throw new LobbyError('Ungültige Punktestände', 400);
      }
      if (roster.has(playerId)) clean.push({ playerId, score });
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

  markDisconnected(slug: string, playerId: PlayerId, at = Date.now()): Lobby | null {
    const lobby = this.lobbies.get(slug.toUpperCase());
    if (!lobby) return null;
    const player = lobby.players.get(playerId);
    if (!player) return this.publicLobby(lobby);
    player.connected = false;
    player.disconnectedAt = at;
    this.addActivity(lobby, `${player.name} Verbindung verloren`);
    return this.publicLobby(lobby);
  }

  removeIfStillDisconnected(slug: string, playerId: PlayerId, since: number): { lobby: Lobby; gameEvent: TrebuchetSnapshot | null } | null {
    const lobby = this.lobbies.get(slug.toUpperCase());
    if (!lobby) return null;
    const player = lobby.players.get(playerId);
    if (!player || player.connected || player.disconnectedAt !== since) {
      return { lobby: this.publicLobby(lobby), gameEvent: null };
    }

    lobby.players.delete(playerId);
    let gameSnapshot: TrebuchetSnapshot | null = null;
    if (lobby.engine && lobby.state === 'playing') {
      gameSnapshot = lobby.engine.removePlayer(playerId);
      this.updateGameSession(lobby, gameSnapshot);
    }
    if (lobby.hostPlayerId === playerId) this.promoteHost(lobby);
    if (lobby.players.size === 0) {
      this.lobbies.delete(lobby.slug);
      return null;
    }
    this.addActivity(lobby, `${player.name} wurde entfernt`);
    return { lobby: this.publicLobby(lobby), gameEvent: gameSnapshot };
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
      colorIdx: player.colorIdx
    };
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
    inputLog: lobby.inputLog.slice()
  };
}

export function deserializeLobbyRecord(serialized: SerializedLobbyRecord): LobbyRecord {
  const snapshot = serialized.gameSession?.snapshot ?? null;
  return {
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
    inputLog: serialized.inputLog ? serialized.inputLog.slice() : []
  };
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
