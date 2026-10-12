import net, { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import { io as connect, type Socket } from 'socket.io-client';
import type { ExternalGameManifest, GameInputEnvelope } from '@couch/types';
import { createRealtimeServer, type RealtimeServerInstance } from '../src/index.js';

// Two server instances sharing one Redis, like two Vercel Function instances.
// The phone talks to A, the TV to B; the input must reach the TV by socket.
// Needs a real Redis: run with TEST_REDIS_URL=redis://localhost:6379.
const redisUrl = process.env.TEST_REDIS_URL;

const PAD: ExternalGameManifest = {
  id: 'fanout-pad',
  title: 'Fanout Pad',
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

// A TCP proxy in front of Redis that holds the first `hold` connections until
// release(). An instance's fan-out pub/sub are the first two connections it opens
// (persistence connects lazily on first use), so this delays only the adapter
// attach — like a slow or retrying fan-out connection on a cold start.
async function holdingRedisProxy(target: string, hold: number) {
  const upstream = new URL(target);
  const held: Array<() => void> = [];
  let seen = 0;
  const server = net.createServer((client) => {
    const pipe = () => {
      const redis = net.connect(Number(upstream.port || 6379), upstream.hostname);
      redis.on('error', () => client.destroy());
      client.on('error', () => redis.destroy());
      client.pipe(redis).pipe(client);
    };
    if (seen++ < hold) held.push(pipe);
    else pipe();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `redis://127.0.0.1:${(server.address() as AddressInfo).port}`,
    release: () => held.splice(0).forEach((pipe) => pipe()),
    close: () => server.close()
  };
}

describe.skipIf(!redisUrl)('Redis fan-out across instances', () => {
  const servers: RealtimeServerInstance[] = [];
  const sockets: Socket[] = [];
  const closers: Array<() => void> = [];
  let urlA = '';
  let urlB = '';

  beforeAll(async () => {
    process.env.REDIS_URL = redisUrl;
    process.env.EXTERNAL_GAMES_JSON = JSON.stringify([PAD]);
    for (let i = 0; i < 2; i++) {
      const instance = createRealtimeServer();
      await instance.fanout.ready;
      await new Promise<void>((resolve) => instance.server.listen(0, resolve));
      servers.push(instance);
    }
    urlA = `http://localhost:${(servers[0].server.address() as AddressInfo).port}`;
    urlB = `http://localhost:${(servers[1].server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    for (const instance of servers) {
      instance.io.close();
    }
    for (const close of closers) close();
    delete process.env.REDIS_URL;
    delete process.env.EXTERNAL_GAMES_JSON;
  });

  function open(url: string): Socket {
    const socket = connect(url, { transports: ['websocket'], forceNew: true });
    sockets.push(socket);
    return socket;
  }

  function ack<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
    return new Promise((resolve, reject) =>
      socket.emit(event, payload, (res: T & { ok?: boolean; error?: string }) =>
        res?.ok === false ? reject(new Error(res.error)) : resolve(res)
      )
    );
  }

  it('reports redis fan-out on /health', async () => {
    const res = await fetch(`${urlA}/health`);
    expect((await res.json()).fanout).toBe('redis');
  });

  it('tells joining TVs and phones that changes reach every instance, so they poll slowly', async () => {
    const created = await fetch(`${urlA}/api/lobbies`, { method: 'POST' }).then((r) => r.json());
    const slug: string = created.lobby.slug;
    const screen = await ack<{ fanout: string }>(open(urlA), 'screen:join', { slug });
    expect(screen.fanout).toBe('redis');
    const joined = await ack<{ fanout: string }>(open(urlB), 'controller:join', { slug, name: 'Ann' });
    expect(joined.fanout).toBe('redis');
  });

  it('delivers an input sent to instance A to a screen on instance B, with unique seqs', async () => {
    const created = await fetch(`${urlA}/api/lobbies`, { method: 'POST' }).then((r) => r.json());
    const slug: string = created.lobby.slug;

    const tv = open(urlB);
    await ack(tv, 'screen:join', { slug });
    const received: GameInputEnvelope[] = [];
    tv.on('game:input', (envelope: GameInputEnvelope) => received.push(envelope));

    const phoneA = open(urlA);
    const phoneB = open(urlB);
    const host = await ack<{ playerToken: string }>(phoneA, 'controller:join', { slug, name: 'Ann' });
    const guest = await ack<{ playerToken: string }>(phoneB, 'controller:join', { slug, name: 'Bo' });
    await ack(phoneA, 'game:select', { slug, playerToken: host.playerToken, gameId: PAD.id });
    await ack(phoneA, 'game:start', { slug, playerToken: host.playerToken });

    const press = (socket: Socket, playerToken: string) =>
      ack(socket, 'controller:event', {
        slug,
        playerToken,
        event: { playerId: 'x', type: 'game', control: 'a', value: { action: 'press' }, timestamp: Date.now() }
      });
    // Concurrent inputs through both instances: each must get its own seq.
    await Promise.all([
      press(phoneA, host.playerToken),
      press(phoneB, guest.playerToken),
      press(phoneA, host.playerToken),
      press(phoneB, guest.playerToken)
    ]);

    await expect.poll(() => received.length, { timeout: 3000 }).toBe(4);
    expect(received.map((e) => e.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);

    // The persisted log (what the poll fallback reads) holds all four too.
    const polled = await fetch(`${urlA}/api/lobbies/${slug}`).then((r) => r.json());
    expect(polled.lobby.inputLog.map((e: GameInputEnvelope) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('keeps sockets that connected before the adapter was attached in their rooms', async () => {
    const proxy = await holdingRedisProxy(redisUrl!, 2);
    closers.push(proxy.close);
    process.env.REDIS_URL = proxy.url;
    const late = createRealtimeServer();
    process.env.REDIS_URL = redisUrl;
    servers.push(late);
    await new Promise<void>((resolve) => late.server.listen(0, resolve));
    const urlLate = `http://localhost:${(late.server.address() as AddressInfo).port}`;

    const created = await fetch(`${urlA}/api/lobbies`, { method: 'POST' }).then((r) => r.json());
    const slug: string = created.lobby.slug;

    // One TV joins its room while the instance is still instance-local; another
    // connects now but joins only after the adapter is in place.
    const joinedEarly = open(urlLate);
    await ack(joinedEarly, 'screen:join', { slug });
    const joinedLate = open(urlLate);
    if (!joinedLate.connected) await new Promise((resolve) => joinedLate.once('connect', resolve));
    expect(late.fanout.mode()).toBe('local');

    proxy.release();
    expect(await late.fanout.ready).toBe('redis');
    await ack(joinedLate, 'screen:join', { slug });
    expect(late.io.of('/').adapter.rooms.get(`lobby:${slug}`)?.size).toBe(2);

    const early: GameInputEnvelope[] = [];
    const later: GameInputEnvelope[] = [];
    joinedEarly.on('game:input', (envelope: GameInputEnvelope) => early.push(envelope));
    joinedLate.on('game:input', (envelope: GameInputEnvelope) => later.push(envelope));

    const phone = open(urlA);
    const host = await ack<{ playerToken: string }>(phone, 'controller:join', { slug, name: 'Ann' });
    await ack(phone, 'game:select', { slug, playerToken: host.playerToken, gameId: PAD.id });
    await ack(phone, 'game:start', { slug, playerToken: host.playerToken });
    await ack(phone, 'controller:event', {
      slug,
      playerToken: host.playerToken,
      event: { playerId: 'x', type: 'game', control: 'a', value: { action: 'press' }, timestamp: Date.now() }
    });

    await expect.poll(() => early.length, { timeout: 3000 }).toBe(1);
    await expect.poll(() => later.length, { timeout: 3000 }).toBe(1);

    // Leaving must reach the adapter that now holds the membership.
    joinedLate.disconnect();
    await expect.poll(() => late.io.of('/').adapter.rooms.get(`lobby:${slug}`)?.size, { timeout: 3000 }).toBe(1);
  });

  it('continues the seq of an external game that was running before the input list existed', async () => {
    const created = await fetch(`${urlA}/api/lobbies`, { method: 'POST' }).then((r) => r.json());
    const slug: string = created.lobby.slug;
    const phone = open(urlA);
    const host = await ack<{ playerToken: string }>(phone, 'controller:join', { slug, name: 'Ann' });
    await ack(phone, 'game:select', { slug, playerToken: host.playerToken, gameId: PAD.id });
    await ack(phone, 'game:start', { slug, playerToken: host.playerToken });

    // Store the game the way the deploy before the input list did: seq and log
    // only in the lobby blob, no list and no counter.
    const raw = createClient({ url: redisUrl });
    await raw.connect();
    const key = `couch:lobby:${slug}`;
    const blob = JSON.parse((await raw.get(key))!);
    blob.inputSeq = 50;
    blob.inputLog = Array.from({ length: 50 }, (_, i) => ({
      seq: i + 1,
      at: new Date().toISOString(),
      playerId: 'p',
      control: 'a',
      action: 'press'
    }));
    await raw.set(key, JSON.stringify(blob), { PXAT: blob.expiresAt });
    await raw.del([`${key}:inputs`, `${key}:inputseq`]);
    await raw.close();

    const tv = open(urlB);
    await ack(tv, 'screen:join', { slug });
    const received: GameInputEnvelope[] = [];
    tv.on('game:input', (envelope: GameInputEnvelope) => received.push(envelope));

    // A screen that already forwarded seq 50 drops anything at or below it.
    const sent = await ack<{ seq: number }>(phone, 'controller:event', {
      slug,
      playerToken: host.playerToken,
      event: { playerId: 'x', type: 'game', control: 'a', value: { action: 'press' }, timestamp: Date.now() }
    });
    expect(sent.seq).toBe(51);
    await expect.poll(() => received.map((e) => e.seq), { timeout: 3000 }).toEqual([51]);

    const polled = await fetch(`${urlB}/api/lobbies/${slug}`).then((r) => r.json());
    expect(polled.lobby.inputLog.map((e: GameInputEnvelope) => e.seq)).toEqual(Array.from({ length: 51 }, (_, i) => i + 1));
  });
});
