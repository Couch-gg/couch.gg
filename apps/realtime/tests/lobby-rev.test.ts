import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { ExternalGameManifest, Lobby } from '@couch/types';
import type { TrebuchetShotEvent, TrebuchetSnapshot } from '@couch/trebuchet';
import {
  LobbyStore,
  cloneLobbyRecord,
  deserializeLobbyRecord,
  nextLobbyRev,
  serializeLobbyRecord,
  withoutRepeatedSnapshot
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
    expect(nextLobbyRev(1_000, 1_000)).toBe(1_001);
    expect(nextLobbyRev(5_000, 1_000)).toBe(5_001);
    expect(nextLobbyRev(1_000, 3_000)).toBe(3_000);
  });

  it('starts well ahead of the clock after an unknown rev', () => {
    // Rev 0: a deploy from before revs stored the lobby last. Clients may hold
    // a rev from before that, handed out by an instance whose clock is ahead
    // of this one's: the next change must still read as newer.
    const seen = nextLobbyRev(1, 10_000 + 5_000);
    expect(nextLobbyRev(0, 10_000)).toBeGreaterThan(seen);
    expect(nextLobbyRev(nextLobbyRev(0, 10_000), 10_001)).toBe(nextLobbyRev(0, 10_000) + 1);
  });

  it('grows with every change and shows in the public lobby once known', () => {
    const store = new LobbyStore();
    const lobby = store.createLobby();
    // Not sent as 0: a client would take that for older than any rev it saw.
    expect(store.publicLobby(lobby)).not.toHaveProperty('rev');
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

  it('rebuild the Trebuchet engine only when a change needs it', () => {
    const { store, slug, host, guest } = shotFired();
    const restored = deserializeLobbyRecord(serializeLobbyRecord(store.getLobby(slug)));
    expect(restored.engine).toBeNull();
    const elsewhere = new LobbyStore();
    elsewhere.lobbies.set(slug, restored);
    const turn = (restored.gameSession?.snapshot as TrebuchetSnapshot).turn;
    const token = turn === host.player.id ? host.playerToken : guest.playerToken;
    expect(elsewhere.fire(slug, token, 60, 70)?.type).toBe('shot');
    expect(restored.engine).not.toBeNull();
  });
});

describe('lean lobby view', () => {
  it("leaves out the last event's copy of the game state when it is the session's", () => {
    const { store, slug } = shotFired();
    const full = JSON.parse(JSON.stringify(store.publicLobby(slug))) as Lobby;
    const lean = withoutRepeatedSnapshot(full);
    expect(lean.lastEvent?.snapshotFromSession).toBe(true);
    expect('snapshot' in (lean.lastEvent?.event as object)).toBe(false);
    expect((lean.lastEvent?.event as TrebuchetShotEvent).trajectory).toEqual((full.lastEvent?.event as TrebuchetShotEvent).trajectory);
    expect(JSON.stringify(lean).length).toBeLessThan(JSON.stringify(full).length * 0.75);
    // The full view is left as it was.
    expect((full.lastEvent?.event as TrebuchetShotEvent).snapshot).toEqual(full.gameSession?.snapshot);
  });

  it('keeps it when the game state moved on since the event (a rename)', () => {
    const { store, slug, host } = shotFired();
    // As stored: the event's copy and the session's are separate objects.
    store.lobbies.set(slug, deserializeLobbyRecord(JSON.parse(JSON.stringify(serializeLobbyRecord(store.getLobby(slug))))));
    store.renamePlayer(slug, host.playerToken, 'Alexa');
    const full = store.publicLobby(slug);
    expect(withoutRepeatedSnapshot(full)).toBe(full);
  });

  it('changes nothing without a last event', () => {
    const store = new LobbyStore();
    const full = store.publicLobby(store.createLobby());
    expect(withoutRepeatedSnapshot(full)).toBe(full);
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
  const poll = (slug: string, query = ''): Promise<Lobby> =>
    fetch(`${url}/api/lobbies/${slug}${query}`)
      .then((r) => r.json())
      .then((b) => b.lobby);

  it('grows with every write, in acks, pushes and polls alike, and only with writes', async () => {
    const created = await newLobby();
    const slug = created.slug;
    expect(created.rev).toBeGreaterThan(0);

    const tv = open();
    const pushed: Lobby[] = [];
    tv.on('lobby:snapshot', (lobby: Lobby) => pushed.push(lobby));
    const screen = await ack<{ lobby: Lobby; fanout: string }>(tv, 'screen:join', { slug, screenId: 'scr_revtv' });
    expect(screen.fanout).toBe('local');
    expect(screen.lobby.rev).toBeGreaterThan(created.rev!);

    const phone = open();
    const joined = await ack<{ lobby: Lobby; playerToken: string; fanout: string }>(phone, 'controller:join', { slug, name: 'Ann' });
    expect(joined.fanout).toBe('local');
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

  it('pushes the lobby when a chat message comes in over HTTP', async () => {
    const { slug } = await newLobby();
    const tv = open();
    await ack(tv, 'screen:join', { slug, screenId: 'scr_revchat' });
    const phone = open();
    const ann = await ack<{ playerToken: string }>(phone, 'controller:join', { slug, name: 'Ann' });
    const pushed: Lobby[] = [];
    tv.on('lobby:snapshot', (lobby: Lobby) => pushed.push(lobby));
    const res = await fetch(`${url}/api/lobbies/${slug}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerToken: ann.playerToken, text: 'over http' })
    });
    expect(res.status).toBe(201);
    await expect.poll(() => pushed.at(-1)?.chat.map((m) => m.text)).toContain('over http');
  });

  it('answers a poll that asks for it without the repeated game state', async () => {
    const { slug } = await newLobby();
    const phones = [open(), open()];
    const players = [];
    for (const [i, phone] of phones.entries()) {
      players.push(await ack<{ playerToken: string; player: { id: string } }>(phone, 'controller:join', { slug, name: `P${i}` }));
    }
    await ack(phones[0], 'game:start', { slug, playerToken: players[0].playerToken });

    const full = await poll(slug);
    const lean = await poll(slug, '?lean=1');
    expect(full.lastEvent?.event).toHaveProperty('snapshot');
    expect(lean.lastEvent?.snapshotFromSession).toBe(true);
    expect(lean.lastEvent?.event).not.toHaveProperty('snapshot');
    expect(lean.gameSession).toEqual(full.gameSession);
  });
});
