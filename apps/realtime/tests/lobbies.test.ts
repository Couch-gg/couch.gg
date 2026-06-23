import { describe, expect, it } from 'vitest';
import { LobbyStore } from '../src/lobbies.js';

describe('LobbyStore', () => {
  it('creates a lobby and makes the first controller host', () => {
    const store = new LobbyStore();
    const lobby = store.createLobby();
    const joined = store.joinPlayer(lobby.slug, 'Alex');

    expect(joined.lobby.slug).toBe(lobby.slug);
    expect(joined.player.isHost).toBe(true);
    expect(joined.lobby.players[0].name).toBe('Alex');
  });

  it('starts Trebuchet only with host token and enough players', () => {
    const store = new LobbyStore();
    const lobby = store.createLobby();
    const host = store.joinPlayer(lobby.slug, 'Alex');
    const guest = store.joinPlayer(lobby.slug, 'Bea');

    expect(() => store.startGame(lobby.slug, 'wrong-token')).toThrow(/Host|Controller/);
    const event = store.startGame(lobby.slug, host.playerToken);

    expect(guest.player.isHost).toBe(false);
    expect(event.snapshot.phase).toBe('running');
    expect(store.publicLobby(lobby.slug).state).toBe('playing');
  });

  it('reconnects with the same player token', () => {
    const store = new LobbyStore();
    const lobby = store.createLobby();
    const first = store.joinPlayer(lobby.slug, 'Alex');
    store.markDisconnected(lobby.slug, first.player.id, 10);
    const second = store.joinPlayer(lobby.slug, 'Alex 2', first.playerToken);

    expect(second.player.id).toBe(first.player.id);
    expect(second.player.connected).toBe(true);
    expect(second.lobby.players).toHaveLength(1);
  });
});
