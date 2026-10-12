import type { Socket } from 'socket.io-client';
import type { FanoutMode, Lobby } from '@couch/types';
import { fetchLobby } from './api.js';

// The lobby poll backs up what the socket pushes. While the socket is
// connected to a server whose room emits reach every instance ('redis'
// fan-out), every change arrives as a push and the poll only catches what got
// lost, so it can take its time. Otherwise (no socket, or a server whose
// emits only reach its own instance's sockets) it is how changes made on
// other instances get here at all.
export const FAST_POLL_MS = 750;
export const SLOW_POLL_MS = 5_000;
// A poll asked for out of turn (pollNow) comes at least this long after the
// one before.
const MIN_POLL_GAP_MS = 250;

export interface LobbyPoll {
  // Poll soon, e.g. because something the socket should have brought is missing.
  pollNow(): void;
  stop(): void;
}

// Whether `next` is an older snapshot of the lobby than `current`. Pushes,
// polls and join acks race each other: a poll the server answered before a
// change can arrive after the change's push, and taking it would undo the
// change for a moment (a round that just started ends again, a phone's
// buttons come back). A snapshot with the same rev is the same lobby, so it is
// taken. One without a rev (a server from before revs, or a lobby one of them
// stored last) or of another lobby always is.
export function isOlderLobby(current: Lobby | null, next: Lobby): boolean {
  if (!current || current.id !== next.id) return false;
  return typeof current.rev === 'number' && typeof next.rev === 'number' && next.rev < current.rev;
}

// Poll the lobby until stopped. `fanout` is what the server said in the
// latest join ack (null before one, or since the socket dropped).
export function startLobbyPoll(options: {
  slug: string;
  socket: Socket | null;
  fanout: () => FanoutMode | null;
  onLobby: (lobby: Lobby) => void;
  // Poll right away instead of after the first interval.
  immediate?: boolean;
}): LobbyPoll {
  const { slug, socket, fanout, onLobby } = options;
  let stopped = false;
  let timer: number | undefined;
  let nextAt = 0;
  let lastAt = 0;

  const interval = () => (socket?.connected && fanout() === 'redis' ? SLOW_POLL_MS : FAST_POLL_MS);
  const schedule = (ms: number) => {
    window.clearTimeout(timer);
    nextAt = Date.now() + ms;
    timer = window.setTimeout(tick, ms);
  };
  function tick() {
    if (stopped) return;
    lastAt = Date.now();
    schedule(interval());
    void fetchLobby(slug)
      .then((lobby) => {
        if (!stopped) onLobby(lobby);
      })
      .catch(() => {
        // The next poll tries again.
      });
  }
  // Without the socket every change comes by poll: back to full speed now,
  // not after the rest of a slow wait.
  const onDisconnect = () => {
    if (nextAt - Date.now() > FAST_POLL_MS) schedule(FAST_POLL_MS);
  };
  socket?.on('disconnect', onDisconnect);

  if (options.immediate) tick();
  else schedule(FAST_POLL_MS);

  return {
    pollNow() {
      if (stopped) return;
      const due = Math.max(0, lastAt + MIN_POLL_GAP_MS - Date.now());
      if (Date.now() + due < nextAt) schedule(due);
    },
    stop() {
      stopped = true;
      window.clearTimeout(timer);
      socket?.off('disconnect', onDisconnect);
    }
  };
}
