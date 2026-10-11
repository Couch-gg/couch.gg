import { describe, expect, it } from 'vitest';
import type { TrebuchetSnapshot } from '@couch/trebuchet';
import {
  LobbyStore,
  cloneLobbyRecord,
  deserializeLobbyRecord,
  nextLobbyRev,
  serializeLobbyRecord
} from '../src/lobbies.js';

// A running two-player Trebuchet round with one shot fired and recorded, the
// way the server stores it.
function shotFired() {
  const store = new LobbyStore();
  const { slug } = store.createLobby();
  const host = store.joinPlayer(slug, 'Alex');
  const guest = store.joinPlayer(slug, 'Bea');
  store.startGame(slug, host.playerToken);
  const turn = (store.publicLobby(slug).gameSession?.snapshot as TrebuchetSnapshot).turn;
  const token = turn === host.player.id ? host.playerToken : guest.playerToken;
  const event = store.fire(slug, token, 70, 80);
  expect(event).not.toBeNull();
  store.recordGameEvent(slug, event!);
  return { store, slug, host, guest };
}

describe('lobby rev', () => {
  it('never goes back, and never below the clock', () => {
    expect(nextLobbyRev(0, 1_000)).toBe(1_000);
    expect(nextLobbyRev(1_000, 1_000)).toBe(1_001);
    expect(nextLobbyRev(5_000, 1_000)).toBe(5_001);
  });

  it('grows with every change', () => {
    const store = new LobbyStore();
    const lobby = store.createLobby();
    expect(lobby.rev).toBe(0);
    store.markChanged(lobby);
    const first = lobby.rev;
    store.markChanged(lobby);
    expect(lobby.rev).toBeGreaterThan(first);
  });

  it('is stored first, so the commit script can read it off the front', () => {
    const store = new LobbyStore();
    const lobby = store.createLobby();
    store.markChanged(lobby);
    const json = JSON.stringify(serializeLobbyRecord(lobby));
    expect(json.startsWith(`{"rev":${lobby.rev},`)).toBe(true);
    expect(deserializeLobbyRecord(JSON.parse(json)).rev).toBe(lobby.rev);
  });

  it('reads as 0 from a lobby stored before revs existed', () => {
    const store = new LobbyStore();
    const { rev: _rev, ...legacy } = serializeLobbyRecord(store.createLobby());
    expect(deserializeLobbyRecord(legacy).rev).toBe(0);
  });

  it('keeps the newer lobby when an older read of it comes back late', () => {
    const store = new LobbyStore();
    const lobby = store.createLobby();
    store.markChanged(lobby);
    const older = cloneLobbyRecord(lobby);
    store.markChanged(lobby);
    expect(store.adopt(older)).toBe(lobby);
    expect(store.getLobby(lobby.slug)).toBe(lobby);

    const newer = cloneLobbyRecord(lobby);
    store.markChanged(newer);
    expect(store.adopt(newer)).toBe(newer);
    // A new lobby under the same slug replaces the old one whatever its rev.
    const other = { ...cloneLobbyRecord(lobby), id: 'lobby_other', rev: 1 };
    expect(store.adopt(other)).toBe(other);
  });

  it('takes what a read that started after the held lobby returns, even at a lower rev', () => {
    const store = new LobbyStore();
    const lobby = store.createLobby();
    store.markChanged(lobby);
    store.adopt(lobby);
    // A read that was under way when the lobby was taken: older.
    const early = store.readMark() - 1;
    expect(store.adopt({ ...cloneLobbyRecord(lobby), rev: 0 }, early)).toBe(lobby);
    // One that started after: a deploy without revs stored the lobby since.
    const legacy = { ...cloneLobbyRecord(lobby), rev: 0, name: 'Stored by an old deploy' };
    expect(store.adopt(legacy, store.readMark())).toBe(legacy);
    expect(store.getLobby(lobby.slug).name).toBe('Stored by an old deploy');
  });
});

describe('lobby copies', () => {
  it('share nothing a change could reach', () => {
    const { store, slug, host } = shotFired();
    const original = store.getLobby(slug);
    const before = JSON.stringify(serializeLobbyRecord(original));
    const copy = cloneLobbyRecord(original);
    store.lobbies.set(slug, copy);
    store.renamePlayer(slug, host.playerToken, 'Alexa');
    store.postChat(slug, host.playerToken, 'hi');
    store.leavePlayer(slug, host.playerToken);
    expect(JSON.stringify(serializeLobbyRecord(original))).toBe(before);
  });
});

describe('presence check', () => {
  it('says whether settling would change anything, without changing anything', () => {
    const store = new LobbyStore();
    const { slug } = store.createLobby();
    store.joinScreen(slug, 'scr_check', undefined, 'sock-tv', 0);
    const ann = store.joinPlayer(slug, 'Ann', undefined, undefined, 'sock-ann');
    expect(store.hasPresenceToSettle(slug, 10_000, 1_000, 1_000)).toBe(false);

    store.noteDropped(slug, ann.player.id, 'sock-ann', 5_000);
    expect(store.hasPresenceToSettle(slug, 5_500, 1_000, 1_000)).toBe(false);
    expect(store.hasPresenceToSettle(slug, 6_000, 1_000, 1_000)).toBe(true);
    expect(store.publicLobby(slug).players[0].connected).toBe(true);
    expect(store.markDroppedGone(slug, 6_000, 1_000)).toHaveLength(1);
    expect(store.hasPresenceToSettle(slug, 6_000, 1_000, 1_000)).toBe(false);

    store.markScreenLeft(slug, 'scr_check', 'sock-tv', 7_000);
    expect(store.hasPresenceToSettle(slug, 7_500, 1_000, 1_000)).toBe(false);
    expect(store.hasPresenceToSettle(slug, 8_000, 1_000, 1_000)).toBe(true);
    expect(store.dropGoneScreens(slug, 8_000, 1_000)).toBe(true);
    expect(store.hasPresenceToSettle(slug, 8_000, 1_000, 1_000)).toBe(false);
  });
});
