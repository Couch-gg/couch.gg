import { Crown, Gamepad2, LogOut, Play, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { GameManifest, JoinLobbyResponse, Lobby, Player } from '@couch/types';
import type { TrebuchetEvent, TrebuchetSnapshot } from '@couch/trebuchet';
import { fetchLobby } from '../api.js';
import { createSocket, emitAck } from '../socket.js';

export function ControllerRoute({ slug, navigate }: { slug: string; navigate: (to: string) => void }) {
  const [name, setName] = useState(() => window.localStorage.getItem('couch:name') || '');
  const [player, setPlayer] = useState<Player | null>(null);
  const [playerToken, setPlayerToken] = useState(() => window.localStorage.getItem(tokenKey(slug)) || '');
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [games, setGames] = useState<GameManifest[]>([]);
  const [angle, setAngle] = useState(72);
  const [power, setPower] = useState(68);
  const [error, setError] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<TrebuchetEvent | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    const nextSocket = createSocket();
    setSocket(nextSocket);
    nextSocket.on('lobby:snapshot', (next: Lobby) => setLobby(next));
    nextSocket.on('game:event', (event: TrebuchetEvent) => setLastEvent(event));
    return () => {
      nextSocket.disconnect();
      setSocket(null);
    };
  }, [slug]);

  const join = async () => {
    setError(null);
    if (!socket) {
      setError('Realtime-Verbindung startet noch');
      return;
    }
    try {
      const joined = await emitAck<JoinLobbyResponse & { ok: true; games: GameManifest[] }>(socket, 'controller:join', {
        slug,
        name: name || 'Player',
        playerToken
      });
      setPlayer(joined.player);
      setLobby(joined.lobby);
      setGames(joined.games);
      setPlayerToken(joined.playerToken);
      window.localStorage.setItem(tokenKey(slug), joined.playerToken);
      window.localStorage.setItem('couch:name', joined.player.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Join fehlgeschlagen');
    }
  };

  useEffect(() => {
    if (socket && playerToken && !player) {
      void join();
    }
    // One reconnect attempt on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  useEffect(() => {
    if (!player) return;
    let active = true;
    const refresh = () => {
      void fetchLobby(slug)
        .then((next) => active && setLobby(next))
        .catch(() => {
          // A dropped poll should not disconnect an already joined controller.
        });
    };
    refresh();
    const refreshTimer = window.setInterval(refresh, 750);
    return () => {
      active = false;
      window.clearInterval(refreshTimer);
    };
  }, [player, slug]);

  const isHost = Boolean(player && lobby?.hostPlayerId === player.id);
  const snapshot = lobby?.gameSession?.snapshot as TrebuchetSnapshot | undefined;
  const currentTurn = snapshot?.turn;
  const myTurn = Boolean(player && currentTurn === player.id);
  const canStart = Boolean(isHost && lobby && lobby.players.length >= 2 && lobby.state !== 'playing');

  const start = async () => {
    if (!socket) return;
    await emitAck(socket, 'game:start', { slug, playerToken });
  };

  const fire = async () => {
    if (!socket) return;
    await emitAck(socket, 'controller:event', {
      slug,
      playerToken,
      event: {
        playerId: player?.id,
        type: 'game',
        control: 'fire',
        value: { angle, power },
        timestamp: Date.now()
      }
    });
  };

  if (!player) {
    return (
      <main className="controller-shell">
        <section className="controller-card">
          <div className="brand-row small">
            <span className="brand-mark">c</span>
            <span>Room {slug}</span>
          </div>
          <h1>Join as controller</h1>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" aria-label="Your name" />
          <button className="primary-btn wide" onClick={join}>
            <Gamepad2 size={18} /> Join
          </button>
          {error ? <p className="error-line">{error}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="controller-shell">
      <section className="controller-card tall">
        <div className="controller-top">
          <div>
            <span className="micro-label">Room {slug}</span>
            <h1>{player.name}</h1>
          </div>
          {isHost ? <span className="host-pill"><Crown size={14} /> Host</span> : null}
        </div>

        {lobby?.state !== 'playing' ? (
          <div className="controller-stack">
            <div className="mini-roster">
              {(lobby?.players ?? []).map((row) => (
                <span key={row.id}>{row.name}{row.isHost ? ' · Host' : ''}</span>
              ))}
            </div>
            {isHost ? (
              <>
                <label className="control-label">
                  Spiel
                  <select defaultValue="trebuchet" disabled={games.length <= 1}>
                    {(games.length ? games : [{ id: 'trebuchet', title: 'Trebuchet' } as GameManifest]).map((game) => (
                      <option key={game.id} value={game.id}>{game.title}</option>
                    ))}
                  </select>
                </label>
                <button className="primary-btn wide" disabled={!canStart} onClick={start}>
                  <Play size={18} /> Trebuchet starten
                </button>
              </>
            ) : (
              <p className="muted">Warte auf den Host. Dein Handy bleibt gekoppelt.</p>
            )}
          </div>
        ) : (
          <div className="trebuchet-controls">
            <div className={myTurn ? 'turn-card active' : 'turn-card'}>
              <span>{myTurn ? 'Your turn' : 'Waiting'}</span>
              <strong>{turnName(snapshot, currentTurn)}</strong>
            </div>
            <label className="range-control">
              <span>Angle <strong>{angle}°</strong></span>
              <input min={50} max={130} step={1} value={angle} type="range" onChange={(event) => setAngle(Number(event.target.value))} />
            </label>
            <label className="range-control">
              <span>Power <strong>{power}%</strong></span>
              <input min={10} max={100} step={1} value={power} type="range" onChange={(event) => setPower(Number(event.target.value))} />
            </label>
            <button className="fire-btn" disabled={!myTurn} onClick={fire}>
              <Send size={20} /> Fire
            </button>
            {lastEvent?.type === 'shot' ? <p className="muted">Last shot: {lastEvent.power}% at {lastEvent.angle}°</p> : null}
          </div>
        )}

        <button
          className="text-btn"
          onClick={() => {
            window.localStorage.removeItem(tokenKey(slug));
            navigate('/');
          }}
        >
          <LogOut size={16} /> Leave
        </button>
      </section>
    </main>
  );
}

function tokenKey(slug: string): string {
  return `couch:player-token:${slug}`;
}

function turnName(snapshot: TrebuchetSnapshot | undefined, playerId: string | null | undefined): string {
  if (!snapshot || !playerId) return 'Game over';
  return snapshot.units.find((unit) => unit.id === playerId)?.name ?? 'Player';
}
