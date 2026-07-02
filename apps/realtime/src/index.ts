import http from 'node:http';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { Server, type ServerOptions } from 'socket.io';
import { GAME_MANIFESTS } from '@couch/game-runtime';
import type { TrebuchetEvent } from '@couch/trebuchet';
import type { ControllerEvent, GameId, GameManifest, PlayerId, ScreenId } from '@couch/types';
import { LobbyError, LobbyStore, RECONNECT_GRACE_MS, type LobbyRecord, type ManifestResolver } from './lobbies.js';
import { mergeCatalog, parseExternalGamesJson } from './external-games.js';
import { RateLimiter } from './rate-limit.js';
import { createProductionLobbyPersistence } from './persistence.js';
import { ScreenRegistry } from './screens.js';

interface SocketContext {
  role: 'screen' | 'controller' | 'screen-pairing';
  slug: string;
  playerId?: PlayerId;
  screenId?: ScreenId;
}

export interface RealtimeServerOptions {
  apiPrefix?: string;
  clientOrigin?: string;
  socketPath?: string;
  websocketOnly?: boolean;
}

export interface RealtimeServerInstance {
  app: express.Express;
  io: Server;
  server: http.Server;
  store: LobbyStore;
}

export function createRealtimeServer(options: RealtimeServerOptions = {}): RealtimeServerInstance {
  const clientOrigin = options.clientOrigin ?? process.env.CLIENT_ORIGIN ?? '*';
  const apiPrefix = normalizeApiPrefix(options.apiPrefix ?? process.env.API_PREFIX ?? '/api');
  const socketPath = options.socketPath ?? process.env.SOCKET_PATH ?? '/socket.io';
  // Env-registered external games (ops escape hatch before the durable registry).
  // Parsed once at startup; localhost http is allowed only off Vercel (local dev).
  const externalGames = parseExternalGamesJson(process.env.EXTERNAL_GAMES_JSON, {
    allowHttpLocalhost: !process.env.VERCEL
  });
  const externalById = new Map<GameId, GameManifest>(externalGames.map((game) => [game.id, game]));

  // Resolver the store uses instead of the throwing getGameManifest: built-ins
  // first, then env-registered externals.
  const resolveManifest: ManifestResolver = (id) =>
    GAME_MANIFESTS.find((game) => game.id === id) ?? externalById.get(id) ?? null;

  // Merged catalog served everywhere the built-in list used to be.
  const catalog = (): GameManifest[] => mergeCatalog(externalGames);

  const store = new LobbyStore(resolveManifest);
  const screens = new ScreenRegistry();
  const persistence = createProductionLobbyPersistence();
  const turnTimers = new Map<string, NodeJS.Timeout>();
  const inputLimiter = new RateLimiter();

  const app = express();
  app.use(cors({ origin: clientOrigin }));
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, lobbies: store.lobbies.size });
  });

  app.get(`${apiPrefix}/health`, (_req, res) => {
    res.json({ ok: true, lobbies: store.lobbies.size });
  });

  app.get(`${apiPrefix}/games`, (_req, res) => {
    res.json({ games: catalog() });
  });

  app.post(`${apiPrefix}/lobbies`, async (req, res) => {
    try {
      const mode = req.body?.mode === 'remote' ? 'remote' : 'local';
      const lobby = store.createLobby(Date.now(), mode);
      await saveLobby(lobby);
      res.status(201).json({ lobby: store.publicLobby(lobby) });
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  app.get(`${apiPrefix}/lobbies/:slug`, async (req, res) => {
    try {
      await hydrateLobby(req.params.slug);
      res.json({ lobby: store.publicLobby(req.params.slug) });
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  app.post(`${apiPrefix}/lobbies/:slug/players`, async (req, res) => {
    try {
      await hydrateLobby(req.params.slug);
      const joined = store.joinPlayer(req.params.slug, req.body?.name, req.body?.playerToken);
      await saveLobby(req.params.slug);
      res.status(201).json(joined);
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  const server = http.createServer(app);
  const socketOptions: Partial<ServerOptions> = {
    cors: { origin: clientOrigin },
    path: socketPath,
    // Detect a dropped controller (locked/slept phone) within ~10s instead of the
    // ~45s engine.io default, so the lobby reflects "reconnecting" promptly.
    pingInterval: 5000,
    pingTimeout: 5000
  };
  if (options.websocketOnly) socketOptions.transports = ['websocket'];
  const io = new Server(server, socketOptions);

  io.on('connection', (socket) => {
    let ctx: SocketContext | null = null;

    socket.on('screen:join', async (payload: { slug?: string }, ack?: (value: unknown) => void) => {
      try {
        const slug = String(payload?.slug ?? '').toUpperCase();
        await hydrateLobby(slug);
        const lobby = store.publicLobby(slug);
        ctx = { role: 'screen', slug };
        socket.join(room(slug));
        ack?.({ ok: true, lobby, games: catalog() });
        socket.emit('lobby:snapshot', lobby);
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    socket.on('controller:join', async (payload: { slug?: string; name?: string; playerToken?: string }, ack?: (value: unknown) => void) => {
      try {
        const slug = String(payload?.slug ?? '').toUpperCase();
        await hydrateLobby(slug);
        const joined = store.joinPlayer(slug, payload?.name, payload?.playerToken);
        await saveLobby(slug);
        ctx = { role: 'controller', slug, playerId: joined.player.id };
        socket.join(room(slug));
        ack?.({ ok: true, ...joined, games: catalog() });
        emitLobby(slug);
        await autoStartIfFull(slug);
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    socket.on('controller:rename', async (payload: { slug?: string; playerToken?: string; name?: string }, ack?: (value: unknown) => void) => {
      try {
        const slug = String(payload?.slug ?? '').toUpperCase();
        await hydrateLobby(slug);
        const renamed = store.renamePlayer(slug, String(payload?.playerToken ?? ''), payload?.name);
        await saveLobby(slug);
        ack?.({ ok: true, lobby: renamed.lobby, player: renamed.player });
        if (renamed.gameEvent) io.to(room(slug)).emit('game:event', { type: 'snapshot', snapshot: renamed.gameEvent });
        emitLobby(slug);
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    socket.on('game:select', async (payload: { slug?: string; playerToken?: string; gameId?: GameId }, ack?: (value: unknown) => void) => {
      try {
        const slug = String(payload?.slug ?? '').toUpperCase();
        await hydrateLobby(slug);
        const lobby = store.selectGame(slug, String(payload?.playerToken ?? ''), payload?.gameId ?? 'trebuchet');
        await saveLobby(slug);
        ack?.({ ok: true, lobby });
        emitLobby(lobby.slug);
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    socket.on('game:start', async (payload: { slug?: string; playerToken?: string }, ack?: (value: unknown) => void) => {
      try {
        const slug = String(payload?.slug ?? '').toUpperCase();
        await hydrateLobby(slug);
        const event = store.startGame(slug, String(payload?.playerToken ?? ''));
        ack?.({ ok: true, event });
        // External games return null (no engine event): just persist + broadcast
        // the started lobby; only the Trebuchet path dispatches/arms a turn timer.
        if (event) {
          await dispatchGameEvent(slug, event);
          armTurnTimer(slug);
        } else {
          await saveLobby(slug);
          emitLobby(slug);
        }
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    socket.on('controller:event', async (payload: { slug?: string; playerToken?: string; event?: ControllerEvent }, ack?: (value: unknown) => void) => {
      try {
        const slug = String(payload?.slug ?? '').toUpperCase();
        await hydrateLobby(slug);
        const controllerEvent = payload?.event;
        if (!controllerEvent) throw new LobbyError('Controller-Event fehlt');

        // External (iframe-hosted) games relay inputs into the lobby's ordered
        // input log — no server engine. Persist (the correctness path other
        // instances poll) BEFORE emitting the socket envelope (the fast path).
        const currentManifest = resolveManifest(store.getLobby(slug).currentGameId);
        if (currentManifest?.origin === 'external') {
          const playerToken = String(payload?.playerToken ?? '');
          // Derive the player from the token for rate-limiting; recordGameInput
          // re-derives and throws 401 if the token is unknown.
          const derivedId = derivePlayerId(store.getLobby(slug), playerToken);
          if (derivedId && !inputLimiter.allow(slug, derivedId)) {
            // Rate-limited drops are not errors — acking success keeps the
            // controller stream healthy; the input is simply not relayed.
            ack?.({ ok: true, dropped: true });
            return;
          }
          const envelope = store.recordGameInput(slug, playerToken, controllerEvent);
          ack?.({ ok: true, seq: envelope.seq });
          await saveLobby(slug);
          io.to(room(slug)).emit('game:input', envelope);
          return;
        }

        let event = null;
        let controlPreview: { playerId: PlayerId; control: string; value: unknown; timestamp: number } | null = null;
        if (controllerEvent.control === 'fire' || controllerEvent.control === 'trebuchet.fire') {
          const value = controllerEvent.value as { angle?: number; power?: number };
          event = store.fire(slug, String(payload?.playerToken ?? ''), value?.angle, value?.power);
        } else if (isTrebuchetPreviewControl(controllerEvent.control)) {
          const player = store.controllerForCurrentTurn(slug, String(payload?.playerToken ?? ''));
          if (player) {
            controlPreview = {
              playerId: player.id,
              control: canonicalTrebuchetControl(controllerEvent.control),
              value: controllerEvent.value,
              timestamp: controllerEvent.timestamp
            };
          }
        }
        ack?.({ ok: true, event });
        if (controlPreview) {
          io.to(room(slug)).emit('game:control', controlPreview);
        }
        if (event) {
          await dispatchGameEvent(slug, event);
          armTurnTimer(slug);
        }
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    // An external game reports its final scores. Accepted ONLY from the trusted
    // screen shell (the iframe can't reach the socket) whose joined slug matches.
    // Idempotent: a duplicate report (e.g. a second TV) acks { ok:true, finished:false }.
    socket.on('game:finish', async (payload: { slug?: string; scores?: unknown }, ack?: (value: unknown) => void) => {
      try {
        const slug = String(payload?.slug ?? '').toUpperCase();
        if (!ctx || ctx.role !== 'screen' || ctx.slug !== slug) {
          throw new LobbyError('Nur der Screen kann das Spiel beenden', 403);
        }
        await hydrateLobby(slug);
        const finished = store.finishExternalGame(slug, payload?.scores);
        ack?.({ ok: true, finished });
        if (finished) {
          await saveLobby(slug);
          emitLobby(slug);
        }
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    socket.on('screen:register', async (payload: { screenId?: string }, ack?: (value: unknown) => void) => {
      try {
        if (payload?.screenId) await hydrateScreen(payload.screenId);
        const record = screens.registerOrReuse(payload?.screenId);
        await saveScreen(record.id);
        ctx = { role: 'screen-pairing', slug: '', screenId: record.id };
        socket.join(screenRoom(record.id));
        ack?.({ ok: true, screen: screens.toPublic(record) });
        if (record.claimedSlug) socket.emit('screen:claimed', { screenId: record.id, slug: record.claimedSlug });
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    socket.on('screen:claim', async (payload: { screenId?: string; slug?: string }, ack?: (value: unknown) => void) => {
      try {
        const slug = String(payload?.slug ?? '').toUpperCase();
        await hydrateLobby(slug);
        store.getLobby(slug);
        const screenId = String(payload?.screenId ?? '');
        await hydrateScreen(screenId);
        const record = screens.claim(screenId, slug);
        await saveScreen(record.id);
        ack?.({ ok: true, screen: screens.toPublic(record) });
        io.to(screenRoom(record.id)).emit('screen:claimed', { screenId: record.id, slug });
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    socket.on('screen:claim-status', async (payload: { screenId?: string }, ack?: (value: unknown) => void) => {
      try {
        const screenId = String(payload?.screenId ?? '');
        await hydrateScreen(screenId);
        const record = screens.get(screenId);
        ack?.({
          ok: true,
          screen: record
            ? { ...screens.toPublic(record), expired: false }
            : { id: String(payload?.screenId ?? ''), expiresAt: new Date().toISOString(), claimedSlug: null, expired: true }
        });
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    socket.on('chat:send', async (payload: { slug?: string; playerToken?: string; text?: unknown }, ack?: (value: unknown) => void) => {
      try {
        const slug = String(payload?.slug ?? '').toUpperCase();
        await hydrateLobby(slug);
        const message = store.postChat(slug, String(payload?.playerToken ?? ''), payload?.text);
        await saveLobby(slug);
        ack?.({ ok: true, message });
        io.to(room(slug)).emit('chat:message', message);
        emitLobby(slug);
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    socket.on('disconnect', () => {
      if (!ctx || ctx.role !== 'controller' || !ctx.playerId) return;
      void (async () => {
        const at = Date.now();
        await hydrateLobby(ctx!.slug);
        const lobby = store.markDisconnected(ctx!.slug, ctx!.playerId!, at);
        if (lobby) {
          await saveLobby(ctx!.slug);
          emitLobby(ctx!.slug);
        }
        setTimeout(() => {
          void (async () => {
            await hydrateLobby(ctx!.slug);
            const result = store.removeIfStillDisconnected(ctx!.slug, ctx!.playerId!, at);
            if (!result) return;
            if (result.lobby.players.length) await saveLobby(ctx!.slug);
            else await deleteLobby(ctx!.slug);
            emitLobby(ctx!.slug);
            if (result.gameEvent) io.to(room(ctx!.slug)).emit('game:event', { type: 'snapshot', snapshot: result.gameEvent });
          })();
        }, RECONNECT_GRACE_MS).unref?.();
      })();
    });
  });

  app.post(`${apiPrefix}/screens`, async (_req, res) => {
    try {
      const record = screens.register();
      await saveScreen(record.id);
      res.status(201).json({ screen: screens.toPublic(record) });
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  app.get(`${apiPrefix}/screens/:id`, async (req, res) => {
    await hydrateScreen(req.params.id);
    const record = screens.get(req.params.id);
    if (record) res.json({ screen: { ...screens.toPublic(record), expired: false } });
    else res.json({ screen: { id: req.params.id, expiresAt: new Date().toISOString(), claimedSlug: null, expired: true } });
  });

  app.post(`${apiPrefix}/screens/:id/claim`, async (req, res) => {
    try {
      const slug = String(req.body?.slug ?? '').toUpperCase();
      await hydrateLobby(slug);
      store.getLobby(slug);
      await hydrateScreen(req.params.id);
      const record = screens.claim(req.params.id, slug);
      await saveScreen(req.params.id);
      io.to(screenRoom(req.params.id)).emit('screen:claimed', { screenId: req.params.id, slug });
      res.status(200).json({ screen: screens.toPublic(record) });
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  app.post(`${apiPrefix}/lobbies/:slug/chat`, async (req, res) => {
    try {
      await hydrateLobby(req.params.slug);
      const message = store.postChat(req.params.slug, req.body?.playerToken, req.body?.text);
      await saveLobby(req.params.slug);
      io.to(room(req.params.slug)).emit('chat:message', message);
      res.status(201).json({ message });
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  setInterval(() => {
    store.pruneExpired();
    screens.pruneExpired();
  }, 60_000).unref?.();

  function emitLobby(slug: string): void {
    try {
      io.to(room(slug)).emit('lobby:snapshot', store.publicLobby(slug));
    } catch {
      // Lobby may have expired between socket events.
    }
  }

  // Centralized game-event broadcast: stamp a monotonic seq onto the lobby state,
  // persist it (so it reaches clients on other serverless instances via their poll),
  // and emit the seq'd envelope over the socket (instant for same-instance clients).
  // The client dedupes by seq, so a shot animates exactly once whether it arrives
  // via the socket or the polled snapshot.
  async function dispatchGameEvent(slug: string, event: TrebuchetEvent): Promise<void> {
    const seq = store.recordGameEvent(slug, event);
    await saveLobby(slug);
    io.to(room(slug)).emit('game:event', { seq, event });
    emitLobby(slug);
  }

  async function autoStartIfFull(slug: string): Promise<void> {
    try {
      const lobby = store.publicLobby(slug);
      const manifest = lobby.currentGameId ? resolveManifest(lobby.currentGameId) : null;
      if (!manifest || lobby.state !== 'waiting') return;
      if (lobby.players.length !== manifest.maxPlayers || !lobby.hostPlayerId) return;
      const host = [...store.getLobby(slug).players.values()].find((player) => player.id === lobby.hostPlayerId);
      if (!host) return;
      const event = store.startGame(slug, host.token);
      // External games have no engine event — just persist + broadcast the lobby.
      if (event) {
        await dispatchGameEvent(slug, event);
        armTurnTimer(slug);
      } else {
        await saveLobby(slug);
        emitLobby(slug);
      }
    } catch {
      // Manual start remains available.
    }
  }

  function armTurnTimer(slug: string): void {
    const current = turnTimers.get(slug);
    if (current) clearTimeout(current);
    const lobby = store.publicLobby(slug);
    const snapshot = lobby.gameSession?.snapshot;
    const rawTurnEndsAt = snapshot && typeof snapshot === 'object' && 'turnEndsAt' in snapshot ? snapshot.turnEndsAt : null;
    const turnEndsAt = typeof rawTurnEndsAt === 'number' ? rawTurnEndsAt : null;
    if (!turnEndsAt || lobby.state !== 'playing') return;
    const delay = Math.max(250, turnEndsAt - Date.now());
    const timer = setTimeout(() => {
      void (async () => {
        await hydrateLobby(slug);
        const event = store.skipTurn(slug);
        if (event) {
          await dispatchGameEvent(slug, event);
          armTurnTimer(slug);
        }
      })();
    }, delay);
    timer.unref?.();
    turnTimers.set(slug, timer);
  }

  async function hydrateLobby(slug: string): Promise<void> {
    if (!persistence.enabled) return;
    const normalized = slug.toUpperCase();
    const persisted = await persistence.load(normalized);
    if (persisted) {
      store.lobbies.set(normalized, persisted);
      return;
    }
    store.lobbies.delete(normalized);
  }

  async function saveLobby(slugOrLobby: string | LobbyRecord): Promise<void> {
    if (!persistence.enabled) return;
    const lobby = typeof slugOrLobby === 'string' ? store.getLobby(slugOrLobby) : slugOrLobby;
    await persistence.save(lobby);
  }

  async function deleteLobby(slug: string): Promise<void> {
    if (!persistence.enabled) return;
    await persistence.delete(slug);
  }

  async function hydrateScreen(id: string): Promise<void> {
    if (!persistence.enabled || !id) return;
    const rec = await persistence.loadScreen(id);
    if (rec) screens.hydrate(rec);
    else screens.screens.delete(id);
  }

  async function saveScreen(id: string): Promise<void> {
    if (!persistence.enabled) return;
    const rec = screens.get(id);
    if (rec) await persistence.saveScreen(rec);
  }

  return { app, io, server, store };
}

export function startRealtimeServer(options: RealtimeServerOptions = {}): http.Server {
  const port = Number.parseInt(process.env.PORT ?? '4100', 10);
  const { server } = createRealtimeServer(options);
  server.listen(port, () => {
    console.log(`Couch.gg realtime listening on http://localhost:${port}`);
  });
  return server;
}

function room(slug: string): string {
  return `lobby:${slug}`;
}

function screenRoom(id: string): string {
  return 'screen:' + id;
}

function socketError(err: unknown): { ok: false; error: string; status: number } {
  if (err instanceof LobbyError) return { ok: false, error: err.message, status: err.status };
  return { ok: false, error: err instanceof Error ? err.message : 'Unbekannter Fehler', status: 500 };
}

// Resolve a player id from a controller token for rate-limit keying. Returns null
// for an unknown token; recordGameInput is the authoritative check (throws 401).
function derivePlayerId(lobby: LobbyRecord, token: string): PlayerId | null {
  for (const player of lobby.players.values()) {
    if (player.token === token) return player.id;
  }
  return null;
}

function isTrebuchetPreviewControl(control: string): boolean {
  return control === 'aim' || control === 'trebuchet.aim' || control === 'charge' || control === 'trebuchet.charge';
}

function canonicalTrebuchetControl(control: string): string {
  if (control === 'aim') return 'trebuchet.aim';
  if (control === 'charge') return 'trebuchet.charge';
  return control;
}

function sendHttpError(res: express.Response, err: unknown): void {
  const error = socketError(err);
  res.status(error.status).json(error);
}

function normalizeApiPrefix(prefix: string): string {
  const withSlash = prefix.startsWith('/') ? prefix : `/${prefix}`;
  return withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
}

if (isDirectRun()) startRealtimeServer();
