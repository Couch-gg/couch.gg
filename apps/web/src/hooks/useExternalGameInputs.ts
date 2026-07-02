import { useCallback, useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import type { GameInputEnvelope, Lobby } from '@couch/types';

/**
 * Strict-ordered input forwarding for external (iframe-hosted) games.
 *
 * Two sources feed the same monotonic `seq` stream:
 *   (a) socket `'game:input'` events — instant, same-instance, but can arrive
 *       out of order or be dropped entirely (cross-instance, Vercel has no
 *       Socket.IO adapter).
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
 */

export interface UseExternalGameInputsOptions {
  /** The lobby socket (may be null before it connects). */
  socket: Socket | null;
  /** Latest lobby snapshot (its `inputLog` is the authority + poll fallback). */
  lobby: Lobby | null;
  /** Called once per input, strictly in ascending `seq` order, exactly once. */
  onInput: (input: GameInputEnvelope) => void;
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

export function useExternalGameInputs({ socket, lobby, onInput }: UseExternalGameInputsOptions): void {
  const lastForwardedSeqRef = useRef(0);
  // Out-of-order socket arrivals held until the sequence fills in.
  const pendingRef = useRef<Map<number, GameInputEnvelope>>(new Map());
  const sessionKeyRef = useRef<string>(sessionKey(lobby));
  // Keep the latest onInput without re-subscribing the socket listener.
  const onInputRef = useRef(onInput);
  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);

  const resetCursor = useCallback(() => {
    lastForwardedSeqRef.current = 0;
    pendingRef.current.clear();
  }, []);

  /**
   * Deliver as many contiguous inputs as possible starting at last+1, draining
   * the pending buffer. Safe to call from either source.
   */
  const drainPending = useCallback(() => {
    const pending = pendingRef.current;
    let next = pending.get(lastForwardedSeqRef.current + 1);
    while (next) {
      pending.delete(next.seq);
      lastForwardedSeqRef.current = next.seq;
      onInputRef.current(next);
      next = pending.get(lastForwardedSeqRef.current + 1);
    }
  }, []);

  /** Buffer or immediately deliver a single envelope (socket path). */
  const ingest = useCallback(
    (input: GameInputEnvelope) => {
      if (typeof input?.seq !== 'number') return;
      // Already forwarded (duplicate from socket + log, or a late replay).
      if (input.seq <= lastForwardedSeqRef.current) return;
      pendingRef.current.set(input.seq, input);
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
      pendingRef.current.set(envelope.seq, envelope);
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
    // Depend on the newest seq (and length) so identical repeated snapshots
    // don't re-run needlessly, but every genuinely-new input triggers a scan.
  }, [lobby?.inputLog, drainPending]);
}
