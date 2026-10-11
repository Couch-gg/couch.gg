import net, { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import { io as connect, type Socket } from 'socket.io-client';
import type { ExternalGameManifest, Lobby } from '@couch/types';
import { createRealtimeServer, type RealtimeServerInstance } from '../src/index.js';
import { LobbyStore, cloneLobbyRecord, serializeLobbyRecord } from '../src/lobbies.js';
import { createLobbyPersistence } from '../src/persistence.js';

// Lobby writes from two server instances sharing one Redis, like two Vercel
// Function instances: every write must land on top of the one before it, or
// one instance's change silently undoes the other's.
// Needs a real Redis: run with TEST_REDIS_URL=redis://localhost:6379.
const redisUrl = process.env.TEST_REDIS_URL;

// A TCP proxy in front of Redis that holds every chunk for `delayMs` each way,
// like a Redis a network hop away. On localhost every reply of a burst comes
// back in the same tick, which hides lost writes the real latency exposes.
async function slowRedisProxy(target: string, delayMs: number) {
  const upstream = new URL(target);
  const server = net.createServer((client) => {
    const redis = net.connect(Number(upstream.port || 6379), upstream.hostname);
    const relay = (from: net.Socket, to: net.Socket) =>
      from.on('data', (chunk) => setTimeout(() => to.writable && to.write(chunk), delayMs));
    relay(client, redis);
    relay(redis, client);
    redis.on('error', () => client.destroy());
    client.on('error', () => redis.destroy());
    redis.on('close', () => client.destroy());
    client.on('close', () => redis.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `redis://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

const PAD: ExternalGameManifest = {
  id: 'writes-pad',
  title: 'Writes Pad',
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

type Ack<T = unknown> = T & { ok: boolean; error?: string; status?: number };
type Joined = { playerToken: string; player: { id: string; isHost: boolean }; lobby: Lobby };

describe.skipIf(!redisUrl)('lobby writes across instances', () => {
  const servers: RealtimeServerInstance[] = [];
  const urls: string[] = [];
  const sockets: Socket[] = [];
  const previousRedisUrl = process.env.REDIS_URL;
  const previousExternal = process.env.EXTERNAL_GAMES_JSON;
  const redis = createClient({ url: redisUrl });
  let proxy: Awaited<ReturnType<typeof slowRedisProxy>>;

  beforeAll(async () => {
    proxy = await slowRedisProxy(redisUrl!, 2);
    process.env.REDIS_URL = proxy.url;
    process.env.EXTERNAL_GAMES_JSON = JSON.stringify([PAD]);
    await redis.connect();
    for (let i = 0; i < 2; i++) {
      const instance = createRealtimeServer();
      await new Promise<void>((resolve) => instance.server.listen(0, resolve));
      servers.push(instance);
      urls.push(`http://localhost:${(instance.server.address() as AddressInfo).port}`);
    }
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    for (const instance of servers) instance.io.close();
    proxy.close();
    await redis.quit();
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
    if (previousExternal === undefined) delete process.env.EXTERNAL_GAMES_JSON;
    else process.env.EXTERNAL_GAMES_JSON = previousExternal;
  });

  const [A, B] = [0, 1];

  async function open(at: number): Promise<Socket> {
    const socket = connect(urls[at], { transports: ['websocket'], forceNew: true });
    sockets.push(socket);
    if (!socket.connected) await new Promise((resolve) => socket.once('connect', resolve));
    return socket;
  }

  function ack<T>(socket: Socket, event: string, payload: unknown): Promise<Ack<T>> {
    return new Promise((resolve) => socket.emit(event, payload, resolve));
  }

  const newLobby = () =>
    fetch(`${urls[A]}/api/lobbies`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then((r) => r.json())
      .then((body) => body.lobby.slug as string);

  const stored = async (slug: string) => JSON.parse((await redis.get(`couch:lobby:${slug}`)) ?? 'null');

  it('stores a lobby only on top of the rev it was loaded with', async () => {
    const persistence = createLobbyPersistence(redisUrl);
    const store = new LobbyStore();
    const lobby = store.createLobby();
    store.markChanged(lobby);
    expect(await persistence.commit!(lobby, null)).toBe(true);
    // The slug is taken now.
    expect(await persistence.commit!(cloneLobbyRecord(lobby), null)).toBe(false);

    const loaded = (await persistence.load(lobby.slug))!;
    expect(loaded.rev).toBe(lobby.rev);
    const first = cloneLobbyRecord(loaded);
    store.markChanged(first);
    first.name = 'First';
    const second = cloneLobbyRecord(loaded);
    store.markChanged(second);
    second.name = 'Second';
    expect(await persistence.commit!(first, loaded.rev)).toBe(true);
    // Loaded before the first was stored: refused, not stored over it.
    expect(await persistence.commit!(second, loaded.rev)).toBe(false);
    expect((await persistence.load(lobby.slug))!.name).toBe('First');

    // A lobby stored before revs existed is at rev 0.
    const { rev: _rev, ...legacy } = serializeLobbyRecord(first);
    await redis.set(`couch:lobby:${lobby.slug}`, JSON.stringify(legacy), { PXAT: first.expiresAt });
    const old = (await persistence.load(lobby.slug))!;
    expect(old.rev).toBe(0);
    store.markChanged(old);
    expect(await persistence.commit!(old, 0)).toBe(true);
    expect((await stored(lobby.slug)).rev).toBe(old.rev);

    // A lobby that is gone is not brought back.
    await redis.del(`couch:lobby:${lobby.slug}`);
    store.markChanged(old);
    expect(await persistence.commit!(old, old.rev)).toBe(false);
    expect(await redis.exists(`couch:lobby:${lobby.slug}`)).toBe(0);
  });

  it('lets exactly four of six phones joining at once into a four-player lobby, on two instances', async () => {
    // A few rounds: one lucky interleaving must not decide the outcome.
    for (let round = 0; round < 5; round++) {
      const slug = await newLobby();
      const phones = await Promise.all([A, B, A, B, A, B].map((at) => open(at)));
      const acks = await Promise.all(phones.map((phone, i) => ack<Joined>(phone, 'controller:join', { slug, name: `P${i}` })));

      const joined = acks.filter((a) => a.ok);
      expect(joined).toHaveLength(4);
      for (const refused of acks.filter((a) => !a.ok)) expect(refused.status).toBe(409);
      const hosts = joined.filter((a) => a.player.isHost);
      expect(hosts).toHaveLength(1);

      // Every player who was told they are in is in the stored lobby, and the
      // host the acks named is the stored host.
      const record = await stored(slug);
      expect(record.players.map((p: { id: string }) => p.id).sort()).toEqual(joined.map((a) => a.player.id).sort());
      expect(record.hostPlayerId).toBe(hosts[0].player.id);
      // Both instances see the same four.
      for (const url of urls) {
        const lobby: Lobby = await fetch(`${url}/api/lobbies/${slug}`).then((r) => r.json()).then((b) => b.lobby);
        expect(lobby.players).toHaveLength(4);
        expect(lobby.hostPlayerId).toBe(hosts[0].player.id);
      }
      for (const phone of phones) phone.disconnect();
    }
  });

  it('keeps a player who rejoins on one instance while another instance writes the lobby', async () => {
    for (let round = 0; round < 5; round++) {
      const slug = await newLobby();
      const annOnA = await open(A);
      const ann = await ack<Joined>(annOnA, 'controller:join', { slug, name: 'Ann' });
      const boOnB = await open(B);
      const bo = await ack<Joined>(boOnB, 'controller:join', { slug, name: 'Bo' });
      // Ann shows as gone (her phone slept); she comes back on A while Bo
      // chats through B.
      const record = await stored(slug);
      const gone = record.players.find((p: { id: string }) => p.id === ann.player.id);
      gone.connected = false;
      gone.disconnectedAt = Date.now() - 1_000;
      await redis.set(`couch:lobby:${slug}`, JSON.stringify(record), { PXAT: record.expiresAt });

      const annAgain = await open(A);
      const [back, chat] = await Promise.all([
        ack<Joined>(annAgain, 'controller:join', { slug, name: 'Ann', playerToken: ann.playerToken }),
        ack(boOnB, 'chat:send', { slug, playerToken: bo.playerToken, text: `round ${round}` })
      ]);
      expect(back.ok).toBe(true);
      expect(chat.ok).toBe(true);

      const after = await stored(slug);
      expect(after.players.find((p: { id: string }) => p.id === ann.player.id)).toMatchObject({ connected: true, disconnectedAt: null });
      expect(after.chat.map((m: { text: string }) => m.text)).toContain(`round ${round}`);
      for (const socket of [annOnA, boOnB, annAgain]) socket.disconnect();
    }
  });

  it('writes on top of a lobby an instance without revs stored in between', async () => {
    const slug = await newLobby();
    const phone = await open(A);
    const ann = await ack<Joined>(phone, 'controller:join', { slug, name: 'Ann' });
    // Instance A holds the lobby at its rev now. A deploy from before revs
    // stores it without one (here: renames the lobby).
    const record = await stored(slug);
    const { rev: _rev, ...legacy } = { ...record, name: 'Renamed by an old deploy' };
    await redis.set(`couch:lobby:${slug}`, JSON.stringify(legacy), { PXAT: record.expiresAt });

    const chat = await ack(phone, 'chat:send', { slug, playerToken: ann.playerToken, text: 'after the old deploy' });
    expect(chat.ok).toBe(true);
    const after = await stored(slug);
    expect(after.name).toBe('Renamed by an old deploy');
    expect(after.chat.map((m: { text: string }) => m.text)).toContain('after the old deploy');
    expect(after.rev).toBeGreaterThan(record.rev);
    const polled: Lobby = await fetch(`${urls[A]}/api/lobbies/${slug}`).then((r) => r.json()).then((b) => b.lobby);
    expect(polled.name).toBe('Renamed by an old deploy');
  });

  it('keeps every controller update of a burst the TV sends at once, each under its own seq', async () => {
    const slug = await newLobby();
    const tvOnA = await open(A);
    await ack(tvOnA, 'screen:join', { slug, screenId: 'scr_writesA' });
    const phones = await Promise.all([A, B, B].map((at) => open(at)));
    const host = await ack<Joined>(phones[0], 'controller:join', { slug, name: 'P0' });
    expect((await ack(phones[0], 'game:select', { slug, playerToken: host.playerToken, gameId: PAD.id })).ok).toBe(true);
    const players: Joined[] = [host];
    for (const phone of phones.slice(1)) players.push(await ack<Joined>(phone, 'controller:join', { slug, name: `P${players.length}` }));
    expect((await ack(phones[0], 'game:start', { slug, playerToken: host.playerToken })).ok).toBe(true);

    const received = new Map<string, number[]>();
    phones.forEach((phone, i) =>
      phone.on('controller:state', ({ state }: { state: { seq: number } }) => {
        const seqs = received.get(players[i].player.id) ?? [];
        seqs.push(state.seq);
        received.set(players[i].player.id, seqs);
      })
    );

    // Two updates per player in a burst, as a game sends them at a round's
    // start, a millisecond apart: each one's load goes out before the one
    // before it is stored.
    const sent: Array<Promise<Ack<{ state: { seq: number } }>>> = [];
    for (const p of players) {
      for (const patch of [{ labels: { a: 'Go' } }, { disabled: ['a'] }]) {
        sent.push(ack(tvOnA, 'screen:controller', { slug, playerId: p.player.id, patch }));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }
    const results = await Promise.all(sent);
    for (const result of results) expect(result.ok).toBe(true);

    const record = await stored(slug);
    for (const p of players) {
      // Both patches landed: neither undid the other.
      expect(record.controllerState[p.player.id]).toMatchObject({ seq: 2, labels: { a: 'Go' }, disabled: ['a'] });
    }
    // The phone on the TV's instance got both, each under its own seq (emits
    // don't cross instances here).
    await expect.poll(() => (received.get(host.player.id) ?? []).slice().sort()).toEqual([1, 2]);
  });
});
