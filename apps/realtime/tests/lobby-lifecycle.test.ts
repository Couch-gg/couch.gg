import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { ExternalGameManifest, GameId, GameManifest } from '@couch/types';
import { getGameManifest } from '@couch/game-runtime';
import type { TrebuchetSnapshot } from '@couch/trebuchet';
import { LOBBY_MAX_AGE_MS, LOBBY_TTL_MS, LobbyStore, type ManifestResolver } from '../src/lobbies.js';
import { createRealtimeServer, type RealtimeServerInstance } from '../src/index.js';

const RACE: ExternalGameManifest = {
  id: 'life-race',
  title: 'Life Race',
  description: 'Test game.',
  minPlayers: 1,
  maxPlayers: 4,
  controllerLayout: { kind: 'generic-buttons', controls: [{ control: 'tap', type: 'button', label: 'Tap' }] },
  aspectRatio: '16:9',
  estimatedDurationMinutes: 1,
  status: 'published',
  origin: 'external',
  entryUrl: 'https://games.example.com/race/',
  supportsRemote: true,
  sdkProtocol: 1,
  publishedAt: '2026-10-01T00:00:00.000Z',
  thumbnail: { kind: 'css', gradient: 'linear-gradient(#000,#111)', icon: 'Zap' }
};
const DASH: ExternalGameManifest = { ...RACE, id: 'life-dash', title: 'Life Dash' };

function resolver(...externals: ExternalGameManifest[]): ManifestResolver {
  const byId = new Map<GameId, GameManifest>(externals.map((game) => [game.id, game]));
  return (id) => {
    const external = byId.get(id);
    if (external) return external;
    try {
      return getGameManifest(id);
    } catch {
      return null;
    }
  };
}

function twoPlayers() {
  const store = new LobbyStore(resolver(RACE, DASH));
  const { slug } = store.createLobby();
  const host = store.joinPlayer(slug, 'Ann', undefined, undefined, 'sock-ann');
  const guest = store.joinPlayer(slug, 'Bo', undefined, undefined, 'sock-bo');
  return { store, slug, host, guest };
}

function startedRace() {
  const setup = twoPlayers();
  setup.store.selectGame(setup.slug, setup.host.playerToken, RACE.id);
  setup.store.startGame(setup.slug, setup.host.playerToken);
  return setup;
}

describe('rounds', () => {
  it('lets the host pick another game once a round has ended, then start it', () => {
    const { store, slug, host } = startedRace();
    expect(store.finishExternalGame(slug, [{ playerId: host.player.id, score: 1 }])).toBe(true);
    expect(() => store.selectGame(slug, host.playerToken, RACE.id)).not.toThrow();
    const lobby = store.selectGame(slug, host.playerToken, DASH.id);
    expect(lobby.currentGameId).toBe(DASH.id);
    expect(lobby.state).toBe('ended');
    store.startGame(slug, host.playerToken);
    expect(store.publicLobby(slug).state).toBe('playing');
    expect(store.publicLobby(slug).gameSession?.gameId).toBe(DASH.id);
  });

  it('still refuses a game change while a round runs', () => {
    const { store, slug, host } = startedRace();
    expect(() => store.selectGame(slug, host.playerToken, DASH.id)).toThrow(/nur in der Lobby/);
  });

  it('lets the host end a running game without scores, but nobody else', () => {
    const { store, slug, host, guest } = startedRace();
    expect(() => store.endGame(slug, guest.playerToken)).toThrow(/Nur der Host/);
    const lobby = store.endGame(slug, host.playerToken);
    expect(lobby.state).toBe('ended');
    expect(lobby.gameSession?.state).toBe('finished');
    expect(() => store.endGame(slug, host.playerToken)).toThrow(/Kein laufendes Spiel/);
    // A finish report that arrives late changes nothing.
    expect(store.finishExternalGame(slug, [{ playerId: host.player.id, score: 3 }])).toBe(false);
  });
});

describe('finish reports', () => {
  it('leaves out entries without a finite score instead of refusing the report', () => {
    const { store, slug, host, guest } = startedRace();
    const finished = store.finishExternalGame(slug, [
      { playerId: host.player.id, score: 4 },
      // NaN from a game's uninitialised counter arrives as null over the socket.
      { playerId: guest.player.id, score: null },
      { playerId: guest.player.id, score: Number.NaN }
    ]);
    expect(finished).toBe(true);
    expect(store.publicLobby(slug).gameSession?.snapshot).toMatchObject({ scores: [{ playerId: host.player.id, score: 4 }] });
  });

  it('accepts a long report (bots, teams, duplicates) and keeps one score per player', () => {
    const { store, slug, host, guest } = startedRace();
    const scores = [
      ...Array.from({ length: 12 }, (_, i) => ({ playerId: `bot_${i}`, score: i })),
      { playerId: guest.player.id, score: 7 },
      { playerId: guest.player.id, score: 99 },
      { playerId: host.player.id, score: 2 }
    ];
    expect(store.finishExternalGame(slug, scores)).toBe(true);
    expect(store.publicLobby(slug).gameSession?.snapshot).toMatchObject({
      scores: [
        { playerId: guest.player.id, score: 7 },
        { playerId: host.player.id, score: 2 }
      ]
    });
  });
});

describe('players leaving', () => {
  it('ignores the drop of a socket the player already replaced', () => {
    const { store, slug, host } = twoPlayers();
    store.joinPlayer(slug, 'Ann', host.playerToken, undefined, 'sock-ann-2');
    expect(store.markDisconnected(slug, host.player.id, 10, 'sock-ann')).toBeNull();
    expect(store.publicLobby(slug).players.find((p) => p.id === host.player.id)?.connected).toBe(true);
    expect(store.markDisconnected(slug, host.player.id, 20, 'sock-ann-2')).not.toBeNull();
    expect(store.publicLobby(slug).players.find((p) => p.id === host.player.id)?.connected).toBe(false);
  });

  it('only announces a reconnect when the player was shown as gone', () => {
    const { store, slug, host } = twoPlayers();
    const before = store.publicLobby(slug).activity.length;
    store.joinPlayer(slug, 'Ann', host.playerToken, undefined, 'sock-ann-2');
    expect(store.getLobby(slug).activity.length).toBe(before);

    store.markDisconnected(slug, host.player.id, 10, 'sock-ann-2');
    store.joinPlayer(slug, 'Ann', host.playerToken, undefined, 'sock-ann-3');
    expect(store.getLobby(slug).activity.map((a) => a.text)).toContain('Ann ist wieder verbunden');
  });

  it('removes a player who leaves at once and hands the host role on', () => {
    const { store, slug, host, guest } = twoPlayers();
    const removal = store.leavePlayer(slug, host.playerToken);
    expect(removal.lobby.players.map((p) => p.id)).toEqual([guest.player.id]);
    expect(removal.lobby.hostPlayerId).toBe(guest.player.id);
    expect(() => store.leavePlayer(slug, host.playerToken)).toThrow(/Controller nicht verbunden/);
  });

  it('takes a leaving player out of a running Trebuchet game', () => {
    const { store, slug, host, guest } = twoPlayers();
    store.startGame(slug, host.playerToken);
    const removal = store.leavePlayer(slug, guest.playerToken);
    expect(removal.gameEvent?.phase).toBe('finished');
    expect(removal.lobby.state).toBe('ended');
  });

  it('keeps an emptied lobby so the next player to join becomes its host', () => {
    const { store, slug, host, guest } = twoPlayers();
    store.markDisconnected(slug, guest.player.id, 10, 'sock-bo');
    store.markDisconnected(slug, host.player.id, 20, 'sock-ann');
    expect(store.removeIfStillDisconnected(slug, guest.player.id, 10)).not.toBeNull();
    const last = store.removeIfStillDisconnected(slug, host.player.id, 20);
    expect(last?.lobby.players).toEqual([]);
    expect(last?.lobby.hostPlayerId).toBeNull();

    const cy = store.joinPlayer(slug, 'Cy');
    expect(cy.player.isHost).toBe(true);
    expect(() => store.selectGame(slug, cy.playerToken, RACE.id)).not.toThrow();
  });

  it('ends an external game nobody is left in, so others can join again', () => {
    const { store, slug, host, guest } = startedRace();
    store.leavePlayer(slug, guest.playerToken);
    expect(store.publicLobby(slug).state).toBe('playing');
    store.leavePlayer(slug, host.playerToken);
    expect(store.publicLobby(slug).state).toBe('ended');
    expect(store.joinPlayer(slug, 'Cy').player.isHost).toBe(true);
  });

  it('reports nothing when the player came back or is already gone', () => {
    const { store, slug, host } = twoPlayers();
    store.markDisconnected(slug, host.player.id, 10, 'sock-ann');
    store.joinPlayer(slug, 'Ann', host.playerToken, undefined, 'sock-ann-2');
    expect(store.removeIfStillDisconnected(slug, host.player.id, 10)).toBeNull();
    expect(store.removeIfStillDisconnected(slug, 'player_nobody', 10)).toBeNull();
  });
});

describe('turn timers', () => {
  function trebuchet() {
    const setup = twoPlayers();
    setup.store.startGame(setup.slug, setup.host.playerToken);
    const snapshot = setup.store.publicLobby(setup.slug).gameSession?.snapshot as TrebuchetSnapshot;
    return { ...setup, turnEndsAt: snapshot.turnEndsAt! };
  }

  it('skips only the turn the timer was armed for, once its time is up', () => {
    const { store, slug, turnEndsAt } = trebuchet();
    const before = store.publicLobby(slug).gameSession?.snapshot as TrebuchetSnapshot;
    expect(store.skipTurn(slug, turnEndsAt, turnEndsAt - 1)).toBeNull();
    // A timer armed for an earlier turn (another instance's, or from before
    // a player left) must not cut the current one short.
    expect(store.skipTurn(slug, turnEndsAt - 30_000, turnEndsAt)).toBeNull();
    const event = store.skipTurn(slug, turnEndsAt, turnEndsAt);
    expect(event).toMatchObject({ type: 'turn', skipped: before.turn });
    expect((store.publicLobby(slug).gameSession?.snapshot as TrebuchetSnapshot).turn).not.toBe(before.turn);
  });
});

describe('lobby lifetime', () => {
  it('slides with activity, up to a maximum age', () => {
    const store = new LobbyStore();
    const lobby = store.createLobby(0);
    expect(lobby.expiresAt).toBe(LOBBY_TTL_MS);
    store.keepAlive(lobby, 3 * 60 * 60 * 1000);
    expect(lobby.expiresAt).toBe(7 * 60 * 60 * 1000);
    store.keepAlive(lobby, 1_000);
    expect(lobby.expiresAt).toBe(7 * 60 * 60 * 1000);
    store.keepAlive(lobby, LOBBY_MAX_AGE_MS - 1_000);
    expect(lobby.expiresAt).toBe(LOBBY_MAX_AGE_MS);
  });
});

type Ack<T = unknown> = T & { ok: boolean; error?: string; status?: number };

describe('player and screen sockets', () => {
  let instance: RealtimeServerInstance;
  let url = '';
  const sockets: Socket[] = [];

  beforeAll(async () => {
    process.env.EXTERNAL_GAMES_JSON = JSON.stringify([RACE]);
    instance = createRealtimeServer({ disconnectQuietMs: 300, reconnectGraceMs: 400 });
    await new Promise<void>((resolve) => instance.server.listen(0, resolve));
    url = `http://localhost:${(instance.server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    for (const socket of sockets) socket.disconnect();
    instance.io.close();
    delete process.env.EXTERNAL_GAMES_JSON;
  });

  function open(): Socket {
    const socket = connect(url, { transports: ['websocket'], forceNew: true });
    sockets.push(socket);
    return socket;
  }

  function ack<T>(socket: Socket, event: string, payload: unknown): Promise<Ack<T>> {
    return new Promise((resolve) => socket.emit(event, payload, resolve));
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const lobbyOf = (slug: string) => fetch(`${url}/api/lobbies/${slug}`).then((r) => r.json()).then((body) => body.lobby);
  const newLobby = () =>
    fetch(`${url}/api/lobbies`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then((r) => r.json())
      .then((body) => body.lobby.slug as string);

  type Joined = { playerToken: string; player: { id: string; isHost: boolean } };

  it('treats a repeated join without a token on one socket as the same player', async () => {
    const slug = await newLobby();
    const phone = open();
    const first = await ack<Joined>(phone, 'controller:join', { slug, name: 'Ann' });
    // The first ack timed out on the phone, which then tries again.
    const again = await ack<Joined>(phone, 'controller:join', { slug, name: 'Ann' });
    expect(again.player.id).toBe(first.player.id);
    expect(again.playerToken).toBe(first.playerToken);
    expect((await lobbyOf(slug)).players).toHaveLength(1);
  });

  it('keeps a short reconnect quiet, and marks a phone gone only after the quiet window', async () => {
    const slug = await newLobby();
    const ann = open();
    const joined = await ack<Joined>(ann, 'controller:join', { slug, name: 'Ann' });
    await ack<Joined>(open(), 'controller:join', { slug, name: 'Bo' });

    ann.disconnect();
    const back = open();
    expect((await ack(back, 'controller:join', { slug, name: 'Ann', playerToken: joined.playerToken })).ok).toBe(true);
    await sleep(600);
    let lobby = await lobbyOf(slug);
    expect(lobby.players.find((p: { id: string }) => p.id === joined.player.id).connected).toBe(true);
    expect(lobby.activity.map((a: { text: string }) => a.text).join('|')).not.toMatch(/Verbindung verloren|wieder verbunden/);

    back.disconnect();
    await sleep(100);
    lobby = await lobbyOf(slug);
    expect(lobby.players.find((p: { id: string }) => p.id === joined.player.id).connected).toBe(true);
    await expect
      .poll(async () => (await lobbyOf(slug)).players.find((p: { id: string }) => p.id === joined.player.id)?.connected, {
        timeout: 2_000,
        interval: 50
      })
      .toBe(false);
  });

  it('keeps a player whose old socket only drops after they rejoined on a new one', async () => {
    const slug = await newLobby();
    const old = open();
    const joined = await ack<Joined>(old, 'controller:join', { slug, name: 'Ann' });
    const fresh = open();
    await ack(fresh, 'controller:join', { slug, name: 'Ann', playerToken: joined.playerToken });
    old.disconnect();
    // Well past the quiet window and the removal grace.
    await sleep(1_200);
    const lobby = await lobbyOf(slug);
    expect(lobby.players).toHaveLength(1);
    expect(lobby.players[0]).toMatchObject({ id: joined.player.id, connected: true, isHost: true });
  });

  it('lets a player leave at once and gives the host role to the next one', async () => {
    const slug = await newLobby();
    const ann = open();
    const host = await ack<Joined>(ann, 'controller:join', { slug, name: 'Ann' });
    const bo = open();
    const guest = await ack<Joined>(bo, 'controller:join', { slug, name: 'Bo' });
    expect((await ack(ann, 'controller:leave', { slug, playerToken: host.playerToken })).ok).toBe(true);
    ann.disconnect();
    const lobby = await lobbyOf(slug);
    expect(lobby.players.map((p: { id: string }) => p.id)).toEqual([guest.player.id]);
    expect(lobby.hostPlayerId).toBe(guest.player.id);
    expect((await ack(bo, 'game:select', { slug, playerToken: guest.playerToken, gameId: RACE.id })).ok).toBe(true);
  });

  it('keeps a lobby everyone left, so the next player becomes host', async () => {
    const slug = await newLobby();
    const ann = open();
    await ack<Joined>(ann, 'controller:join', { slug, name: 'Ann' });
    ann.disconnect();
    // Quiet window + grace + a margin.
    await expect.poll(async () => (await lobbyOf(slug))?.players?.length, { timeout: 3_000, interval: 100 }).toBe(0);
    const cy = await ack<Joined>(open(), 'controller:join', { slug, name: 'Cy' });
    expect(cy.player.isHost).toBe(true);
  });

  it('accepts a game:finish sent right behind the screen:join of a reconnected TV', async () => {
    const slug = await newLobby();
    const tv = open();
    const seat = await ack<{ screenToken: string }>(tv, 'screen:join', { slug, screenId: 'scr_lifetv' });
    const phone = open();
    const host = await ack<Joined>(phone, 'controller:join', { slug, name: 'Ann' });
    await ack(phone, 'game:select', { slug, playerToken: host.playerToken, gameId: RACE.id });
    expect((await ack(phone, 'game:start', { slug, playerToken: host.playerToken })).ok).toBe(true);

    tv.disconnect();
    const back = open();
    await new Promise<void>((resolve) => back.once('connect', () => resolve()));
    // Not awaited: the TV sends its rejoin and the held-back finish together.
    void ack(back, 'screen:join', { slug, screenId: 'scr_lifetv', screenToken: seat.screenToken });
    const finished = await ack<{ finished: boolean }>(back, 'game:finish', { slug, scores: [{ playerId: host.player.id, score: 5 }] });
    expect(finished).toMatchObject({ ok: true, finished: true });
    expect((await lobbyOf(slug)).state).toBe('ended');
  });

  it('lets the host end a running game from the phone', async () => {
    const slug = await newLobby();
    const phone = open();
    const host = await ack<Joined>(phone, 'controller:join', { slug, name: 'Ann' });
    const bo = open();
    const guest = await ack<Joined>(bo, 'controller:join', { slug, name: 'Bo' });
    await ack(phone, 'game:select', { slug, playerToken: host.playerToken, gameId: RACE.id });
    await ack(phone, 'game:start', { slug, playerToken: host.playerToken });
    expect(await ack(bo, 'game:end', { slug, playerToken: guest.playerToken })).toMatchObject({ ok: false, status: 403 });
    expect((await ack(phone, 'game:end', { slug, playerToken: host.playerToken })).ok).toBe(true);
    expect((await lobbyOf(slug)).state).toBe('ended');
  });

  it('extends the lobby lifetime on activity', async () => {
    const slug = await newLobby();
    const before = Date.parse((await lobbyOf(slug)).expiresAt);
    await sleep(20);
    await ack<Joined>(open(), 'controller:join', { slug, name: 'Ann' });
    expect(Date.parse((await lobbyOf(slug)).expiresAt)).toBeGreaterThan(before);
  });
});
