import { Copy, Plus, RotateCcw, Smartphone } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { GameManifest, Lobby } from '@couch/types';
import type { TrebuchetEvent, TrebuchetSnapshot } from '@couch/trebuchet';
import { createLobby, fetchGames, fetchLobby } from '../api.js';
import { createSocket, emitAck } from '../socket.js';
import { PlayerRoster } from '../components/PlayerRoster.js';
import { QrPanel } from '../components/QrPanel.js';
import { TrebuchetStage, type TrebuchetControlEvent } from '../components/TrebuchetStage.js';

export function LobbyRoute({ slug, navigate }: { slug: string; navigate: (to: string) => void }) {
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [games, setGames] = useState<GameManifest[]>([]);
  const [lastEvent, setLastEvent] = useState<TrebuchetEvent | null>(null);
  const [lastControlEvent, setLastControlEvent] = useState<TrebuchetControlEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    socket.on('game:event', (event: TrebuchetEvent) => setLastEvent(event));
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
  }, [slug]);

  const controllerUrl = useMemo(() => `${window.location.origin}/c/${slug}`, [slug]);
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
          <button className="icon-btn" onClick={() => void navigator.clipboard?.writeText(controllerUrl)} title="Controller-Link kopieren">
            <Copy size={18} />
          </button>
          <button className="icon-btn" onClick={createAnother} title="Neue Lobby">
            <Plus size={18} />
          </button>
        </div>
      </header>

      <section className="tv-grid">
        <aside className="side-rail">
          <QrPanel value={controllerUrl} />
          <div className="rail-section">
            <div className="rail-title">
              <Smartphone size={16} />
              <span>Players {lobby?.players.length ?? 0}/4</span>
            </div>
            <PlayerRoster players={lobby?.players ?? []} hostPlayerId={lobby?.hostPlayerId ?? null} />
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
          <TrebuchetStage snapshot={snapshot ?? null} event={lastEvent} controlEvent={lastControlEvent} />
          {lobby?.state !== 'playing' ? (
            <div className="screen-hint">
              Scan the code, join with two phones, then the host starts Trebuchet from their controller.
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}
