import { useCallback, useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import type { GameInputEnvelope, Lobby } from '@couch/types';

/**
 * Strict-ordered input forwarding for external (iframe-hosted) games.
 *
 * Two sources feed the same monotonic `seq` stream:
 *   (a) socket `'game:input'` events — instant. With the Redis adapter they
 *       reach every instance; without it (local dev, no REDIS_URL) only
 *       sockets on the emitting instance. Can arrive out of order.
 *   (b) `lobby.inputLog` from each poll snapshot — the AUTHORITY. Persisted
 *       server-side (last 64 envelopes in the public view), so any socket gap
 *       that never fills is resolved on the next 750ms poll.
 *
 * We forward strictly in `seq` order via `onInput`:
 *   - `seq === last + 1` is delivered immediately.
 *   - Out-of-order socket arrivals are buffered in a small map keyed by seq and
 *     drained as the sequence fills in.
 *   - Each new inputLog scan delivers any still-missing range in order from the
 *     log (socket gaps resolve here). The log is authoritative for its window.
 *
 * FIRST-DELIVERY / TRIM edge: `lastForwardedSeq` starts at 0. If the first log
 * we ever see has already been trimmed (its oldest entry's `seq > 1`), we cannot
 * replay the missing prefix — it's gone from the public window. We fast-forward:
 * jump `lastForwardedSeq` to just before the log's oldest entry and deliver the
 * whole available window in order. External games are deterministic from
 * `seed` + the ordered input log; a game that joins mid-session (or whose early
 * inputs were trimmed) starts from the earliest inputs it can actually see. This
 * only happens when >64 inputs occurred before the first successful poll, which
 * is not a realistic path for a freshly-started session but is handled for
 * robustness. The buffer is reset whenever the game session restarts so a new
 * round always begins its own seq stream from scratch.
 *
 * GAP POLL: while inputs wait on a missing seq, `onGap` is called every
 * GAP_POLL_MS. The missing input is in the log, and the regular poll may be
 * slow (it is while the socket carries every change), so the caller polls now.
 *
 * GAP SKIP: seqs are allocated before they are written, so an instance that dies
 * between the two leaves a hole that never fills. When the authoritative log
 * already holds later inputs but still not the missing seq for GAP_SKIP_MS, we
 * give up on it and deliver from the next available seq instead of stalling.
 */

export type InputSource = 'socket' | 'poll';

const GAP_POLL_MS = 400;
const GAP_SKIP_MS = 1_500;

export interface UseExternalGameInputsOptions {
  /** The lobby socket (may be null before it connects). */
  socket: Socket | null;
  /** Latest lobby snapshot (its `inputLog` is the authority + poll fallback). */
  lobby: Lobby | null;
  /** Called once per input, strictly in ascending `seq` order, exactly once. */
  onInput: (input: GameInputEnvelope, source: InputSource) => void;
  /** Called while inputs wait on a missing seq (see GAP POLL). */
  onGap?: () => void;
}

/**
 * A stable identity for "this game session run". When it changes we reset the
 * forwarding cursor so a restart/new-game begins its own seq stream at 0.
 * gameSession.startedAt distinguishes two runs of the same gameId.
 */
function sessionKey(lobby: Lobby | null): string {
  if (!lobby) return '';
  return `${lobby.currentGameId ?? ''}::${lobby.gameSession?.startedAt ?? ''}`;
}

export function useExternalGameInputs({ socket, lobby, onInput, onGap }: UseExternalGameInputsOptions): void {
  const lastForwardedSeqRef = useRef(0);
  // Out-of-order socket arrivals held until the sequence fills in.
  const pendingRef = useRef<Map<number, { input: GameInputEnvelope; source: InputSource }>>(new Map());
  // The missing seq we are waiting on, and since when the log has shown it lost.
  const gapRef = useRef<{ seq: number; since: number } | null>(null);
  const sessionKeyRef = useRef<string>(sessionKey(lobby));
  // Keep the latest onInput without re-subscribing the socket listener.
  const onInputRef = useRef(onInput);
  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);
  const onGapRef = useRef(onGap);
  useEffect(() => {
    onGapRef.current = onGap;
  }, [onGap]);
  const gapTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (gapTimerRef.current != null) window.clearTimeout(gapTimerRef.current);
    },
    []
  );

  const resetCursor = useCallback(() => {
    lastForwardedSeqRef.current = 0;
    pendingRef.current.clear();
    gapRef.current = null;
  }, []);

  /**
   * Deliver as many contiguous inputs as possible starting at last+1, draining
   * the pending buffer. Safe to call from either source.
   */
  const drainPending = useCallback(() => {
    const pending = pendingRef.current;
    let next = pending.get(lastForwardedSeqRef.current + 1);
    while (next) {
      pending.delete(next.input.seq);
      lastForwardedSeqRef.current = next.input.seq;
      onInputRef.current(next.input, next.source);
      next = pending.get(lastForwardedSeqRef.current + 1);
    }
    // Anything still pending waits on a missing seq (GAP POLL).
    if (pending.size === 0 || gapTimerRef.current != null) return;
    const askForLog = () => {
      gapTimerRef.current = null;
      if (pendingRef.current.size === 0) return;
      onGapRef.current?.();
      gapTimerRef.current = window.setTimeout(askForLog, GAP_POLL_MS);
    };
    gapTimerRef.current = window.setTimeout(askForLog, GAP_POLL_MS);
  }, []);

  /** Buffer or immediately deliver a single envelope (socket path). */
  const ingest = useCallback(
    (input: GameInputEnvelope) => {
      if (typeof input?.seq !== 'number') return;
      // Already forwarded (duplicate from socket + log, or a late replay).
      if (input.seq <= lastForwardedSeqRef.current) return;
      pendingRef.current.set(input.seq, { input, source: 'socket' });
      drainPending();
    },
    [drainPending]
  );

  // (a) Socket source. Re-subscribe only when the socket instance changes.
  useEffect(() => {
    if (!socket) return;
    const handler = (envelope: GameInputEnvelope) => ingest(envelope);
    socket.on('game:input', handler);
    return () => {
      socket.off('game:input', handler);
    };
  }, [socket, ingest]);

  // Session-restart detection: reset the cursor before processing a new log.
  const currentKey = sessionKey(lobby);
  if (currentKey !== sessionKeyRef.current) {
    sessionKeyRef.current = currentKey;
    resetCursor();
  }

  // (b) inputLog poll scan — the authority. Runs on every lobby update.
  useEffect(() => {
    const log = lobby?.inputLog;
    if (!log || log.length === 0) return;

    // The log is a ring buffer of the last N envelopes, ascending by seq.
    // Feed anything the socket may have missed into the same ordered pipeline.
    for (const envelope of log) {
      if (typeof envelope?.seq !== 'number') continue;
      if (envelope.seq <= lastForwardedSeqRef.current) continue;
      if (!pendingRef.current.has(envelope.seq)) pendingRef.current.set(envelope.seq, { input: envelope, source: 'poll' });
    }

    // FIRST-DELIVERY / TRIM fast-forward: if we've forwarded nothing yet and the
    // log's oldest visible seq is already past 1, the prefix was trimmed and is
    // unrecoverable. Jump the cursor to just before the oldest visible entry so
    // the whole available window drains in order (see module doc).
    if (lastForwardedSeqRef.current === 0) {
      let oldest = Infinity;
      for (const envelope of log) {
        if (typeof envelope?.seq === 'number' && envelope.seq < oldest) oldest = envelope.seq;
      }
      if (oldest !== Infinity && oldest > 1) {
        lastForwardedSeqRef.current = oldest - 1;
      }
    }

    drainPending();

    // GAP SKIP (see module doc): the log is past the hole and still lacks it.
    const missing = lastForwardedSeqRef.current + 1;
    const logHasLater = log.some((envelope) => envelope.seq > missing);
    if (pendingRef.current.size > 0 && logHasLater) {
      const now = Date.now();
      if (gapRef.current?.seq !== missing) {
        gapRef.current = { seq: missing, since: now };
      } else if (now - gapRef.current.since >= GAP_SKIP_MS) {
        lastForwardedSeqRef.current = Math.min(...pendingRef.current.keys()) - 1;
        gapRef.current = null;
        drainPending();
      }
    } else {
      gapRef.current = null;
    }
    // Depend on the newest seq (and length) so identical repeated snapshots
    // don't re-run needlessly, but every genuinely-new input triggers a scan.
  }, [lobby?.inputLog, drainPending]);
}
