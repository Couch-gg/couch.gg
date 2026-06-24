import { ChevronLeft, ChevronRight, Crown, Gamepad2, LogOut, Play, Send } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { Socket } from 'socket.io-client';
import type { GameManifest, JoinLobbyResponse, Lobby, Player } from '@couch/types';
import {
  CHARGE_TIME_MS,
  ELEV_MAX,
  ELEV_MIN,
  POWER_MAX,
  POWER_MIN,
  type TrebuchetEvent,
  type TrebuchetSnapshot
} from '@couch/trebuchet';
import { fetchLobby } from '../api.js';
import { createSocket, emitAck } from '../socket.js';

export function ControllerRoute({ slug, navigate }: { slug: string; navigate: (to: string) => void }) {
  const [name, setName] = useState(() => window.localStorage.getItem('couch:name') || '');
  const [player, setPlayer] = useState<Player | null>(null);
  const [playerToken, setPlayerToken] = useState(() => window.localStorage.getItem(tokenKey(slug)) || '');
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [games, setGames] = useState<GameManifest[]>([]);
  const [angle, setAngle] = useState(72);
  const [power, setPower] = useState(POWER_MIN);
  const [aimStep, setAimStep] = useState(1);
  const [charging, setCharging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<TrebuchetEvent | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const chargeStartRef = useRef<number | null>(null);
  const chargeTimerRef = useRef<number | null>(null);
  const lastChargeSendRef = useRef(0);

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

  useEffect(() => {
    return () => stopChargeTimer();
  }, []);

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

  const sendPreview = async (control: 'trebuchet.aim' | 'trebuchet.charge', value: unknown) => {
    if (!socket || !myTurn) return;
    try {
      await emitAck(socket, 'controller:event', {
        slug,
        playerToken,
        event: {
          playerId: player?.id,
          type: 'game',
          control,
          value,
          timestamp: Date.now()
        }
      });
    } catch {
      // Preview events are best-effort; final fire remains acknowledged below.
    }
  };

  const aim = (direction: -1 | 1) => {
    if (!myTurn || charging) return;
    const nextAngle = snapAim(angle + direction * aimStep, direction);
    setAngle(nextAngle);
    void sendPreview('trebuchet.aim', { angle: nextAngle, direction, step: aimStep });
  };

  const fire = async (shotPower = power) => {
    if (!socket || !myTurn) return;
    await emitAck(socket, 'controller:event', {
      slug,
      playerToken,
      event: {
        playerId: player?.id,
        type: 'game',
        control: 'trebuchet.fire',
        value: { angle, power: shotPower },
        timestamp: Date.now()
      }
    });
  };

  const beginCharge = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (!myTurn || charging) return;
    const now = performance.now();
    chargeStartRef.current = now;
    lastChargeSendRef.current = now;
    setCharging(true);
    setPower(POWER_MIN);
    void sendPreview('trebuchet.charge', { active: true, power: POWER_MIN });
    stopChargeTimer();
    chargeTimerRef.current = window.setInterval(() => {
      const nextPower = chargePower();
      setPower(nextPower);
      const tick = performance.now();
      if (tick - lastChargeSendRef.current > 120 || nextPower >= POWER_MAX) {
        lastChargeSendRef.current = tick;
        void sendPreview('trebuchet.charge', { active: true, power: nextPower });
      }
      if (nextPower >= POWER_MAX) {
        void releaseCharge();
      }
    }, 40);
  };

  const releaseCharge = async () => {
    if (chargeStartRef.current == null) return;
    const shotPower = chargePower();
    stopChargeTimer();
    chargeStartRef.current = null;
    setCharging(false);
    setPower(shotPower);
    await sendPreview('trebuchet.charge', { active: false, power: shotPower });
    await fire(shotPower);
  };

  const cancelCharge = () => {
    if (chargeStartRef.current == null) return;
    stopChargeTimer();
    chargeStartRef.current = null;
    setCharging(false);
    setPower(POWER_MIN);
    void sendPreview('trebuchet.charge', { active: false, power: POWER_MIN });
  };

  function stopChargeTimer() {
    if (chargeTimerRef.current != null) {
      window.clearInterval(chargeTimerRef.current);
      chargeTimerRef.current = null;
    }
  }

  function chargePower(): number {
    const startedAt = chargeStartRef.current;
    if (startedAt == null) return POWER_MIN;
    const fraction = Math.min(1, (performance.now() - startedAt) / CHARGE_TIME_MS);
    return Math.round(POWER_MIN + (POWER_MAX - POWER_MIN) * fraction);
  }

  useEffect(() => {
    if (!myTurn) cancelCharge();
  }, [myTurn]);

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
            <div className="aim-pad" aria-label="Trebuchet aim controls">
              <button type="button" className="aim-btn" disabled={!myTurn || charging} onClick={() => aim(1)} aria-label="Aim left">
                <ChevronLeft size={28} />
              </button>
              <div className="aim-readout">
                <span>ARC</span>
                <strong>{arcLabel(angle)}</strong>
                <button type="button" className="step-toggle" onClick={() => setAimStep((value) => (value === 1 ? 5 : 1))}>
                  {aimStep}°
                </button>
              </div>
              <button type="button" className="aim-btn" disabled={!myTurn || charging} onClick={() => aim(-1)} aria-label="Aim right">
                <ChevronRight size={28} />
              </button>
            </div>
            <div className="charge-readout">
              <span>POWER</span>
              <div className="charge-track">
                <span style={{ width: `${power}%` }} />
              </div>
              <strong>{power}%</strong>
            </div>
            <button
              className={charging ? 'fire-btn charging' : 'fire-btn'}
              disabled={!myTurn}
              onPointerDown={beginCharge}
              onPointerUp={() => void releaseCharge()}
              onPointerCancel={cancelCharge}
              onPointerLeave={() => {
                if (charging) void releaseCharge();
              }}
            >
              <Send size={20} /> {charging ? 'Release to fire' : 'Hold fire'}
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

const RIGHT_LO = ELEV_MIN;
const RIGHT_HI = ELEV_MAX;
const LEFT_LO = 180 - ELEV_MAX;
const LEFT_HI = 180 - ELEV_MIN;

function snapAim(rawAngle: number, direction: -1 | 0 | 1): number {
  let next = Math.round(rawAngle);
  if (!Number.isFinite(next)) next = RIGHT_LO;
  if (next < RIGHT_LO) next = RIGHT_LO;
  else if (next > LEFT_HI) next = LEFT_HI;
  else if (next > RIGHT_HI && next < LEFT_LO) {
    if (direction > 0) next = LEFT_LO;
    else if (direction < 0) next = RIGHT_HI;
    else next = next - RIGHT_HI <= LEFT_LO - next ? RIGHT_HI : LEFT_LO;
  }
  return next;
}

function arcLabel(angle: number): string {
  const right = angle <= RIGHT_HI;
  const elevation = right ? angle : 180 - angle;
  return `${right ? '►' : '◄'} ${elevation}°`;
}
