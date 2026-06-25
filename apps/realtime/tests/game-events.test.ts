import { describe, expect, it } from 'vitest';
import {
  LobbyStore,
  deserializeLobbyRecord,
  serializeLobbyRecord
} from '../src/lobbies.js';
import type { TrebuchetShotEvent } from '@couch/trebuchet';

// Build a started 2-player game and return the store, slug, and a token→playerId map
// so a test can fire as whichever player holds the current turn.
function startedGame() {
  const store = new LobbyStore();
  const lobby = store.createLobby();
  const host = store.joinPlayer(lobby.slug, 'Alex');
  const guest = store.joinPlayer(lobby.slug, 'Bea');
  store.startGame(lobby.slug, host.playerToken);
  const tokenByPlayer = new Map<string, string>([
    [host.player.id, host.playerToken],
    [guest.player.id, guest.playerToken]
  ]);
  return { store, slug: lobby.slug, tokenByPlayer };
}

// Fire as whoever owns the current turn so the engine actually produces a shot event.
function fireCurrentTurn(store: LobbyStore, slug: string, tokenByPlayer: Map<string, string>) {
  const turn = store.publicLobby(slug).gameSession?.snapshot.turn;
  expect(turn).toBeTruthy();
  const token = tokenByPlayer.get(turn as string);
  expect(token).toBeTruthy();
  const event = store.fire(slug, token as string, 70, 80);
  expect(event).not.toBeNull();
  return event!;
}

describe('LobbyStore game-event envelope', () => {
  it('records a fired shot into lobby.lastEvent with an incrementing seq', () => {
    const { store, slug, tokenByPlayer } = startedGame();

    const firstEvent = fireCurrentTurn(store, slug, tokenByPlayer);
    const firstSeq = store.recordGameEvent(slug, firstEvent);
    expect(firstSeq).toBe(1);

    const afterFirst = store.publicLobby(slug).lastEvent;
    expect(afterFirst).not.toBeNull();
    expect(afterFirst?.seq).toBe(1);
    expect(typeof afterFirst?.at).toBe('string');
    expect((afterFirst?.event as TrebuchetShotEvent).type).toBe('shot');

    // A second recorded event advances the seq monotonically. (recordGameEvent only
    // stamps the seq/timestamp; reusing the shot event keeps this deterministic and
    // independent of whether a live second shot would end the game.)
    const secondSeq = store.recordGameEvent(slug, firstEvent);
    expect(secondSeq).toBe(2);
    expect(store.publicLobby(slug).lastEvent?.seq).toBe(2);
  });

  it('round-trips lastEvent through serialize/deserialize', () => {
    const { store, slug, tokenByPlayer } = startedGame();
    const event = fireCurrentTurn(store, slug, tokenByPlayer);
    store.recordGameEvent(slug, event);

    const record = store.getLobby(slug);
    const restored = deserializeLobbyRecord(serializeLobbyRecord(record));

    expect(restored.lastEvent).not.toBeNull();
    expect(restored.lastEvent?.seq).toBe(1);
    expect((restored.lastEvent?.event as TrebuchetShotEvent).type).toBe('shot');
  });

  it('defaults lastEvent to null on a fresh lobby', () => {
    const store = new LobbyStore();
    const lobby = store.createLobby();
    expect(store.publicLobby(lobby.slug).lastEvent).toBeNull();
  });
});
