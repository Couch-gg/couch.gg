import type { Lobby } from '@couch/types';

// Whether `next` is an older snapshot of the lobby than `current`. Pushes,
// polls and join acks race each other: a poll the server answered before a
// change can arrive after the change's push, and taking it would undo the
// change for a moment (a round that just started ends again, a phone's
// buttons come back). A snapshot with the same rev is the same lobby, so it is
// taken. One without a rev (a server from before revs) or of another lobby
// always is.
export function isOlderLobby(current: Lobby | null, next: Lobby): boolean {
  if (!current || current.id !== next.id) return false;
  return typeof current.rev === 'number' && typeof next.rev === 'number' && next.rev < current.rev;
}
