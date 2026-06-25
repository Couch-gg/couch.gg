import http from 'node:http';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { Server, type ServerOptions } from 'socket.io';
import { GAME_MANIFESTS } from '@couch/game-runtime';
import type { ControllerEvent, GameId, PlayerId, ScreenId } from '@couch/types';
import { LobbyError, LobbyStore, RECONNECT_GRACE_MS, type LobbyRecord } from './lobbies.js';
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
  const store = new LobbyStore();
  const screens = new ScreenRegistry();
  const persistence = createProductionLobbyPersistence();
  const turnTimers = new Map<string, NodeJS.Timeout>();

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
    res.json({ games: GAME_MANIFESTS });
  });

  app.post(`${apiPrefix}/lobbies`, async (_req, res) => {
    try {
      const lobby = store.createLobby();
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
        ack?.({ ok: true, lobby, games: GAME_MANIFESTS });
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
        ack?.({ ok: true, ...joined, games: GAME_MANIFESTS });
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
        await saveLobby(slug);
        ack?.({ ok: true, event });
        io.to(room(slug)).emit('game:event', event);
        emitLobby(slug);
        armTurnTimer(slug);
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
          await saveLobby(slug);
          io.to(room(slug)).emit('game:event', event);
          emitLobby(slug);
          armTurnTimer(slug);
        }
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    socket.on('screen:register', (payload: { screenId?: string }, ack?: (value: unknown) => void) => {
      try {
        const record = screens.registerOrReuse(payload?.screenId);
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
        const record = screens.claim(String(payload?.screenId ?? ''), slug);
        ack?.({ ok: true, screen: screens.toPublic(record) });
        io.to(screenRoom(record.id)).emit('screen:claimed', { screenId: record.id, slug });
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    socket.on('screen:claim-status', (payload: { screenId?: string }, ack?: (value: unknown) => void) => {
      try {
        const record = screens.get(String(payload?.screenId ?? ''));
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

  app.post(`${apiPrefix}/screens`, (_req, res) => {
    try {
      const record = screens.register();
      res.status(201).json({ screen: screens.toPublic(record) });
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  app.get(`${apiPrefix}/screens/:id`, (req, res) => {
    const record = screens.get(req.params.id);
    if (record) res.json({ screen: { ...screens.toPublic(record), expired: false } });
    else res.json({ screen: { id: req.params.id, expiresAt: new Date().toISOString(), claimedSlug: null, expired: true } });
  });

  app.post(`${apiPrefix}/screens/:id/claim`, async (req, res) => {
    try {
      const slug = String(req.body?.slug ?? '').toUpperCase();
      await hydrateLobby(slug);
      store.getLobby(slug);
      const record = screens.claim(req.params.id, slug);
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

  async function autoStartIfFull(slug: string): Promise<void> {
    try {
      const lobby = store.publicLobby(slug);
      const manifest = GAME_MANIFESTS.find((game) => game.id === lobby.currentGameId);
      if (!manifest || lobby.state !== 'waiting') return;
      if (lobby.players.length !== manifest.maxPlayers || !lobby.hostPlayerId) return;
      const host = [...store.getLobby(slug).players.values()].find((player) => player.id === lobby.hostPlayerId);
      if (!host) return;
      const event = store.startGame(slug, host.token);
      await saveLobby(slug);
      io.to(room(slug)).emit('game:event', event);
      emitLobby(slug);
      armTurnTimer(slug);
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
          await saveLobby(slug);
          io.to(room(slug)).emit('game:event', event);
          emitLobby(slug);
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
