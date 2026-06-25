import {
  Check,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Crown,
  Flame,
  Gamepad2,
  LogOut,
  Play,
  Share2
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type MutableRefObject, type PointerEvent } from 'react';
import type { Socket } from 'socket.io-client';
import type { GameManifest, JoinLobbyResponse, Lobby, Player } from '@couch/types';
import {
  CHARGE_TIME_MS,
  ELEV_MAX,
  ELEV_MIN,
  POWER_MAX,
  POWER_MIN,
  TEAM_COLORS,
  WORLD_W,
  type TrebuchetEvent,
  type TrebuchetSnapshot,
  type TrebuchetUnit
} from '@couch/trebuchet';
import { GameCatalog } from '../components/GameCatalog.js';
import { ChatPanel } from '../components/ChatPanel.js';
import { fetchLobby, sendChat } from '../api.js';
import { createSocket, emitAck } from '../socket.js';

// The audio engine lives in public/ (served at /js/sfx.js), not in src/, so it must be loaded via a
// runtime dynamic import rather than a static one. We wrap import() in `new Function` so Vite leaves
// the specifier untouched (same approach LobbyRoute/TrebuchetStage use for public modules). The module
// is a shared singleton — the Phaser game imports the same URL — so it also respects the global mute.
interface SfxModule {
  play: (name: string) => void;
  startCharge: () => void;
  setChargeLevel: (p01: number) => void;
  stopCharge: () => void;
}

let sfxPromise: Promise<SfxModule | null> | null = null;
const REMOTE_SHARE_KEY_PREFIX = 'couch:share-room:';
const DEFAULT_AIM_ELEVATION = 72;

function loadSfx(): Promise<SfxModule | null> {
  if (sfxPromise) return sfxPromise;
  sfxPromise = (async () => {
    try {
      if (typeof window === 'undefined') return null;
      const importer = new Function('p', 'return import(p)') as (p: string) => Promise<any>;
      const mod = await importer('/js/sfx.js');
      return (mod?.SFX ?? mod?.default ?? null) as SfxModule | null;
    } catch {
      // Audio is optional — never let a load failure break the controller.
      return null;
    }
  })();
  return sfxPromise;
}

export function ControllerRoute({ slug, navigate }: { slug: string; navigate: (to: string) => void }) {
  const [name, setName] = useState(() => window.localStorage.getItem('couch:name') || '');
  const [player, setPlayer] = useState<Player | null>(null);
  const [playerToken, setPlayerToken] = useState(() => window.localStorage.getItem(tokenKey(slug)) || '');
  const [joinStatus, setJoinStatus] = useState<'idle' | 'joining' | 'failed'>('idle');
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [games, setGames] = useState<GameManifest[]>([]);
  const [angle, setAngle] = useState(72);
  const [power, setPower] = useState(POWER_MIN);
  const [aimStep, setAimStep] = useState(1);
  const [charging, setCharging] = useState(false);
  const [atFull, setAtFull] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<TrebuchetEvent | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [copied, setCopied] = useState(false);
  const shareKey = `${REMOTE_SHARE_KEY_PREFIX}${slug}`;
  const [shareRoomOpen, setShareRoomOpen] = useState(() => {
    try {
      return window.sessionStorage.getItem(shareKey) === '1';
    } catch {
      return false;
    }
  });
  const [shareCopied, setShareCopied] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  const shareTimerRef = useRef<number | null>(null);
  const chargeStartRef = useRef<number | null>(null);
  const chargeTimerRef = useRef<number | null>(null);
  const lastChargeSendRef = useRef(0);
  const rememberedAnglesRef = useRef<Record<string, number>>({});
  const lastTurnAimKeyRef = useRef<string | null>(null);

  // Retro button sounds. Loaded once on mount into a ref (not state) so input
  // handlers can fire it synchronously without triggering re-renders; null until
  // the public module resolves, so every call site optional-chains it.
  const sfxRef = useRef<SfxModule | null>(null);
  // Guards the "I got hit" haptic/audio effect from re-firing on the same event
  // reference (effects can re-run when their other deps — like `player` — change).
  const handledEventRef = useRef<TrebuchetEvent | null>(null);

  // --- Hold-to-repeat aim state -------------------------------------------
  const aimRepeatRef = useRef<number | null>(null);
  const aimHoldStartRef = useRef(0);
  const angleRef = useRef(angle);
  angleRef.current = angle;

  // --- Drag-to-aim state ---------------------------------------------------
  const gaugeRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const nextSocket = createSocket();
    setSocket(nextSocket);
    nextSocket.on('lobby:snapshot', (next: Lobby) => setLobby(next));
    nextSocket.on('game:event', (event: TrebuchetEvent) => setLastEvent(event));

    // Re-register this controller on every (re)connect. A phone that locks or sleeps
    // drops its socket; Socket.IO reconnects on wake and this re-emits controller:join,
    // putting us back into the lobby room and flipping us from "reconnecting" to
    // connected. Within the server's grace window we keep the same slot, host status
    // and turn — including mid-game (the server's token-reconnect path has no
    // game-in-progress block; only brand-new players are turned away during play).
    const rejoinIfPossible = () => {
      setReconnecting(false);
      const token = window.localStorage.getItem(tokenKey(slug));
      if (!token) return; // first-time visitors join via the form below
      const storedName = window.localStorage.getItem('couch:name') || 'Player';
      void emitAck<JoinLobbyResponse & { ok: true; games: GameManifest[] }>(nextSocket, 'controller:join', {
        slug,
        name: storedName,
        playerToken: token
      })
        .then((joined) => {
          setPlayer(joined.player);
          setLobby(joined.lobby);
          setGames(joined.games);
          setPlayerToken(joined.playerToken);
          window.localStorage.setItem(tokenKey(slug), joined.playerToken);
          window.localStorage.setItem('couch:activeSlug', slug);
        })
        .catch(() => {
          // Room may be gone after a very long absence; leave the UI as-is.
        });
    };

    nextSocket.on('connect', rejoinIfPossible);
    nextSocket.on('disconnect', () => setReconnecting(true));

    return () => {
      nextSocket.disconnect();
      setSocket(null);
    };
  }, [slug]);

  useEffect(() => {
    // Warm the shared audio engine so input handlers have it ready; respects global mute.
    void loadSfx().then((m) => {
      sfxRef.current = m;
    });
    return () => {
      stopChargeTimer();
      stopAimRepeat();
      if (copiedTimerRef.current != null) {
        window.clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
      if (shareTimerRef.current != null) {
        window.clearTimeout(shareTimerRef.current);
        shareTimerRef.current = null;
      }
    };
  }, []);

  const join = useCallback(async () => {
    setError(null);
    if (!socket) {
      setError('Realtime-Verbindung startet noch');
      setJoinStatus('failed');
      return;
    }
    setJoinStatus('joining');
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
      window.localStorage.setItem('couch:activeSlug', slug);
      window.localStorage.setItem('couch:name', joined.player.name);
      setJoinStatus('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Join fehlgeschlagen');
      setJoinStatus('failed');
    }
  }, [name, playerToken, slug, socket]);

  // First-time visitors should land directly in the controller. Returning users
  // still auto-join + reconnect via the socket effect's 'connect' listener above.
  useEffect(() => {
    if (player || !socket || joinStatus !== 'idle') return;
    void join();
  }, [join, joinStatus, player, socket]);

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
  const myUnit = player ? snapshot?.units.find((unit) => unit.id === player.id) : undefined;

  useEffect(() => {
    if (!player || !myTurn || !snapshot || !myUnit) return;
    const turnKey = [snapshot.seed, snapshot.turn, snapshot.turnEndsAt ?? 0].join(':');
    if (lastTurnAimKeyRef.current === turnKey) return;
    lastTurnAimKeyRef.current = turnKey;
    const nextAngle = rememberedAnglesRef.current[player.id] ?? defaultAimForUnit(myUnit);
    angleRef.current = nextAngle;
    setAngle(nextAngle);
    setPower(POWER_MIN);
  }, [myTurn, myUnit, player, snapshot]);

  const start = async () => {
    if (!socket) return;
    await emitAck(socket, 'game:start', { slug, playerToken });
  };

  const selectGame = async (gameId: string) => {
    if (!socket) return;
    try {
      await emitAck(socket, 'game:select', { slug, playerToken, gameId });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Spielauswahl fehlgeschlagen');
    }
  };

  const sendChatMessage = async (text: string) => {
    if (!socket) return;
    try {
      await emitAck(socket, 'chat:send', { slug, playerToken, text });
    } catch {
      try {
        await sendChat(slug, playerToken, text);
      } catch {
        /* surface nothing; best-effort */
      }
    }
  };

  const flashCopied = (setter: (value: boolean) => void, timerRef: MutableRefObject<number | null>) => {
    setter(true);
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      setter(false);
      timerRef.current = null;
    }, 1500);
  };

  const copyRoomNumber = async () => {
    try {
      await navigator.clipboard?.writeText(slug);
      flashCopied(setCopied, copiedTimerRef);
    } catch {
      // Clipboard may be unavailable (insecure context / no permission); ignore.
    }
  };

  const shareRoomNumber = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Couch.gg Remote Couch', text: slug });
      } else {
        await navigator.clipboard?.writeText(slug);
      }
      flashCopied(setShareCopied, shareTimerRef);
    } catch {
      try {
        await navigator.clipboard?.writeText(slug);
        flashCopied(setShareCopied, shareTimerRef);
      } catch {
        // Sharing is a convenience; the visible room number remains usable.
      }
    }
  };

  const dismissRoomShare = () => {
    try {
      window.sessionStorage.removeItem(shareKey);
    } catch {
      // Session storage may be unavailable; the modal can still close for this render.
    }
    setShareRoomOpen(false);
  };

  const sendPreview = useCallback(async (control: 'trebuchet.aim' | 'trebuchet.charge', value: unknown) => {
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
  }, [myTurn, player?.id, playerToken, slug, socket]);

  // Apply a raw angle (already snapped) and broadcast the aim preview.
  const applyAngle = useCallback(
    (nextAngle: number, direction: -1 | 0 | 1) => {
      if (nextAngle === angleRef.current) return;
      sfxRef.current?.play('aim');
      setAngle(nextAngle);
      if (player?.id) rememberedAnglesRef.current[player.id] = nextAngle;
      void sendPreview('trebuchet.aim', { angle: nextAngle, direction, step: aimStep });
    },
    [aimStep, player?.id, sendPreview]
  );

  // Step the arc by `direction` button-presses worth of `aimStep`.
  const aimStepBy = useCallback(
    (direction: -1 | 1, amount: number) => {
      const next = snapAim(angleRef.current + direction * amount, direction);
      applyAngle(next, direction);
    },
    [applyAngle]
  );

  // --- Hold-to-repeat with mild acceleration ------------------------------
  const startAimRepeat = (direction: -1 | 1) => {
    if (!myTurn || charging) return;
    stopAimRepeat();
    aimHoldStartRef.current = performance.now();
    // Immediate first tick on press.
    aimStepBy(direction, aimStep);
    let lastTick = performance.now();
    const tick = () => {
      const now = performance.now();
      const held = now - aimHoldStartRef.current;
      // Acceleration: start slow (~5 ticks/s), ramp to fast (~16 ticks/s) over 1.2s.
      const ramp = Math.min(1, held / 1200);
      const interval = 200 - ramp * 140; // 200ms -> 60ms
      if (now - lastTick >= interval) {
        lastTick = now;
        // After holding past the ramp, step in coarser increments for fast travel.
        const accelStep = aimStep * (ramp >= 1 ? 2 : 1);
        aimStepBy(direction, accelStep);
      }
      aimRepeatRef.current = window.requestAnimationFrame(tick);
    };
    aimRepeatRef.current = window.requestAnimationFrame(tick);
  };

  function stopAimRepeat() {
    if (aimRepeatRef.current != null) {
      window.cancelAnimationFrame(aimRepeatRef.current);
      aimRepeatRef.current = null;
    }
  }

  // --- Drag-to-aim on the elevation gauge ---------------------------------
  const aimFromPointer = (clientX: number, clientY: number) => {
    const el = gaugeRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Vertical position drives elevation; horizontal half drives side.
    // Top of gauge = max elevation, bottom = min elevation.
    const t = clamp01(1 - (clientY - rect.top) / rect.height);
    const elevation = Math.round(ELEV_MIN + t * (ELEV_MAX - ELEV_MIN));
    const leftSide = clientX - rect.left < rect.width / 2;
    const nextAngle = leftSide ? 180 - elevation : elevation;
    const prev = angleRef.current;
    const direction: -1 | 0 | 1 = nextAngle > prev ? 1 : nextAngle < prev ? -1 : 0;
    applyAngle(snapAim(nextAngle, direction), direction);
  };

  const onGaugePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!myTurn || charging) return;
    event.preventDefault();
    draggingRef.current = true;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // setPointerCapture can throw on stale ids; safe to ignore.
    }
    aimFromPointer(event.clientX, event.clientY);
  };

  const onGaugePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    event.preventDefault();
    aimFromPointer(event.clientX, event.clientY);
  };

  const onGaugePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
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
    // A new charge cancels any in-progress aim repeat.
    stopAimRepeat();
    haptic(15);
    sfxRef.current?.play('click');
    sfxRef.current?.startCharge();
    const now = performance.now();
    chargeStartRef.current = now;
    lastChargeSendRef.current = now;
    setCharging(true);
    setAtFull(false);
    setPower(POWER_MIN);
    void sendPreview('trebuchet.charge', { active: true, power: POWER_MIN });
    stopChargeTimer();
    chargeTimerRef.current = window.setInterval(() => {
      const nextPower = chargePower();
      setPower(nextPower);
      sfxRef.current?.setChargeLevel(nextPower / 100);
      const tick = performance.now();
      if (tick - lastChargeSendRef.current > 120 || nextPower >= POWER_MAX) {
        lastChargeSendRef.current = tick;
        void sendPreview('trebuchet.charge', { active: true, power: nextPower });
      }
      if (nextPower >= POWER_MAX) {
        setAtFull(true);
        haptic([30, 40, 30]);
        sfxRef.current?.play('charge_full');
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
    setAtFull(false);
    setPower(shotPower);
    haptic(45);
    sfxRef.current?.stopCharge();
    sfxRef.current?.play('fire');
    await sendPreview('trebuchet.charge', { active: false, power: shotPower });
    await fire(shotPower);
  };

  const cancelCharge = () => {
    if (chargeStartRef.current == null) return;
    stopChargeTimer();
    sfxRef.current?.stopCharge();
    chargeStartRef.current = null;
    setCharging(false);
    setAtFull(false);
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
    if (!myTurn) {
      cancelCharge();
      stopAimRepeat();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myTurn]);

  // Buzz + sound when THIS player takes damage or dies on the latest shot. `haptic`
  // is iOS-safe (silent no-op there), so the audio cue doubles as the iOS fallback.
  // We dedupe on the event reference so it never re-fires when `player` changes.
  useEffect(() => {
    if (!player || !lastEvent || lastEvent.type !== 'shot') return;
    if (handledEventRef.current === lastEvent) return;
    handledEventRef.current = lastEvent;
    const r = lastEvent.result;
    const died = r.deaths.includes(player.id);
    const unit = r.hits.find((h) => h.id === player.id);
    const castle = r.castleHits.find((h) => h.id === player.id);
    if (died) {
      haptic([60, 50, 120]);
      sfxRef.current?.play('death');
    } else if (unit || castle) {
      const dmg = (unit?.dmg ?? 0) + (castle?.dmg ?? 0);
      haptic(dmg >= 20 ? [40, 30, 40] : 25);
      sfxRef.current?.play(dmg >= 20 ? 'bighit' : 'hit');
    }
  }, [lastEvent, player]);

  if (!player) {
    return (
      <main className="controller-shell">
        <section className="controller-card">
          <div className="brand-row small">
            <span className="brand-mark">c</span>
            <span>Room {slug}</span>
          </div>
          <h1>{joinStatus === 'failed' ? 'Controller join failed' : 'Joining room...'}</h1>
          {joinStatus === 'failed' ? (
            <>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" aria-label="Your name" />
              <button className="primary-btn wide" onClick={join}>
                <Gamepad2 size={18} /> Try again
              </button>
            </>
          ) : null}
          {error ? <p className="error-line">{error}</p> : null}
        </section>
      </main>
    );
  }

  const aiming = arcInfo(angle);

  // This player's team color (game palette) for the handheld's active-turn LED / accent.
  const colorIdx = snapshot?.units.find((unit) => unit.id === player.id)?.colorIdx ?? 0;
  const teamHex = `#${TEAM_COLORS[colorIdx % TEAM_COLORS.length].toString(16).padStart(6, '0')}`;

  return (
    <main className="controller-shell">
      <section className="controller-card tall">
        {reconnecting ? <div className="reconnect-pill">Reconnecting…</div> : null}
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

            <button className="text-btn" type="button" onClick={copyRoomNumber}>
              {copied ? (
                <>
                  <Check size={16} /> Copied!
                </>
              ) : (
                <>
                  <Share2 size={16} /> Room number
                </>
              )}
            </button>

            <GameCatalog
              games={games}
              currentGameId={lobby?.currentGameId ?? null}
              selectable={isHost}
              onSelect={selectGame}
            />

            {isHost ? (
              <button className="primary-btn wide" disabled={!canStart} onClick={start}>
                <Play size={18} /> Trebuchet starten
              </button>
            ) : (
              <p className="muted">Warte auf den Host. Dein Handy bleibt gekoppelt.</p>
            )}

            <div className="controller-chat">
              <ChatPanel messages={lobby?.chat ?? []} onSend={sendChatMessage} />
            </div>
          </div>
        ) : (
          <div className="trebuchet-controls retro-pad" style={{ ['--team' as never]: teamHex }}>
            <div className="retro-pad-shell">
              {/* Console brand + status LED strip */}
              <div className="retro-pad-brand">
                <span className={myTurn ? 'retro-led on' : 'retro-led'} aria-hidden="true" />
                <span className="retro-pad-name">COUCH.GG</span>
                <span className="retro-pad-model" aria-hidden="true">TREB-01</span>
              </div>

              <div className={myTurn ? 'turn-card active' : 'turn-card'}>
                <span className="turn-led" aria-hidden="true" />
                <span className="turn-state">{myTurn ? 'YOUR TURN' : 'WAITING'}</span>
                <strong>{turnName(snapshot, currentTurn)}</strong>
              </div>

              {/* AIM: D-pad arrows + segmented LED elevation meter */}
              <div className="aim-block" aria-label="Trebuchet aim controls">
                <div className="aim-headline">
                  <span className="aim-side-label">
                    <Crosshair size={14} /> {aiming.side === 'left' ? 'Firing LEFT' : 'Firing RIGHT'}
                  </span>
                  <span className="aim-elev-label">
                    <strong>{aiming.elevation}°</strong> elevation
                  </span>
                </div>

                <div className="aim-pad">
                  <button
                    type="button"
                    className="aim-btn dpad-btn dpad-up"
                    disabled={!myTurn || charging}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      startAimRepeat(1);
                    }}
                    onPointerUp={stopAimRepeat}
                    onPointerLeave={stopAimRepeat}
                    onPointerCancel={stopAimRepeat}
                    aria-label="Aim left"
                  >
                    <ChevronLeft size={30} />
                  </button>

                  <div
                    ref={gaugeRef}
                    className={`elev-gauge${myTurn && !charging ? '' : ' disabled'} side-${aiming.side}`}
                    role="slider"
                    aria-label="Elevation"
                    aria-valuemin={ELEV_MIN}
                    aria-valuemax={ELEV_MAX}
                    aria-valuenow={aiming.elevation}
                    aria-valuetext={`${aiming.elevation} degrees, firing ${aiming.side}`}
                    aria-orientation="vertical"
                    tabIndex={myTurn && !charging ? 0 : -1}
                    onPointerDown={onGaugePointerDown}
                    onPointerMove={onGaugePointerMove}
                    onPointerUp={onGaugePointerUp}
                    onPointerCancel={onGaugePointerUp}
                    onKeyDown={(e) => {
                      if (!myTurn || charging) return;
                      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
                        e.preventDefault();
                        aimStepBy(aiming.side === 'left' ? -1 : 1, aimStep);
                      } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
                        e.preventDefault();
                        aimStepBy(aiming.side === 'left' ? 1 : -1, aimStep);
                      }
                    }}
                  >
                    <div className="elev-segments" aria-hidden="true" />
                    <div className="elev-fill" style={{ height: `${aiming.fillPct}%` }} />
                    <div className="elev-needle" style={{ bottom: `${aiming.fillPct}%` }}>
                      <span className="elev-needle-val">{aiming.elevation}°</span>
                    </div>
                    <span className="elev-tick top">{ELEV_MAX}°</span>
                    <span className="elev-tick bottom">{ELEV_MIN}°</span>
                    <span className="elev-hint">drag</span>
                  </div>

                  <button
                    type="button"
                    className="aim-btn dpad-btn dpad-down"
                    disabled={!myTurn || charging}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      startAimRepeat(-1);
                    }}
                    onPointerUp={stopAimRepeat}
                    onPointerLeave={stopAimRepeat}
                    onPointerCancel={stopAimRepeat}
                    aria-label="Aim right"
                  >
                    <ChevronRight size={30} />
                  </button>
                </div>

                <div className="aim-foot">
                  <span className="aim-arc-text">ARC {aiming.side === 'left' ? '◄' : '►'} {angle}°</span>
                  <button
                    type="button"
                    className="step-toggle"
                    onClick={() => setAimStep((value) => (value === 1 ? 5 : 1))}
                    aria-label={`Aim step ${aimStep} degrees, tap to toggle`}
                  >
                    Step {aimStep}°
                  </button>
                </div>
              </div>

              {/* CHARGE + FIRE: big round A button (+ decorative B label) */}
              <div className="action-row">
                <button
                  className={`fire-btn${charging ? ' charging' : ''}${atFull ? ' full' : ''}`}
                  disabled={!myTurn}
                  onPointerDown={beginCharge}
                  onPointerUp={() => void releaseCharge()}
                  onPointerCancel={cancelCharge}
                  onPointerLeave={() => {
                    if (charging) void releaseCharge();
                  }}
                  onContextMenu={(e) => e.preventDefault()}
                  aria-label={charging ? 'Release to fire' : 'Hold to charge and fire'}
                >
                  <span className="fire-fill" style={{ width: `${power}%` }} aria-hidden="true" />
                  <span className="fire-content">
                    <span className="fire-ab" aria-hidden="true">A</span>
                    <Flame size={22} />
                    <span className="fire-label">{charging ? 'RELEASE TO FIRE' : 'HOLD TO CHARGE'}</span>
                    <span className="fire-power">{power}%</span>
                  </span>
                </button>
              </div>

              {lastEvent?.type === 'shot' ? (
                <p className="muted last-shot">Last shot: {lastEvent.power}% at {lastEvent.angle}°</p>
              ) : null}
            </div>
          </div>
        )}

        <button
          className="text-btn"
          onClick={() => {
            window.localStorage.removeItem(tokenKey(slug));
            window.localStorage.removeItem('couch:activeSlug');
            navigate('/');
          }}
        >
          <LogOut size={16} /> Leave
        </button>
      </section>
      {shareRoomOpen ? (
        <div className="room-share-backdrop" role="dialog" aria-modal="true" aria-labelledby="room-share-title">
          <section className="room-share-modal">
            <div className="brand-row small">
              <span className="brand-mark">c</span>
              <span>Remote Couch</span>
            </div>
            <h2 id="room-share-title">Share Room Number</h2>
            <p>Send this room number to the other players. They scan Remote Couch on their own screen, tap Join Game, and enter it.</p>
            <div className="room-share-code" aria-label="Remote room code">{slug}</div>
            <button className="primary-btn wide" type="button" onClick={shareRoomNumber}>
              {shareCopied ? <Check size={18} /> : <Share2 size={18} />}
              {shareCopied ? 'Copied!' : 'Share Room Number'}
            </button>
            <button className="ghost-btn wide" type="button" onClick={dismissRoomShare}>
              Done
            </button>
          </section>
        </div>
      ) : null}
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

function defaultAimForUnit(unit: Pick<TrebuchetUnit, 'x'>): number {
  return unit.x > WORLD_W / 2 ? 180 - DEFAULT_AIM_ELEVATION : DEFAULT_AIM_ELEVATION;
}

// Guarded haptics: no-op when the device/browser does not support vibration.
function haptic(pattern: number | number[]): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern);
    }
  } catch {
    // Some browsers throw if called without a user gesture; ignore.
  }
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
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

type ArcInfo = {
  side: 'left' | 'right';
  elevation: number;
  fillPct: number;
};

// Resolve a raw angle into the side, elevation-above-horizon, and a 0-100% fill
// where 0% = ELEV_MIN (flattest valid) and 100% = ELEV_MAX (steepest).
function arcInfo(angle: number): ArcInfo {
  const right = angle <= RIGHT_HI;
  const elevation = right ? angle : 180 - angle;
  const span = ELEV_MAX - ELEV_MIN || 1;
  const fillPct = clamp01((elevation - ELEV_MIN) / span) * 100;
  return { side: right ? 'right' : 'left', elevation, fillPct };
}
