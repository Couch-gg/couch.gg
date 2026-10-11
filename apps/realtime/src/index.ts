import http from 'node:http';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { Server, type ServerOptions } from 'socket.io';
import { GAME_MANIFESTS } from '@couch/game-runtime';
import type { TrebuchetEvent } from '@couch/trebuchet';
import type { ControllerEvent, ControllerPatch, GameId, GameManifest, PlayerId, ScreenId } from '@couch/types';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  LobbyError,
  LobbyStore,
  RECONNECT_GRACE_MS,
  hostScreenId,
  turnEndsAtOf,
  type LobbyRecord,
  type ManifestResolver,
  type PlayerRemoval
} from './lobbies.js';
import { mergeCatalog, parseExternalGamesJson } from './external-games.js';
import { RateLimiter } from './rate-limit.js';
import { createProductionGamePersistence, createProductionLobbyPersistence } from './persistence.js';
import { GamesRegistry, RegistryError, adminGameView, publicGame } from './games-registry.js';
import { ScreenRegistry } from './screens.js';

// Per-key token bucket for report throttling: capacity 5, refill 5 tokens/hour.
// Same shape as RateLimiter but with report-specific constants; kept local so
// rate-limit.ts (input-relay tuned) stays untouched. Keyed `report:<ip>`.
const REPORT_CAPACITY = 5;
const REPORT_REFILL_PER_MS = 5 / 3_600_000; // 5 per 3600s
const REPORT_IDLE_PRUNE_MS = 3_600_000;
// Largest host-authoritative state broadcast (serialized), see game:state.
const MAX_STATE_BYTES = 32_768;
// How long a socket's "is this the host screen" verdict is trusted.
const HOST_CHECK_TTL_MS = 2_000;
// Longest accepted broadcast epoch (a per-mount random id from the host TV).
const MAX_EPOCH_CHARS = 32;
// How long a TV whose socket dropped may take to come back before it is
// dropped from lobby.screens (a reload or a blip rejoins well within this).
const SCREEN_GRACE_MS = 10_000;
// How long a phone whose socket dropped may take to come back before it shows
// as gone. The platform closes long-lived connections every few minutes and
// the phone is back within a second or two: nobody needs to hear about that.
const DISCONNECT_QUIET_MS = 5_000;

class ReportRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private lastPrune = 0;

  allow(key: string, now = Date.now()): boolean {
    this.pruneIdle(now);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: REPORT_CAPACITY, lastRefill: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = now - bucket.lastRefill;
    if (elapsed > 0) {
      bucket.tokens = Math.min(REPORT_CAPACITY, bucket.tokens + elapsed * REPORT_REFILL_PER_MS);
      bucket.lastRefill = now;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private pruneIdle(now: number): void {
    if (now - this.lastPrune < REPORT_IDLE_PRUNE_MS) return;
    this.lastPrune = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > REPORT_IDLE_PRUNE_MS) this.buckets.delete(key);
    }
  }
}

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
  /** Override SCREEN_GRACE_MS (tests). */
  screenGraceMs?: number;
  /** Override DISCONNECT_QUIET_MS (tests). */
  disconnectQuietMs?: number;
  /** Override RECONNECT_GRACE_MS (tests). */
  reconnectGraceMs?: number;
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
  const screenGraceMs = options.screenGraceMs ?? SCREEN_GRACE_MS;
  const disconnectQuietMs = options.disconnectQuietMs ?? DISCONNECT_QUIET_MS;
  const reconnectGraceMs = options.reconnectGraceMs ?? RECONNECT_GRACE_MS;
  // Env-registered external games (ops escape hatch before the durable registry).
  // Parsed once at startup; localhost http is allowed only off Vercel (local dev).
  const externalGames = parseExternalGamesJson(process.env.EXTERNAL_GAMES_JSON, {
    allowHttpLocalhost: !process.env.VERCEL
  });
  const externalById = new Map<GameId, GameManifest>(externalGames.map((game) => [game.id, game]));

  // Durable published-games registry (Redis / in-memory / disabled). The manifest
  // resolver and catalog both consult its in-memory cache synchronously; REST and
  // async socket handlers await ensureFresh() first so the cache reflects writes
  // from other serverless instances within the 30s window.
  const gamesPersistence = createProductionGamePersistence();
  const registry = new GamesRegistry(gamesPersistence);

  // Resolver the store uses instead of the throwing getGameManifest: built-ins
  // first, then env-registered externals, then the durable registry (sync cache
  // read) so selecting/starting a registry game resolves end-to-end.
  const resolveManifest: ManifestResolver = (id) =>
    GAME_MANIFESTS.find((game) => game.id === id) ?? externalById.get(id) ?? registry.resolveById(id) ?? null;

  // Merged catalog served everywhere the built-in list used to be: built-ins +
  // env-registered externals + published registry games (public slice from the
  // cache). Keep it sync — callers await ensureFresh() before hitting it.
  const catalog = (): GameManifest[] => mergeCatalog([...externalGames, ...registry.listPublic()]);

  const store = new LobbyStore(resolveManifest);
  const screens = new ScreenRegistry();
  const persistence = createProductionLobbyPersistence();
  const turnTimers = new Map<string, NodeJS.Timeout>();
  const inputLimiter = new RateLimiter();
  // Separate budget for game -> phone controller updates, keyed per lobby.
  const controllerLimiter = new RateLimiter();
  // Host-authoritative state broadcasts: ~30/s sustained per lobby (a 30 Hz
  // snapshot loop), bursts to 60.
  const stateLimiter = new RateLimiter({ playerCapacity: 60, playerRefillPerSec: 30, slugCapacity: 60, slugRefillPerSec: 30 });
  // Per-IP report throttle: 5 reports/hour. Same token-bucket shape as the input
  // limiter but with report-specific capacity/refill, keyed `report:<ip>`.
  const reportLimiter = new ReportRateLimiter();

  const app = express();
  app.use(cors({ origin: clientOrigin }));
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, lobbies: store.lobbies.size });
  });

  app.get(`${apiPrefix}/health`, (_req, res) => {
    res.json({ ok: true, lobbies: store.lobbies.size });
  });

  app.get(`${apiPrefix}/games`, async (_req, res) => {
    try {
      await registry.ensureFresh();
      res.json({ games: catalog() });
    } catch (err) {
      sendHttpError(res, err);
    }
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
      // Every TV and phone polls this, so a TV that left is dropped, and a
      // phone that dropped shows as gone, even when the instance that saw the
      // socket go is gone before its timer fires.
      await settlePresence(req.params.slug.toUpperCase());
      res.json({ lobby: store.publicLobby(req.params.slug) });
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  app.post(`${apiPrefix}/lobbies/:slug/players`, async (req, res) => {
    try {
      await hydrateLobby(req.params.slug);
      const joined = store.joinPlayer(req.params.slug, req.body?.name, req.body?.playerToken, req.body?.screenId);
      await saveLobby(req.params.slug);
      res.status(201).json(joined);
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  // The phone's Leave when its socket is down or doesn't answer (see
  // controller:leave). Body { playerToken }.
  app.post(`${apiPrefix}/lobbies/:slug/leave`, async (req, res) => {
    try {
      const slug = req.params.slug.toUpperCase();
      await hydrateLobby(slug);
      const removal = store.leavePlayer(slug, String(req.body?.playerToken ?? ''));
      await playerRemoved(slug, removal);
      res.json({ ok: true });
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  // --- Published-games registry REST ----------------------------------------

  // Submit → auto-publish after automated checks. Body { manifest, attestation? }.
  // Registry disabled (Vercel without Redis) → 503. The managementToken is
  // returned exactly once here; it is never persisted or exposed again.
  app.post(`${apiPrefix}/games`, async (req, res) => {
    try {
      if (!registry.enabled) {
        res.status(503).json({ error: 'publishing unavailable' });
        return;
      }
      await registry.ensureFresh();
      const attestation = req.body?.attestation as { handshakeOk?: boolean } | undefined;
      // Reserve every id already claimed by a built-in or env-registered game so
      // a submit can never shadow them (the registry also checks its own records).
      const reservedIds = [...GAME_MANIFESTS.map((game) => game.id), ...externalById.keys()];
      const { record, managementToken } = await registry.submit(req.body?.manifest, {
        reservedIds,
        handshakeOk: attestation?.handshakeOk === true
      });
      res.status(201).json({ game: publicGame(record), managementToken });
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  // Self-service update by management token. Body { manifest } re-validated.
  app.patch(`${apiPrefix}/games/:id`, async (req, res) => {
    try {
      await registry.ensureFresh();
      const token = String(req.header('x-management-token') ?? '');
      const record = await registry.update(req.params.id, token, req.body?.manifest);
      res.json({ game: publicGame(record) });
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  // Self-service delete by management token.
  app.delete(`${apiPrefix}/games/:id`, async (req, res) => {
    try {
      await registry.ensureFresh();
      const token = String(req.header('x-management-token') ?? '');
      await registry.remove(req.params.id, token);
      res.status(204).end();
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  // Community report. Per-IP throttled; at 3 reports the game auto-hides.
  app.post(`${apiPrefix}/games/:id/report`, async (req, res) => {
    try {
      await registry.ensureFresh();
      const ip = clientIp(req);
      if (!reportLimiter.allow(`report:${ip}`)) {
        res.status(429).json({ error: 'too many reports' });
        return;
      }
      const record = await registry.report(req.params.id);
      res.json({ ok: true, hidden: record.hidden });
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  // First-load probe result from a real TV. Only counts if a live lobby with the
  // given slug is currently playing this game — otherwise 202-ignored, which
  // prevents drive-by probe spoofing of an arbitrary game's health.
  app.post(`${apiPrefix}/games/:id/probe-result`, async (req, res) => {
    try {
      await registry.ensureFresh();
      const slug = String(req.body?.slug ?? '').toUpperCase();
      const ok = req.body?.ok === true;
      if (!isLiveLobbyPlaying(slug, req.params.id)) {
        res.status(202).json({ ok: true, counted: false });
        return;
      }
      const record = await registry.probeResult(req.params.id, ok);
      res.json({ ok: true, counted: true, status: record.probe.status });
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  // --- Admin surface (x-admin-key, timing-safe) -----------------------------

  app.get(`${apiPrefix}/admin/games`, async (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      await registry.ensureFresh();
      res.json({ games: registry.listAll().map(adminGameView) });
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  app.post(`${apiPrefix}/admin/games/:id/takedown`, async (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      await registry.ensureFresh();
      const record = await registry.setHidden(req.params.id, true);
      res.json({ game: adminGameView(record) });
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  app.post(`${apiPrefix}/admin/games/:id/restore`, async (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      await registry.ensureFresh();
      const record = await registry.setHidden(req.params.id, false);
      res.json({ game: adminGameView(record) });
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  app.post(`${apiPrefix}/admin/games/:id/feature`, async (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      await registry.ensureFresh();
      const featured = req.body?.featured === true;
      const record = await registry.setFeatured(req.params.id, featured);
      res.json({ game: adminGameView(record) });
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
    // Cached game:state host verdict, see game:state. Reset on every screen:join.
    let hostCheck: { slug: string; ok: boolean; at: number } | null = null;
    // Whether this socket is the shell of the lobby's host screen (the lobby
    // must already be hydrated). With no screen listed (every TV was dropped,
    // or the TVs still run a bundle that joins without a screen id) any
    // screen of the lobby is the host, as in the TV's own screenRole; else
    // the round could never end. Uncached: for rare events, not game:state.
    const isHostScreen = (slug: string): boolean => {
      if (!ctx || ctx.role !== 'screen' || ctx.slug !== slug) return false;
      const host = hostScreenId(store.getLobby(slug));
      return host === null || (!!ctx.screenId && host === ctx.screenId);
    };
    // Controls this socket has pressed/moved (relayed) and not yet released,
    // keyed `${slug}:${playerId}:${control}`. Only these releases skip the limiter.
    const held = new Set<string>();
    // The screen:join still running on this socket, if any. A reconnected TV
    // sends it right before what it held back (a game:finish), and that must
    // not be refused as coming from a socket that hasn't joined yet.
    let screenJoining: Promise<void> | null = null;

    socket.on('screen:join', (payload: { slug?: string; screenId?: string; screenToken?: string }, ack?: (value: unknown) => void) => {
      const joining = (async () => {
        try {
          const slug = String(payload?.slug ?? '').toUpperCase();
          await hydrateLobby(slug);
          await registry.ensureFresh();
          // A known screen id must bring the token its first join was given; a
          // new one gets its token here, in this ack only.
          const joined = store.joinScreen(slug, payload?.screenId, payload?.screenToken, socket.id);
          if (joined.changed) {
            await saveLobby(slug);
            emitLobby(slug);
          }
          const lobby = store.publicLobby(slug);
          const screenId = joined.screenId ?? undefined;
          ctx = { role: 'screen', slug, screenId };
          hostCheck = null;
          socket.join([room(slug), screensRoom(slug)]);
          ack?.({ ok: true, lobby, games: catalog(), ...(joined.screenToken ? { screenToken: joined.screenToken } : {}) });
          socket.emit('lobby:snapshot', lobby);
        } catch (err) {
          ack?.(socketError(err));
        }
      })();
      screenJoining = joining;
      void joining.finally(() => {
        if (screenJoining === joining) screenJoining = null;
      });
    });

    socket.on('controller:join', async (payload: { slug?: string; name?: string; playerToken?: string; screenId?: string }, ack?: (value: unknown) => void) => {
      try {
        const slug = String(payload?.slug ?? '').toUpperCase();
        await hydrateLobby(slug);
        await registry.ensureFresh();
        // A join without a token from a socket that already joined this lobby
        // is a retry (its first ack timed out): it is the same player, not a
        // second one that would keep the host role forever.
        const token =
          payload?.playerToken ||
          (ctx?.role === 'controller' && ctx.slug === slug && ctx.playerId ? store.tokenOf(slug, ctx.playerId) : undefined);
        const joined = store.joinPlayer(slug, payload?.name, token, payload?.screenId, socket.id);
        await saveLobby(slug);
        ctx = { role: 'controller', slug, playerId: joined.player.id };
        socket.join([room(slug), playerRoom(slug, joined.player.id)]);
        ack?.({ ok: true, ...joined, games: catalog() });
        emitLobby(slug);
        await autoStartIfFull(slug);
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    // The phone's Leave button. The player is gone for good, so this socket's
    // disconnect that follows changes nothing. The phone waits for the ack
    // before it closes the socket: a leave that arrives together with the
    // disconnect is never run (Socket.IO drops events of a closed socket).
    socket.on('controller:leave', async (payload: { slug?: string; playerToken?: string }, ack?: (value: unknown) => void) => {
      try {
        const slug = String(payload?.slug ?? '').toUpperCase();
        await hydrateLobby(slug);
        const removal = store.leavePlayer(slug, String(payload?.playerToken ?? ''));
        if (ctx?.role === 'controller' && ctx.slug === slug) ctx = null;
        await playerRemoved(slug, removal);
        ack?.({ ok: true });
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
        await registry.ensureFresh();
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
        await registry.ensureFresh();
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
          // A release of a control this socket holds is never rate-limited: a
          // dropped release leaves a button (or stick) held on the screen and
          // the character keeps running. Only the first release after a relayed
          // press/change is exempt, so releases alone can't flood the relay.
          const isRelease = (controllerEvent.value as { action?: unknown } | undefined)?.action === 'release';
          const heldKey = `${slug}:${derivedId}:${String(controllerEvent.control)}`;
          const exempt = isRelease && held.delete(heldKey);
          if (derivedId && !exempt && !inputLimiter.allow(slug, derivedId)) {
            // Rate-limited drops are not errors — acking success keeps the
            // controller stream healthy; the input is simply not relayed.
            ack?.({ ok: true, dropped: true });
            return;
          }
          const envelope = store.recordGameInput(slug, playerToken, controllerEvent);
          if (derivedId && !isRelease) held.add(heldKey);
          ack?.({ ok: true, seq: envelope.seq });
          await saveLobby(slug);
          // Only screens run games; phones never read inputs.
          io.to(screensRoom(slug)).emit('game:input', envelope);
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

    // The host ends the running game from their phone, for when it never ends
    // by itself (a game that hangs, a finish report that got lost).
    socket.on('game:end', async (payload: { slug?: string; playerToken?: string }, ack?: (value: unknown) => void) => {
      try {
        const slug = String(payload?.slug ?? '').toUpperCase();
        await hydrateLobby(slug);
        const lobby = store.endGame(slug, String(payload?.playerToken ?? ''));
        await saveLobby(slug);
        ack?.({ ok: true, lobby });
        emitLobby(slug);
        armTurnTimer(slug);
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    // An external game reports its final scores. Accepted ONLY from the trusted
    // shell (the iframe can't reach the socket) of the lobby's host screen.
    // Idempotent: a duplicate report, or one for a round that is over, acks
    // { ok:true, finished:false }.
    socket.on('game:finish', async (payload: { slug?: string; sessionId?: unknown; scores?: unknown }, ack?: (value: unknown) => void) => {
      try {
        const slug = String(payload?.slug ?? '').toUpperCase();
        if (screenJoining) await screenJoining;
        if (!ctx || ctx.role !== 'screen' || ctx.slug !== slug) {
          throw new LobbyError('Nur der Screen kann das Spiel beenden', 403);
        }
        await hydrateLobby(slug);
        if (!isHostScreen(slug)) throw new LobbyError('Nur der Host-Screen kann das Spiel beenden', 403);
        const finished = store.finishExternalGame(slug, payload?.scores, payload?.sessionId);
        ack?.({ ok: true, finished });
        if (finished) {
          await saveLobby(slug);
          emitLobby(slug);
        }
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    // The running game tells one player's phone what to show (labels, disabled
    // controls, cooldowns, a vibration). Like game:finish this comes only from
    // the trusted screen shell, never from the iframe or a phone. In a remote
    // couch every screen may run the game, so only the host screen's calls are
    // applied; the others are acked as ignored, so each patch lands once.
    socket.on('screen:controller', async (payload: { slug?: string; playerId?: string; patch?: unknown }, ack?: (value: unknown) => void) => {
      try {
        const slug = String(payload?.slug ?? '').toUpperCase();
        if (screenJoining) await screenJoining;
        if (!ctx || ctx.role !== 'screen' || ctx.slug !== slug) {
          throw new LobbyError('Nur der Screen kann Controller steuern', 403);
        }
        await hydrateLobby(slug);
        if (!isHostScreen(slug)) {
          ack?.({ ok: true, ignored: true });
          return;
        }
        if (!controllerLimiter.allow(slug, 'screen')) {
          ack?.({ ok: true, dropped: true });
          return;
        }
        const playerId = String(payload?.playerId ?? '');
        const state = store.setControllerState(slug, playerId, payload?.patch as ControllerPatch);
        ack?.({ ok: true, state });
        await saveLobby(slug);
        io.to(playerRoom(slug, playerId)).emit('controller:state', { playerId, state });
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    // Host-authoritative mode: the host screen's game broadcasts its state and
    // every other screen renders it. Ephemeral (never persisted): a screen that
    // joins late simply picks up the next broadcast. The host verdict is cached
    // per socket (hostCheck) and re-read from persistence every
    // HOST_CHECK_TTL_MS, so a 30 Hz loop doesn't hit Redis on every frame but
    // still notices when the host player moves to another screen (possibly via
    // another instance). `epoch` changes whenever the host's game is mounted
    // anew (reload, new host), and receivers restart their seq check with it.
    socket.on('game:state', async (payload: { slug?: string; epoch?: unknown; seq?: unknown; state?: unknown }, ack?: (value: unknown) => void) => {
      try {
        const slug = String(payload?.slug ?? '').toUpperCase();
        if (!ctx || ctx.role !== 'screen' || ctx.slug !== slug) {
          throw new LobbyError('Nur ein Screen kann Spielzustand senden', 403);
        }
        const now = Date.now();
        if (!hostCheck || hostCheck.slug !== slug || now - hostCheck.at > HOST_CHECK_TTL_MS) {
          await hydrateLobby(slug);
          const lobby = store.getLobby(slug);
          hostCheck = { slug, ok: !!ctx.screenId && hostScreenId(lobby) === ctx.screenId, at: now };
        }
        if (!hostCheck.ok) {
          throw new LobbyError('Nur der Host-Screen sendet den Spielzustand', 403);
        }
        if (typeof payload?.seq !== 'number') throw new LobbyError('seq fehlt');
        const epoch = payload.epoch ?? '';
        if (typeof epoch !== 'string' || epoch.length > MAX_EPOCH_CHARS) throw new LobbyError('epoch ungültig');
        const encoded = JSON.stringify(payload?.state ?? null);
        if (encoded.length > MAX_STATE_BYTES) throw new LobbyError('Spielzustand zu groß', 413);
        if (!stateLimiter.allow(slug, 'host')) {
          ack?.({ ok: true, dropped: true });
          return;
        }
        ack?.({ ok: true });
        socket.to(screensRoom(slug)).emit('game:state', { epoch, seq: payload.seq, at: Date.now(), state: payload.state ?? null });
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
      if (ctx?.role === 'screen' && ctx.screenId) {
        void screenLeft(ctx.slug, ctx.screenId, socket.id);
        return;
      }
      if (!ctx || ctx.role !== 'controller' || !ctx.playerId) return;
      void controllerDropped(ctx.slug, ctx.playerId, socket.id);
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
    try {
      await hydrateScreen(req.params.id);
      const record = screens.get(req.params.id);
      if (record) res.json({ screen: { ...screens.toPublic(record), expired: false } });
      else res.json({ screen: { id: req.params.id, expiresAt: new Date().toISOString(), claimedSlug: null, expired: true } });
    } catch (err) {
      sendHttpError(res, err);
    }
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

  // A phone's socket dropped. The drop goes into the lobby record quietly (no
  // activity, nobody told): the phone is usually back within a second or
  // two. If it isn't back after disconnectQuietMs, the next poll of the lobby
  // (on any instance) shows it as gone; this instance's timer is only the
  // fast path. See settlePresence.
  async function controllerDropped(slug: string, playerId: PlayerId, socketId: string): Promise<void> {
    try {
      await hydrateLobby(slug);
      if (!store.noteDropped(slug, playerId, socketId, Date.now())) return;
      await saveLobby(slug);
    } catch (err) {
      logUnlessGone('Disconnect failed', slug, err);
      return;
    }
    // A little past the quiet window, so the drop is surely old enough by then.
    setTimeout(() => {
      void (async () => {
        try {
          await hydrateLobby(slug);
          await settlePresence(slug);
        } catch (err) {
          logUnlessGone('Disconnect failed', slug, err);
        }
      })();
    }, disconnectQuietMs + 100).unref?.();
  }

  async function removeIfGone(slug: string, playerId: PlayerId, since: number): Promise<void> {
    try {
      await hydrateLobby(slug);
      const removal = store.removeIfStillDisconnected(slug, playerId, since);
      if (removal) await playerRemoved(slug, removal);
    } catch (err) {
      logUnlessGone('Removing a player failed', slug, err);
    }
  }

  // Save and announce a lobby a player was just taken out of. Their unit may
  // have held the turn, so the turn timer follows the new turn.
  async function playerRemoved(slug: string, removal: PlayerRemoval): Promise<void> {
    await saveLobby(slug);
    emitLobby(slug);
    if (removal.gameEvent) io.to(room(slug)).emit('game:event', { type: 'snapshot', snapshot: removal.gameEvent });
    armTurnTimer(slug);
  }

  // A TV whose socket dropped gets screenGraceMs to come back (a reload or a
  // network blip rejoins with the same screen id, maybe on another instance).
  // The drop is noted in the lobby record, not in this instance's memory: a
  // join of that screen anywhere clears it, and once the grace has passed
  // without one the TV is gone and leaves lobby.screens, so the host screen
  // moves to a live one.
  async function screenLeft(slug: string, screenId: string, socketId: string): Promise<void> {
    try {
      await hydrateLobby(slug);
      if (!store.markScreenLeft(slug, screenId, socketId, Date.now())) return;
      await saveLobby(slug);
    } catch {
      return; // The lobby expired meanwhile.
    }
    // A little past the grace, so the mark is surely old enough by then.
    setTimeout(() => {
      void (async () => {
        try {
          await hydrateLobby(slug);
          await settlePresence(slug);
        } catch {
          // The lobby expired meanwhile.
        }
      })();
    }, screenGraceMs + 100).unref?.();
  }

  // Act on drops the lobby record holds (the lobby must already be hydrated):
  // screens that left more than screenGraceMs ago are dropped, phones that
  // dropped more than disconnectQuietMs ago show as gone (and are removed
  // after reconnectGraceMs more). Tells everyone when something changed.
  async function settlePresence(slug: string): Promise<void> {
    const now = Date.now();
    const screensDropped = store.dropGoneScreens(slug, now, screenGraceMs);
    const gone = store.markDroppedGone(slug, now, disconnectQuietMs);
    if (!screensDropped && gone.length === 0) return;
    await saveLobby(slug);
    emitLobby(slug);
    for (const { playerId, since } of gone) {
      const delay = Math.max(0, since + reconnectGraceMs - Date.now());
      setTimeout(() => void removeIfGone(slug, playerId, since), delay).unref?.();
    }
  }

  function emitLobby(slug: string): void {
    try {
      io.to(room(slug)).emit('lobby:snapshot', store.publicLobby(slug));
    } catch {
      // Lobby may have expired between socket events.
    }
  }

  // True when a non-expired lobby with this slug is currently playing gameId.
  // Gates probe-result so a report only counts against a game someone is actually
  // running — a drive-by POST for an idle game is ignored.
  function isLiveLobbyPlaying(slug: string, gameId: string): boolean {
    if (!slug) return false;
    try {
      const lobby = store.getLobby(slug);
      return lobby.state === 'playing' && lobby.currentGameId === gameId;
    } catch {
      return false;
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

  // Skip the current Trebuchet turn when it runs out. The timer only knows
  // the turn it was armed for: when it fires, the stored lobby decides (a shot
  // or a skip on another instance moves the turn on without telling this one).
  function armTurnTimer(slug: string): void {
    const current = turnTimers.get(slug);
    if (current) clearTimeout(current);
    turnTimers.delete(slug);
    const lobby = store.lobbies.get(slug.toUpperCase());
    const turnEndsAt = lobby ? turnEndsAtOf(lobby) : null;
    if (!turnEndsAt) return;
    const delay = Math.max(250, turnEndsAt - Date.now());
    const timer = setTimeout(() => {
      if (turnTimers.get(slug) === timer) turnTimers.delete(slug);
      void (async () => {
        await hydrateLobby(slug);
        const event = store.skipTurn(slug, turnEndsAt);
        if (event) {
          await dispatchGameEvent(slug, event);
          armTurnTimer(slug);
          return;
        }
        // The turn moved on meanwhile (watch the new one), or this fired a
        // little early. Otherwise the game is over.
        const stored = store.lobbies.get(slug.toUpperCase());
        const latest = stored ? turnEndsAtOf(stored) : null;
        if (latest !== null && (latest !== turnEndsAt || latest > Date.now())) armTurnTimer(slug);
      })().catch((err) => logUnlessGone('Turn timer failed', slug, err));
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

  // Every change to a lobby goes through here, so this is also where it is
  // kept alive (see LobbyStore.keepAlive).
  async function saveLobby(slugOrLobby: string | LobbyRecord): Promise<void> {
    const lobby = typeof slugOrLobby === 'string' ? store.getLobby(slugOrLobby) : slugOrLobby;
    store.keepAlive(lobby);
    if (!persistence.enabled) return;
    await persistence.save(lobby);
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

// A promise nobody awaits must never take the process down: every socket on
// the instance (other parties' too) and all its timers would go with it. The
// handlers catch what they expect; this logs whatever slips through.
let rejectionsGuarded = false;
export function guardUnhandledRejections(): void {
  if (rejectionsGuarded) return;
  rejectionsGuarded = true;
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection', reason);
  });
}

export function startRealtimeServer(options: RealtimeServerOptions = {}): http.Server {
  guardUnhandledRejections();
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

// The lobby's screens only: game:state and game:input never go to phones.
function screensRoom(slug: string): string {
  return `screens:${slug}`;
}

// One player's phone(s), for controller:state.
function playerRoom(slug: string, playerId: string): string {
  return `player:${slug}:${playerId}`;
}

function screenRoom(id: string): string {
  return 'screen:' + id;
}

function socketError(err: unknown): { ok: false; error: string; status: number; errors?: string[] } {
  if (err instanceof RegistryError) {
    return { ok: false, error: err.message, status: err.status, ...(err.errors ? { errors: err.errors } : {}) };
  }
  if (err instanceof LobbyError) return { ok: false, error: err.message, status: err.status };
  return { ok: false, error: err instanceof Error ? err.message : 'Unbekannter Fehler', status: 500 };
}

// Verify the x-admin-key header against ADMIN_KEY (constant-time). Returns false
// and writes the response when the key is unset (503) or wrong (401); the caller
// short-circuits on false.
function requireAdmin(req: express.Request, res: express.Response): boolean {
  const configured = process.env.ADMIN_KEY;
  if (!configured) {
    res.status(503).json({ error: 'admin surface unavailable' });
    return false;
  }
  const provided = String(req.header('x-admin-key') ?? '');
  if (!timingSafeEqualStr(provided, configured)) {
    res.status(401).json({ error: 'invalid admin key' });
    return false;
  }
  return true;
}

// Constant-time string comparison via fixed-length sha256 digests, so the
// comparison never leaks length or content through timing and never throws on a
// length mismatch (timingSafeEqual requires equal-length buffers).
function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Best-effort client IP for per-IP report throttling. Prefers the leftmost
// X-Forwarded-For hop (Vercel/edge proxies), falling back to the socket address.
function clientIp(req: express.Request): string {
  const forwarded = req.header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
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

// Log a failure of background work (timers, disconnect handling), except the
// lobby having expired or gone meanwhile, which is expected.
function logUnlessGone(what: string, slug: string, err: unknown): void {
  if (err instanceof LobbyError && (err.status === 404 || err.status === 410)) return;
  console.error(what, slug, err);
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
