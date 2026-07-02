import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { ExternalGameManifest, ExternalGameSnapshot, GameInputEnvelope, Lobby, Player } from '@couch/types';
import type {
  CouchGameToHostMessage,
  CouchHostToGameMessage,
  CouchInitMessage,
  CouchManifest,
  CouchPlayer,
  CouchScore
} from '@couch/game-sdk';
import { emitAck } from '../socket.js';

// ---------------------------------------------------------------------------
// Public prop surface
// ---------------------------------------------------------------------------

/**
 * A lifecycle signal surfaced to the parent (used by the future /dev test page
 * in place of the live socket/probe side effects).
 */
export interface GameHostEvent {
  kind: 'ready' | 'error' | 'gameOver';
  detail?: unknown;
}

/**
 * Imperative handle exposed via ref. LobbyRoute wires `useExternalGameInputs`'s
 * `onInput` straight to `forwardInput`, keeping the seq-ordering hook and the
 * postMessage bridge as separate, independently-testable pieces.
 */
export interface GameHostStageHandle {
  /** Forward one already-ordered input envelope into the iframe. */
  forwardInput: (envelope: GameInputEnvelope) => void;
}

export interface GameHostStageProps {
  /** The external game to embed. */
  manifest: ExternalGameManifest;
  /** Latest lobby snapshot — source of players, seed, and mode. */
  lobby: Lobby;
  /**
   * The lobby socket, used to authorize the `game:finish` report in live mode.
   * Optional: `mode:'test'` never touches it (reports via `onEvent`).
   */
  socket?: Socket | null;
  /**
   * `'live'` = a real couch: probe-result + `game:finish` fire.
   * `'test'` = the /dev harness: probe + finish are SKIPPED; everything is
   * surfaced through `onEvent` so the test page owns the side effects.
   */
  mode: 'live' | 'test';
  /** Lifecycle callback (fires in both modes; the only channel in test mode). */
  onEvent?: (event: GameHostEvent) => void;
}

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

/** How long to wait for `couch:ready` before showing the "didn't respond" overlay. */
const READY_TIMEOUT_MS = 15_000;
/** Max serialized inbound message size we accept (bytes-ish, via string length). */
const MAX_INBOUND_BYTES = 8_192;
/** Inbound rate cap: drop messages beyond this many per rolling second. */
const MAX_INBOUND_PER_SEC = 60;

const API_BASE = (() => {
  // Mirror api.ts URL resolution without importing its internals: probe-result
  // is fire-and-forget and must not couple to the typed fetch helpers.
  const isBrowser = typeof window !== 'undefined';
  const isLocalDevHost =
    isBrowser && ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname);
  const fallback = !isBrowser
    ? 'http://localhost:4100'
    : isLocalDevHost
      ? `${window.location.protocol}//${window.location.hostname}:4100`
      : window.location.origin;
  const base = (import.meta.env.VITE_REALTIME_URL as string | undefined) || fallback;
  const prefix =
    (import.meta.env.VITE_REALTIME_API_PREFIX as string | undefined) ||
    (isLocalDevHost ? '/api' : '/api/realtime');
  return `${base}${prefix}`;
})();

/** Map a platform Player to the creator-facing CouchPlayer. */
function toCouchPlayer(player: Player): CouchPlayer {
  return {
    id: player.id,
    name: player.name,
    colorIdx: player.colorIdx,
    connected: player.connected
  };
}

/** aspectRatio '16:9' | '4:3' -> numeric ratio for letterboxing math. */
function ratioValue(aspectRatio: ExternalGameManifest['aspectRatio']): number {
  return aspectRatio === '4:3' ? 4 / 3 : 16 / 9;
}

/** Normalize whatever the game reported as scores into CouchScore[]. */
function normalizeScores(raw: unknown): CouchScore[] {
  if (!Array.isArray(raw)) return [];
  const out: CouchScore[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === 'object') {
      const e = entry as { playerId?: unknown; score?: unknown };
      if (typeof e.playerId === 'string' && typeof e.score === 'number') {
        out.push({ playerId: e.playerId, score: e.score });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const GameHostStage = forwardRef<GameHostStageHandle, GameHostStageProps>(function GameHostStage(
  { manifest, lobby, socket, mode, onEvent },
  ref
) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const [ready, setReady] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Refs so the single message listener never needs to re-subscribe.
  const initializedRef = useRef(false); // sent couch:init at least once
  const readyRef = useRef(false);
  const finishedRef = useRef(false); // game:finish sent (idempotent guard)
  const probedRef = useRef(false); // probe-result sent (once)
  const knownPlayersRef = useRef<Map<string, CouchPlayer>>(new Map());

  const modeRef = useRef(mode);
  const socketRef = useRef<Socket | null | undefined>(socket);
  const onEventRef = useRef(onEvent);
  const manifestRef = useRef(manifest);
  const lobbyRef = useRef(lobby);
  useEffect(() => {
    modeRef.current = mode;
    socketRef.current = socket;
    onEventRef.current = onEvent;
    manifestRef.current = manifest;
    lobbyRef.current = lobby;
  }, [mode, socket, onEvent, manifest, lobby]);

  // --- Outbound: post a typed host->game message into the iframe. ---
  // targetOrigin is '*' by design: the sandbox origin is opaque, so a specific
  // origin is silently dropped. Bridge payloads never carry secrets.
  const post = useCallback((message: CouchHostToGameMessage) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(message, '*');
  }, []);

  // --- probe-result: fire-and-forget, swallow ALL errors (endpoint may 404). ---
  const sendProbeResult = useCallback((ok: boolean) => {
    if (modeRef.current === 'test') return; // /dev harness reports via onEvent
    if (probedRef.current) return;
    probedRef.current = true;
    try {
      void fetch(`${API_BASE}/games/${manifestRef.current.id}/probe-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: lobbyRef.current.slug, ok })
      }).catch(() => {
        /* endpoint arrives a later wave; ignore */
      });
    } catch {
      /* never throw out of a lifecycle path */
    }
  }, []);

  // --- Build & send couch:init (idempotent; SDK ignores duplicate inits). ---
  const sendInit = useCallback(() => {
    const l = lobbyRef.current;
    const players = l.players.map(toCouchPlayer);
    // Seed the roster-diff baseline so we don't emit spurious join deltas.
    knownPlayersRef.current = new Map(players.map((p) => [p.id, p]));
    const latencyTier = l.mode === 'remote' ? 'remote' : 'local';
    const init: CouchInitMessage = {
      v: 1,
      type: 'couch:init',
      protocol: 1,
      mode: modeRef.current,
      manifest: manifestRef.current as unknown as CouchManifest,
      players,
      seed:
        (l.gameSession?.snapshot as ExternalGameSnapshot | undefined)?.seed ?? '',
      locale: typeof navigator !== 'undefined' ? navigator.language : 'en',
      reducedMotion:
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
          : false,
      latencyTier
    };
    initializedRef.current = true;
    post(init);
  }, [post]);

  // --- Inbound message handling (single listener, identity + shape + rate). ---
  useEffect(() => {
    let windowStart = Date.now();
    let windowCount = 0;

    const onMessage = (e: MessageEvent) => {
      // Identity check: the sandbox origin is opaque, so we authenticate the
      // sender by window identity — accept ONLY messages whose source is this
      // iframe's own contentWindow.
      const fromGame = iframeRef.current != null && e.source === iframeRef.current.contentWindow;
      if (!fromGame) return;

      // Shape guard: { v:1, type: 'couch:*' }.
      const data = e.data as { v?: unknown; type?: unknown } | null;
      if (!data || typeof data !== 'object') return;
      if (data.v !== 1) return;
      if (typeof data.type !== 'string' || !data.type.startsWith('couch:')) return;

      // Size guard (serialize once; drop oversized).
      let serialized: string;
      try {
        serialized = JSON.stringify(e.data);
      } catch {
        return;
      }
      if (serialized.length > MAX_INBOUND_BYTES) return;

      // Rate guard: rolling 1s window.
      const now = Date.now();
      if (now - windowStart >= 1_000) {
        windowStart = now;
        windowCount = 0;
      }
      windowCount += 1;
      if (windowCount > MAX_INBOUND_PER_SEC) return;

      handleGameMessage(data as CouchGameToHostMessage);
    };

    const handleGameMessage = (msg: CouchGameToHostMessage) => {
      switch (msg.type) {
        case 'couch:hello': {
          // Repeated hellos are expected (late-listener retry); re-send init.
          sendInit();
          break;
        }
        case 'couch:ready': {
          if (!readyRef.current) {
            readyRef.current = true;
            setReady(true);
            setTimedOut(false);
            sendProbeResult(true);
            onEventRef.current?.({ kind: 'ready' });
          }
          break;
        }
        case 'couch:gameOver': {
          const scores = normalizeScores((msg as { scores?: unknown }).scores);
          onEventRef.current?.({ kind: 'gameOver', detail: { scores } });
          if (modeRef.current === 'test') break; // /dev owns the finish
          if (finishedRef.current) break;
          finishedRef.current = true;
          const sock = socketRef.current;
          if (sock) {
            // Screen sockets are authorized server-side; fire-and-forget.
            void emitAck(sock, 'game:finish', { slug: lobbyRef.current.slug, scores }).catch(() => {
              /* server logs; nothing to do client-side */
            });
          }
          break;
        }
        case 'couch:error': {
          const message = String((msg as { message?: unknown }).message ?? 'Game reported an error');
          setToast(message);
          onEventRef.current?.({ kind: 'error', detail: message });
          // eslint-disable-next-line no-console
          console.warn('[GameHostStage] game error:', message);
          break;
        }
        default:
          break;
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [sendInit, sendProbeResult]);

  // --- Ready timeout: no couch:ready within 15s -> error overlay + probe fail. ---
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!readyRef.current) {
        setTimedOut(true);
        sendProbeResult(false);
        onEventRef.current?.({ kind: 'error', detail: 'ready-timeout' });
      }
    }, READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [sendProbeResult]);

  // --- Auto-dismiss the error toast. ---
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4_000);
    return () => window.clearTimeout(t);
  }, [toast]);

  // --- Roster sync: diff by id on every lobby.players change. ---
  useEffect(() => {
    if (!initializedRef.current) return; // wait until the game has been init'd
    const next = new Map(lobby.players.map((p) => [p.id, toCouchPlayer(p)]));
    const prev = knownPlayersRef.current;

    let changed = prev.size !== next.size;
    if (!changed) {
      for (const [id, p] of next) {
        const before = prev.get(id);
        if (!before || before.connected !== p.connected || before.name !== p.name || before.colorIdx !== p.colorIdx) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return;

    // Full replacement first (authoritative), then deltas for join/leave.
    post({ v: 1, type: 'couch:players', players: [...next.values()] });
    for (const [id, p] of next) {
      if (!prev.has(id)) post({ v: 1, type: 'couch:playerJoined', player: p });
    }
    for (const id of prev.keys()) {
      if (!next.has(id)) post({ v: 1, type: 'couch:playerLeft', playerId: id });
    }
    knownPlayersRef.current = next;
  }, [lobby.players, post]);

  // --- visibilitychange -> pause/resume. ---
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        post({ v: 1, type: 'couch:pause', reason: 'host-hidden' });
      } else {
        post({ v: 1, type: 'couch:resume' });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [post]);

  // --- Teardown: abort on unmount. ---
  useEffect(() => {
    return () => {
      post({ v: 1, type: 'couch:abort', reason: 'host-unmounted' });
    };
  }, [post]);

  // --- Imperative input forwarding, called by the parent hook via ref. ---
  // The SDK expects `at` as a ms NUMBER, so convert the envelope's ISO string
  // via Date.parse before posting the couch:input message.
  const forwardInput = useCallback(
    (envelope: GameInputEnvelope) => {
      post({
        v: 1,
        type: 'couch:input',
        input: {
          seq: envelope.seq,
          at: Date.parse(envelope.at),
          playerId: envelope.playerId,
          control: envelope.control,
          action: envelope.action,
          value: envelope.value
        }
      });
    },
    [post]
  );

  // Expose the forwarder to the parent via ref (wired to useExternalGameInputs).
  useImperativeHandle(ref, () => ({ forwardInput }), [forwardInput]);

  const ratio = ratioValue(manifest.aspectRatio);

  return (
    <div
      className="game-host-stage"
      data-testid="game-host-stage"
      data-ready={ready ? 'true' : 'false'}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#000',
        overflow: 'hidden'
      }}
    >
      <style>{`
        @keyframes couch-host-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
      `}</style>

      {/* Letterboxed iframe: constrained to the game's aspect ratio inside the
          black parent. The sandbox grants scripts only (no same-origin token),
          so the frame origin stays opaque and the bridge is identity-validated. */}
      <iframe
        ref={iframeRef}
        title={manifest.title}
        src={manifest.entryUrl}
        sandbox="allow-scripts"
        allow="autoplay"
        referrerPolicy="no-referrer"
        style={{
          border: 0,
          display: 'block',
          background: '#000',
          // Fit inside the parent while preserving the game ratio.
          maxWidth: '100%',
          maxHeight: '100%',
          width: `min(100%, calc(100vh * ${ratio}))`,
          aspectRatio: manifest.aspectRatio === '4:3' ? '4 / 3' : '16 / 9'
        }}
      />

      {/* Loading overlay — retro styled inline, hidden once ready. */}
      {!ready && !timedOut && (
        <div
          data-testid="game-host-loading"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(4, 4, 12, 0.9)',
            color: '#e8e8ff',
            fontFamily: '"Press Start 2P", ui-monospace, monospace',
            fontSize: 'clamp(10px, 2vw, 16px)',
            letterSpacing: '0.08em',
            textAlign: 'center',
            padding: '1rem'
          }}
        >
          <span style={{ animation: 'couch-host-blink 1s steps(2, start) infinite' }}>
            Loading {manifest.title}…
          </span>
        </div>
      )}

      {/* Error overlay — game never handshook. Room continues around it. */}
      {timedOut && !ready && (
        <div
          data-testid="game-host-error"
          role="alert"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.75rem',
            background: 'rgba(12, 4, 4, 0.92)',
            color: '#ffd7d7',
            fontFamily: '"Press Start 2P", ui-monospace, monospace',
            fontSize: 'clamp(9px, 1.6vw, 13px)',
            lineHeight: 1.8,
            textAlign: 'center',
            padding: '1.5rem'
          }}
        >
          <strong style={{ color: '#ff9d9d' }}>This game didn’t respond.</strong>
          <span style={{ opacity: 0.85 }}>The room keeps going — pick another game.</span>
        </div>
      )}

      {/* Non-fatal error toast from couch:error. */}
      {toast && (
        <div
          data-testid="game-host-toast"
          role="status"
          style={{
            position: 'absolute',
            left: '50%',
            bottom: '1rem',
            transform: 'translateX(-50%)',
            background: 'rgba(20, 10, 10, 0.92)',
            color: '#ffd7d7',
            border: '1px solid rgba(255, 120, 120, 0.4)',
            borderRadius: '6px',
            padding: '0.5rem 0.9rem',
            fontFamily: 'ui-monospace, monospace',
            fontSize: '12px',
            maxWidth: '80%',
            pointerEvents: 'none'
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
});
