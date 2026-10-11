import { Copy, MessageSquare, Plus, RotateCcw, Smartphone, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExternalGameManifest, GameManifest, Lobby } from '@couch/types';
import type { Socket } from 'socket.io-client';
import type { TrebuchetEvent, TrebuchetSnapshot } from '@couch/trebuchet';
import { createLobby, fetchGames, fetchLobby } from '../api.js';
import { isOlderLobby } from '../lobbySync.js';
import { createSocket, emitAck } from '../socket.js';
import { ChatPanel } from '../components/ChatPanel.js';
import { GameCatalog } from '../components/GameCatalog.js';
import { GameHostStage, type GameHostStageHandle } from '../components/GameHostStage.js';
import { PlayerRoster } from '../components/PlayerRoster.js';
import { QrPanel } from '../components/QrPanel.js';
import { TrebuchetStage, type TrebuchetControlEvent } from '../components/TrebuchetStage.js';
import { useExternalGameInputs } from '../hooks/useExternalGameInputs.js';

// The audio engine lives in public/ (served at /js/sfx.js), not in src/, so it must be loaded via a
// runtime dynamic import rather than a static one. We wrap import() in `new Function` so Vite leaves
// the specifier untouched (the same approach TrebuchetStage uses for its public modules). The module
// is a shared singleton — the Phaser game imports the same URL — so muting here also mutes gameplay.
interface SfxModule {
  musicScene: (scene: 'menu' | 'game' | 'none') => void;
  toggleMute: () => boolean;
  isMuted: () => boolean;
  setMuted: (muted: boolean) => void;
}

let sfxPromise: Promise<SfxModule | null> | null = null;

// How long an external game's winner screen stays up after the lobby ends.
const GAME_OVER_LINGER_MS = 5_000;
// How often a TV the server doesn't list (anymore) may ask to join again.
const REJOIN_INTERVAL_MS = 3_000;
// How often to fetch the catalog again while the lobby's game isn't in it.
const CATALOG_RETRY_MS = 5_000;
const SCREENS_FULL_NOTICE = 'Diese Lobby hat schon genug Screens. Dieser Screen schaut nur zu, bis einer frei wird.';

const SCREEN_ID_KEY = 'couch:screenId';

function newScreenId(): string {
  return `scr_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}

// This TV's screen id: the one the attract screen registered (and phones scanned),
// or a fresh one for a TV that opened the lobby URL directly. Games use it to
// tell which players sit here and which screen is the host.
function ownScreenId(): string {
  try {
    const existing = window.sessionStorage.getItem(SCREEN_ID_KEY);
    if (existing) return existing;
    const created = newScreenId();
    window.sessionStorage.setItem(SCREEN_ID_KEY, created);
    return created;
  } catch {
    return newScreenId();
  }
}

// The secret the server handed this TV on its first screen:join, proving on
// every rejoin (reload, reconnect) that the screen id is really ours. Kept for
// the tab like the screen id itself; memory is the fallback without storage.
const screenTokens = new Map<string, string>();

function screenTokenKey(slug: string, screenId: string): string {
  return `couch:screenToken:${slug}:${screenId}`;
}

function readScreenToken(slug: string, screenId: string): string | undefined {
  const key = screenTokenKey(slug, screenId);
  try {
    return window.sessionStorage.getItem(key) ?? screenTokens.get(key);
  } catch {
    return screenTokens.get(key);
  }
}

function keepScreenToken(slug: string, screenId: string, token: string): void {
  const key = screenTokenKey(slug, screenId);
  screenTokens.set(key, token);
  try {
    window.sessionStorage.setItem(key, token);
  } catch {
    // The in-memory copy covers this page's lifetime.
  }
}

// Give up a screen id the server says belongs to another device (the first
// join of an id binds it, and ids are public, e.g. in the pairing link):
// forget it and its token, and use a new id in this tab from now on.
function replaceScreenId(slug: string, old: string): string {
  const fresh = newScreenId();
  const key = screenTokenKey(slug, old);
  screenTokens.delete(key);
  try {
    window.sessionStorage.removeItem(key);
    window.sessionStorage.setItem(SCREEN_ID_KEY, fresh);
  } catch {
    // This page keeps the new id in memory.
  }
  return fresh;
}

function statusOf(err: unknown): number | undefined {
  return (err as { status?: number } | null)?.status;
}

// Only the built-in Trebuchet snapshot has `units`; an external game's is
// { kind: 'external', seed }.
function isTrebuchetSnapshot(snapshot: unknown): snapshot is TrebuchetSnapshot {
  return !!snapshot && typeof snapshot === 'object' && 'units' in snapshot;
}

function loadSfx(): Promise<SfxModule | null> {
  if (sfxPromise) return sfxPromise;
  sfxPromise = (async () => {
    try {
      if (typeof window === 'undefined') return null;
      const importer = new Function('p', 'return import(p)') as (p: string) => Promise<any>;
      const mod = await importer('/js/sfx.js');
      return (mod?.SFX ?? mod?.default ?? null) as SfxModule | null;
    } catch {
      // Audio is optional — never let a load failure break the screen.
      return null;
    }
  })();
  return sfxPromise;
}

export function LobbyRoute({ slug, navigate }: { slug: string; navigate: (to: string) => void }) {
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [games, setGames] = useState<GameManifest[]>([]);
  const [lastEvent, setLastEvent] = useState<TrebuchetEvent | null>(null);
  const [lastControlEvent, setLastControlEvent] = useState<TrebuchetControlEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  // Exposed to the external-game host (game:finish auth) + input hook. The
  // trebuchet path never reads it, so its flow is untouched.
  const [socket, setSocket] = useState<Socket | null>(null);
  const gameHostRef = useRef<GameHostStageHandle | null>(null);
  const [screenId, setScreenId] = useState(ownScreenId);
  const screenIdRef = useRef(screenId);

  // The lobby shown, replaced only by snapshots that are not older (see
  // isOlderLobby). Returns whether `next` was taken.
  const lobbyRef = useRef<Lobby | null>(null);
  const takeLobby = useCallback((next: Lobby): boolean => {
    if (isOlderLobby(lobbyRef.current, next)) return false;
    lobbyRef.current = next;
    setLobby(next);
    return true;
  }, []);

  // A shot can reach this screen via the socket (same instance, instant) or via the
  // polled/snapshot lobby state (cross-instance, ≤750ms). Dedupe by monotonic seq so
  // it animates exactly once regardless of which path wins the race.
  const lastSeenSeqRef = useRef(0);
  const applyGameEvent = useCallback((seq: number, event: TrebuchetEvent) => {
    if (!seq || seq <= lastSeenSeqRef.current) return;
    lastSeenSeqRef.current = seq;
    setLastEvent(event);
  }, []);

  useEffect(() => {
    let active = true;
    let joining = false;
    let lastJoinAt = 0;
    let replacedId = false;
    const socket = createSocket();
    setSocket(socket);
    // Join this lobby as this TV. If the server says the screen id belongs to
    // another device, take a fresh id, once.
    const joinScreen = async () => {
      joining = true;
      lastJoinAt = Date.now();
      try {
        for (;;) {
          const id = screenIdRef.current;
          try {
            const joined = await emitAck<{ ok: true; lobby: Lobby; games: GameManifest[]; screenToken?: string }>(socket, 'screen:join', {
              slug,
              screenId: id,
              screenToken: readScreenToken(slug, id)
            });
            if (joined.screenToken) keepScreenToken(slug, id, joined.screenToken);
            if (active) {
              setNotice(null);
              if (joined.lobby) takeLobby(joined.lobby);
              if (joined.games) setGames(joined.games);
            }
            return;
          } catch (err) {
            if (statusOf(err) !== 403 || replacedId || !active) throw err;
            replacedId = true;
            screenIdRef.current = replaceScreenId(slug, id);
            setScreenId(screenIdRef.current);
          }
        }
      } finally {
        joining = false;
      }
    };
    // A lobby that already has enough screens still shows here, just without
    // a screen seat (never the host, no broadcasts) until one frees up.
    const noRoom = (err: unknown) => {
      if (statusOf(err) !== 409) return false;
      if (active) setNotice(SCREENS_FULL_NOTICE);
      return true;
    };
    const rejoin = () => {
      if (joining) return;
      void joinScreen().catch((err) => {
        // Anything but "no room": the poll keeps the screen going and the
        // next reconnect or listing check retries.
        noRoom(err);
      });
    };
    // The server may drop a TV that is still here (it missed a rejoin, or a
    // write got lost between instances), and an unlisted TV is never the host
    // screen: whenever a snapshot doesn't list this one, join again.
    const checkListed = (next: Lobby) => {
      if (joining || !socket.connected || !next.screens) return;
      if (next.screens.includes(screenIdRef.current)) return;
      if (Date.now() - lastJoinAt < REJOIN_INTERVAL_MS) return;
      rejoin();
    };

    // Only a lobby that doesn't exist (anymore) ends on the error page. A
    // failed join or catalog fetch doesn't: reconnects, the listing check and
    // the poll get past those.
    fetchLobby(slug)
      .then((initialLobby) => active && takeLobby(initialLobby))
      .catch((err) => {
        const status = statusOf(err);
        if (active && (status === 404 || status === 410)) {
          setError(err instanceof Error ? err.message : 'Lobby nicht gefunden');
        }
      });
    fetchGames()
      .then((gameList) => active && setGames(gameList))
      .catch(() => {
        // The screen:join ack carries the catalog too.
      });
    rejoin();

    // After a dropped connection the server no longer has this socket in the
    // lobby room (no inputs, no host role for broadcasts): rejoin. The first
    // connect finds the join above still waiting for it.
    socket.on('connect', rejoin);
    socket.on('lobby:snapshot', (next: Lobby) => {
      if (takeLobby(next)) checkListed(next);
    });
    socket.on('game:event', (p: { seq: number; event: TrebuchetEvent }) => applyGameEvent(p.seq, p.event));
    socket.on('game:control', (control: TrebuchetControlEvent) => setLastControlEvent(control));

    const refreshTimer = window.setInterval(() => {
      void fetchLobby(slug)
        .then((next) => {
          if (active && takeLobby(next)) checkListed(next);
        })
        .catch(() => {
          // Socket errors still surface during initial load; polling stays quiet.
        });
    }, 750);

    return () => {
      active = false;
      window.clearInterval(refreshTimer);
      socket.disconnect();
      setSocket(null);
    };
  }, [slug, applyGameEvent, takeLobby]);

  // Replay the latest event carried inside the polled/snapshot lobby state. This is the
  // cross-instance path: when the opponent fired on a different serverless instance the
  // socket broadcast never reached us, but the lobby snapshot (persisted + polled) does.
  // The seq-based dedup makes this safe to run on every lobby update.
  useEffect(() => {
    if (lobby?.lastEvent) {
      applyGameEvent(lobby.lastEvent.seq, lobby.lastEvent.event as TrebuchetEvent);
    }
  }, [lobby?.lastEvent?.seq, applyGameEvent]);

  // Load the shared audio engine, seed the mute toggle from its persisted state, and select the
  // pre-game "menu" music bed. Gameplay music ('game') is owned by the Phaser scene's create(), so
  // we only ask for 'menu' here — when the game starts it will override to 'game' on its own.
  useEffect(() => {
    let active = true;
    void loadSfx().then((sfx) => {
      if (!active || !sfx) return;
      try {
        setMuted(sfx.isMuted());
        sfx.musicScene('menu');
      } catch {
        // never block render on audio
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const toggleMute = () => {
    void loadSfx().then((sfx) => {
      if (!sfx) return;
      try {
        setMuted(sfx.toggleMute());
      } catch {
        // never throw out of a click handler
      }
    });
  };

  const inviteUrl = useMemo(() => `${window.location.origin}/j/${slug}`, [slug]);
  const eventSnapshot = lastEvent && 'snapshot' in lastEvent ? (lastEvent.snapshot as TrebuchetSnapshot) : undefined;
  const rawSnapshot = lobby?.gameSession?.snapshot;
  const snapshot = isTrebuchetSnapshot(rawSnapshot) ? rawSnapshot : eventSnapshot;
  const currentGame = games.find((game) => game.id === lobby?.currentGameId);
  // An external game is any resolved manifest whose origin is 'external' (the
  // catalog now returns those from GET /api/games). Absent origin ⇒ builtin.
  const externalManifest =
    currentGame && currentGame.origin === 'external' ? (currentGame as ExternalGameManifest) : null;

  // The lobby's game isn't in this TV's catalog: it was published after the
  // catalog was loaded (or reached this instance's cache first). Fetch the
  // catalog again, so the game can be shown, at most every CATALOG_RETRY_MS.
  const catalogRetryRef = useRef<{ gameId: string; at: number } | null>(null);
  const unknownGameId = lobby && !currentGame ? lobby.currentGameId : null;
  useEffect(() => {
    if (!unknownGameId) return;
    const last = catalogRetryRef.current;
    if (last && last.gameId === unknownGameId && Date.now() - last.at < CATALOG_RETRY_MS) return;
    catalogRetryRef.current = { gameId: unknownGameId, at: Date.now() };
    void fetchGames()
      .then((gameList) => setGames(gameList))
      .catch(() => {
        // Tried again on a later lobby update.
      });
  }, [unknownGameId, lobby]);

  // GAME-OVER LINGER: the server flips the lobby to 'ended' within milliseconds
  // of couch:gameOver, which would unmount the iframe before anyone sees the
  // game's winner screen. The linger is derived SYNCHRONOUSLY during render
  // (a deadline in a ref, armed while playing) so the very render that sees
  // state 'ended' still shows the stage — an effect would leave a one-frame
  // unmount that reloads the iframe and erases the winner screen.
  const lingerRef = useRef<{ manifest: ExternalGameManifest; deadline: number } | null>(null);
  const [, forceLingerTick] = useState(0);
  if (lobby?.state === 'playing' && externalManifest) {
    lingerRef.current = { manifest: externalManifest, deadline: 0 }; // armed while live
  } else if (lingerRef.current) {
    if (lobby?.state === 'ended') {
      if (lingerRef.current.deadline === 0) {
        lingerRef.current = { manifest: lingerRef.current.manifest, deadline: Date.now() + GAME_OVER_LINGER_MS };
      } else if (Date.now() >= lingerRef.current.deadline) {
        lingerRef.current = null;
      }
    } else {
      lingerRef.current = null; // back to waiting / a new game: drop immediately
    }
  }
  const lingerManifest =
    lobby?.state === 'ended' && lingerRef.current && lingerRef.current.deadline > 0
      ? lingerRef.current.manifest
      : null;
  useEffect(() => {
    if (!lingerManifest) return;
    const remaining = Math.max(0, (lingerRef.current?.deadline ?? 0) - Date.now());
    const timer = window.setTimeout(() => forceLingerTick((n) => n + 1), remaining + 20);
    return () => window.clearTimeout(timer);
  }, [lingerManifest]);

  // The stage manifest for the SINGLE GameHostStage render position below —
  // same element position across playing → linger keeps the iframe instance
  // (and the game's winner screen) alive through the transition.
  const stageManifest = lobby?.state === 'playing' ? externalManifest : lingerManifest;

  // Strict seq-ordered relay: socket 'game:input' + polled inputLog -> iframe.
  // Always mounted (hooks can't be conditional). It only sees the lobby while
  // a stage is there to take the inputs: an input passed on with no stage
  // would count as delivered and never reach the game once it mounts.
  const forwardInput = useCallback((input: Parameters<GameHostStageHandle['forwardInput']>[0]) => {
    gameHostRef.current?.forwardInput(input);
  }, []);
  useExternalGameInputs({ socket, lobby: stageManifest ? lobby : null, onInput: forwardInput });

  const createAnother = async () => {
    const next = await createLobby();
    navigate(`/l/${next.slug}`);
  };

  if (error) {
    return (
      <main className="center-shell">
        <div className="status-panel">
          <h1>{error}</h1>
          <button className="primary-btn" onClick={() => navigate('/')}>Zur Startseite</button>
        </div>
      </main>
    );
  }

  return (
    <main className="tv-shell">
      <header className="tv-header">
        <div className="brand-row small">
          <span className="brand-mark">c</span>
          <span>couch.gg</span>
        </div>
        <div className="room-code">
          <span>Room</span>
          <strong>{slug}</strong>
        </div>
        <div className="header-actions">
          <button
            className="icon-toggle"
            onClick={toggleMute}
            aria-pressed={muted}
            aria-label={muted ? 'Ton einschalten' : 'Ton ausschalten'}
            title={muted ? 'Ton einschalten' : 'Ton ausschalten'}
          >
            {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <button className="icon-btn" onClick={() => void navigator.clipboard?.writeText(inviteUrl)} title="Einladungslink kopieren">
            <Copy size={18} />
          </button>
          <button className="icon-btn" onClick={createAnother} title="Neue Lobby">
            <Plus size={18} />
          </button>
        </div>
      </header>

      <section className="tv-grid">
        <aside className="side-rail">
          <QrPanel value={inviteUrl} label="Scan to join" />
          <div className="rail-section">
            <div className="rail-title">
              <Smartphone size={16} />
              <span>Players {lobby?.players.length ?? 0}/4</span>
            </div>
            <PlayerRoster players={lobby?.players ?? []} hostPlayerId={lobby?.hostPlayerId ?? null} />
          </div>
          <div className="rail-section">
            <div className="rail-title">
              <MessageSquare size={16} />
              <span>Chat</span>
            </div>
            <ChatPanel messages={lobby?.chat ?? []} readOnly />
          </div>
          <div className="rail-section">
            <div className="rail-title">
              <RotateCcw size={16} />
              <span>Activity</span>
            </div>
            <div className="activity-list">
              {(lobby?.activity ?? []).map((item) => <span key={item.id}>{item.text}</span>)}
            </div>
          </div>
        </aside>

        <section className="play-surface">
          <div className="surface-topline">
            <div>
              <h1>{currentGame?.title ?? 'Trebuchet'}</h1>
              <p>{currentGame?.description ?? 'Waiting for game catalog.'}</p>
              {notice ? (
                <p className="screen-notice" role="status">
                  {notice}
                </p>
              ) : null}
            </div>
            <span className={lobby?.state === 'playing' ? 'state-live' : 'state-waiting'}>
              {lobby?.state === 'playing' ? 'Live' : lobby?.players.length ? 'Ready' : 'Waiting'}
            </span>
          </div>
          {stageManifest && lobby ? (
            // One stage per round: a new round (even of the same game, even
            // during the game-over linger) gets a fresh iframe and a fresh
            // couch:init with its own seed. The linger keeps the session id,
            // so the winner screen stays up.
            <GameHostStage
              key={lobby.gameSession?.id ?? ''}
              ref={gameHostRef}
              manifest={stageManifest}
              lobby={lobby}
              socket={socket}
              screenId={screenId}
              mode="live"
            />
          ) : lobby?.state === 'playing' ? (
            (currentGame && currentGame.origin !== 'external') || isTrebuchetSnapshot(rawSnapshot) ? (
              <TrebuchetStage snapshot={snapshot ?? null} event={lastEvent} controlEvent={lastControlEvent} />
            ) : (
              // An external game this TV's catalog doesn't know yet.
              <div className="stage-pending muted" data-testid="stage-pending">
                Spiel wird geladen…
              </div>
            )
          ) : (
            <GameCatalog
              games={games}
              currentGameId={lobby?.currentGameId ?? null}
              selectable={false}
              remoteMode={lobby?.mode === 'remote'}
            />
          )}
        </section>
      </section>
    </main>
  );
}
