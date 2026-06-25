import { Copy, MessageSquare, Plus, RotateCcw, Smartphone, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GameManifest, Lobby } from '@couch/types';
import type { TrebuchetEvent, TrebuchetSnapshot } from '@couch/trebuchet';
import { createLobby, fetchGames, fetchLobby } from '../api.js';
import { createSocket, emitAck } from '../socket.js';
import { ChatPanel } from '../components/ChatPanel.js';
import { GameCatalog } from '../components/GameCatalog.js';
import { PlayerRoster } from '../components/PlayerRoster.js';
import { QrPanel } from '../components/QrPanel.js';
import { TrebuchetStage, type TrebuchetControlEvent } from '../components/TrebuchetStage.js';

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
  const [muted, setMuted] = useState(false);

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
    const socket = createSocket();
    Promise.all([fetchLobby(slug), fetchGames()])
      .then(([initialLobby, gameList]) => {
        if (!active) return;
        setLobby(initialLobby);
        setGames(gameList);
        return emitAck<{ ok: true; lobby: Lobby; games: GameManifest[] }>(socket, 'screen:join', { slug });
      })
      .then((joined) => {
        if (joined?.lobby && active) setLobby(joined.lobby);
      })
      .catch((err) => active && setError(err instanceof Error ? err.message : 'Lobby konnte nicht geladen werden'));

    socket.on('lobby:snapshot', (next: Lobby) => setLobby(next));
    socket.on('game:event', (p: { seq: number; event: TrebuchetEvent }) => applyGameEvent(p.seq, p.event));
    socket.on('game:control', (control: TrebuchetControlEvent) => setLastControlEvent(control));

    const refreshTimer = window.setInterval(() => {
      void fetchLobby(slug)
        .then((next) => active && setLobby(next))
        .catch(() => {
          // Socket errors still surface during initial load; polling stays quiet.
        });
    }, 750);

    return () => {
      active = false;
      window.clearInterval(refreshTimer);
      socket.disconnect();
    };
  }, [slug, applyGameEvent]);

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
  const snapshot = (lobby?.gameSession?.snapshot as TrebuchetSnapshot | undefined) ?? eventSnapshot;
  const currentGame = games.find((game) => game.id === lobby?.currentGameId);

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
            </div>
            <span className={lobby?.state === 'playing' ? 'state-live' : 'state-waiting'}>
              {lobby?.state === 'playing' ? 'Live' : lobby?.players.length ? 'Ready' : 'Waiting'}
            </span>
          </div>
          {lobby?.state === 'playing' ? (
            <TrebuchetStage snapshot={snapshot ?? null} event={lastEvent} controlEvent={lastControlEvent} />
          ) : (
            <GameCatalog games={games} currentGameId={lobby?.currentGameId ?? null} selectable={false} />
          )}
        </section>
      </section>
    </main>
  );
}
