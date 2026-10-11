import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import { io as connect, type Socket } from 'socket.io-client';
import { createRealtimeServer, type RealtimeServerInstance } from '../src/index.js';

// Two server instances sharing one Redis, like Vercel Function instances.
// Needs a real Redis: run with TEST_REDIS_URL=redis://localhost:6379.
const redisUrl = process.env.TEST_REDIS_URL;

type Ack<T = unknown> = T & { ok: boolean; error?: string; status?: number };
type Joined = { playerToken: string; player: { id: string } };

describe.skipIf(!redisUrl)('player lifecycle on shared Redis', () => {
  const servers: RealtimeServerInstance[] = [];
  const urls: string[] = [];
  const sockets: Socket[] = [];
  const previousRedisUrl = process.env.REDIS_URL;
  const redis = createClient({ url: redisUrl });

  beforeAll(async () => {
    process.env.REDIS_URL = redisUrl;
    await redis.connect();
    for (let i = 0; i < 2; i++) {
      const instance = createRealtimeServer({ disconnectQuietMs: 200, reconnectGraceMs: 300 });
      await new Promise<void>((resolve) => instance.server.listen(0, resolve));
      servers.push(instance);
      urls.push(`http://localhost:${(instance.server.address() as AddressInfo).port}`);
    }
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    for (const instance of servers) instance.io.close();
    await redis.quit();
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
  });

  const [A, B] = [0, 1];

  function open(at: number): Socket {
    const socket = connect(urls[at], { transports: ['websocket'], forceNew: true });
    sockets.push(socket);
    return socket;
  }

  function ack<T>(socket: Socket, event: string, payload: unknown): Promise<Ack<T>> {
    return new Promise((resolve) => socket.emit(event, payload, resolve));
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const lobbyAt = (at: number, slug: string) =>
    fetch(`${urls[at]}/api/lobbies/${slug}`)
      .then((r) => r.json())
      .then((body) => body.lobby);
  const newLobby = () =>
    fetch(`${urls[A]}/api/lobbies`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then((r) => r.json())
      .then((body) => body.lobby.slug as string);

  it('keeps a player who rejoined on another instance before the old socket dropped', async () => {
    const slug = await newLobby();
    const oldOnA = open(A);
    const ann = await ack<Joined>(oldOnA, 'controller:join', { slug, name: 'Ann' });
    await ack<Joined>(open(A), 'controller:join', { slug, name: 'Bo' });
    const newOnB = open(B);
    expect((await ack(newOnB, 'controller:join', { slug, name: 'Ann', playerToken: ann.playerToken })).ok).toBe(true);

    oldOnA.disconnect();
    // Past the quiet window and the removal grace on A.
    await sleep(900);
    const lobby = await lobbyAt(B, slug);
    expect(lobby.players.find((p: { id: string }) => p.id === ann.player.id)).toMatchObject({ connected: true, isHost: true });
    const fired = await ack(newOnB, 'chat:send', { slug, playerToken: ann.playerToken, text: 'still here' });
    expect(fired.ok).toBe(true);
  });

  it('answers a screen lookup that fails in Redis with an error instead of crashing', async () => {
    const id = `scr_broken${Date.now().toString(36)}`;
    // A key of the wrong type makes GET fail, like any Redis error would.
    await redis.hSet(`couch:screen:${id}`, 'x', '1');
    const res = await fetch(`${urls[A]}/api/screens/${id}`);
    expect(res.status).toBe(500);
    expect((await fetch(`${urls[A]}/health`)).ok).toBe(true);
    await redis.del(`couch:screen:${id}`);
  });

  it('survives a phone dropping while its lobby cannot be read', async () => {
    const slug = await newLobby();
    const phone = open(A);
    await ack<Joined>(phone, 'controller:join', { slug, name: 'Ann' });
    await redis.del(`couch:lobby:${slug}`);
    await redis.hSet(`couch:lobby:${slug}`, 'x', '1');
    phone.disconnect();
    await sleep(500);
    expect((await fetch(`${urls[A]}/health`)).ok).toBe(true);
    await redis.del(`couch:lobby:${slug}`);
  });
});
