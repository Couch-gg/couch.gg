import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { ExternalGameManifest, Lobby } from '@couch/types';
import type { TrebuchetSnapshot } from '@couch/trebuchet';
import {
  LobbyStore,
  cloneLobbyRecord,
  deserializeLobbyRecord,
  nextLobbyRev,
  serializeLobbyRecord
} from '../src/lobbies.js';
import { createRealtimeServer, type RealtimeServerInstance } from '../src/index.js';

const PAD: ExternalGameManifest = {
  id: 'rev-pad',
  title: 'Rev Pad',
  description: 'Test game.',
  minPlayers: 1,
  maxPlayers: 4,
  controllerLayout: { kind: 'generic-buttons', controls: [{ control: 'a', type: 'button', label: 'A' }] },
  aspectRatio: '16:9',
  estimatedDurationMinutes: 1,
  status: 'published',
  origin: 'external',
  entryUrl: 'https://games.example.com/pad/',
  supportsRemote: true,
  sdkProtocol: 1,
  publishedAt: '2026-10-01T00:00:00.000Z',
  thumbnail: { kind: 'css', gradient: 'linear-gradient(#000,#111)', icon: 'Zap' }
};

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

  it('grows with every change and shows in the public lobby', () => {
    const store = new LobbyStore();
    const lobby = store.createLobby();
    expect(store.publicLobby(lobby).rev).toBe(0);
    store.markChanged(lobby);
    const first = store.publicLobby(lobby).rev!;
    store.markChanged(lobby);
    expect(store.publicLobby(lobby).rev).toBeGreaterThan(first);
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

describe('lobby rev on the wire (in memory)', () => {
  let instance: RealtimeServerInstance;
  let url = '';
  const sockets: Socket[] = [];
  const previousExternal = process.env.EXTERNAL_GAMES_JSON;

  beforeAll(async () => {
    process.env.EXTERNAL_GAMES_JSON = JSON.stringify([PAD]);
    instance = createRealtimeServer();
    await new Promise<void>((resolve) => instance.server.listen(0, resolve));
    url = `http://localhost:${(instance.server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    for (const socket of sockets) socket.disconnect();
    instance.io.close();
    if (previousExternal === undefined) delete process.env.EXTERNAL_GAMES_JSON;
    else process.env.EXTERNAL_GAMES_JSON = previousExternal;
  });

  function open(): Socket {
    const socket = connect(url, { transports: ['websocket'], forceNew: true });
    sockets.push(socket);
    return socket;
  }

  function ack<T>(socket: Socket, event: string, payload: unknown): Promise<T & { ok: boolean; error?: string }> {
    return new Promise((resolve) => socket.emit(event, payload, resolve));
  }

  const newLobby = (): Promise<Lobby> =>
    fetch(`${url}/api/lobbies`, { method: 'POST' })
      .then((r) => r.json())
      .then((b) => b.lobby);
  const poll = (slug: string): Promise<Lobby> =>
    fetch(`${url}/api/lobbies/${slug}`)
      .then((r) => r.json())
      .then((b) => b.lobby);

  it('grows with every write, in acks, pushes and polls alike, and only with writes', async () => {
    const created = await newLobby();
    const slug = created.slug;
    expect(created.rev).toBeGreaterThan(0);

    const tv = open();
    const pushed: Lobby[] = [];
    tv.on('lobby:snapshot', (lobby: Lobby) => pushed.push(lobby));
    const screen = await ack<{ lobby: Lobby }>(tv, 'screen:join', { slug, screenId: 'scr_revtv' });
    expect(screen.lobby.rev).toBeGreaterThan(created.rev!);

    const phone = open();
    const joined = await ack<{ lobby: Lobby; playerToken: string }>(phone, 'controller:join', { slug, name: 'Ann' });
    expect(joined.lobby.rev).toBeGreaterThan(screen.lobby.rev!);
    await expect.poll(() => pushed.at(-1)?.rev).toBe(joined.lobby.rev);

    // Polls change nothing, so the rev stays.
    expect((await poll(slug)).rev).toBe(joined.lobby.rev);
    expect((await poll(slug)).rev).toBe(joined.lobby.rev);

    const chat = await ack(phone, 'chat:send', { slug, playerToken: joined.playerToken, text: 'hi' });
    expect(chat.ok).toBe(true);
    const afterChat = await poll(slug);
    expect(afterChat.rev).toBeGreaterThan(joined.lobby.rev!);
    // A refused write changes nothing either.
    expect((await ack(phone, 'game:start', { slug, playerToken: joined.playerToken })).ok).toBe(false);
    expect((await poll(slug)).rev).toBe(afterChat.rev);
  });

  it('sends a controller update with the rev it was stored under', async () => {
    const { slug } = await newLobby();
    const tv = open();
    await ack(tv, 'screen:join', { slug, screenId: 'scr_revpad' });
    const phone = open();
    const host = await ack<{ playerToken: string; player: { id: string } }>(phone, 'controller:join', { slug, name: 'Ann' });
    await ack(phone, 'game:select', { slug, playerToken: host.playerToken, gameId: PAD.id });
    await ack(phone, 'game:start', { slug, playerToken: host.playerToken });
    const states: Array<{ rev: number }> = [];
    phone.on('controller:state', (message: { rev: number }) => states.push(message));

    const set = await ack(tv, 'screen:controller', { slug, playerId: host.player.id, patch: { labels: { a: 'Go' } } });
    expect(set.ok).toBe(true);
    await expect.poll(() => states.length).toBe(1);
    expect(states[0].rev).toBe((await poll(slug)).rev);
  });
});
