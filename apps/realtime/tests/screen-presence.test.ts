import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { createRealtimeServer, type RealtimeServerInstance } from '../src/index.js';

// Three server instances sharing one Redis, like Vercel Function instances,
// with no Socket.IO adapter between them: whether a TV is still there has to
// be read from the stored lobby, not from one instance's sockets.
// Needs a real Redis: run with TEST_REDIS_URL=redis://localhost:6379.
const redisUrl = process.env.TEST_REDIS_URL;

type Ack<T = unknown> = T & { ok: boolean; error?: string; status?: number };

describe.skipIf(!redisUrl)('screen liveness across instances', () => {
  const servers: RealtimeServerInstance[] = [];
  const urls: string[] = [];
  const sockets: Socket[] = [];
  const previousRedisUrl = process.env.REDIS_URL;

  beforeAll(async () => {
    process.env.REDIS_URL = redisUrl;
    // A and B drop a TV 300 ms after it left. C would wait a minute, so its
    // grace timer never fires here, like an instance that went away.
    for (const screenGraceMs of [300, 300, 60_000]) {
      const instance = createRealtimeServer({ screenGraceMs });
      await new Promise<void>((resolve) => instance.server.listen(0, resolve));
      servers.push(instance);
      urls.push(`http://localhost:${(instance.server.address() as AddressInfo).port}`);
    }
  });

  afterAll(() => {
    for (const socket of sockets) socket.disconnect();
    for (const instance of servers) instance.io.close();
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
  });

  const [A, B, C] = [0, 1, 2];

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

  async function remoteLobby(): Promise<string> {
    const created = await fetch(`${urls[A]}/api/lobbies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"mode":"remote"}'
    }).then((r) => r.json());
    return created.lobby.slug;
  }

  it('keeps a TV that dropped on one instance and came back on another', async () => {
    const slug = await remoteLobby();
    const tvOnA = open(A);
    const joined = await ack<{ screenToken?: string }>(tvOnA, 'screen:join', { slug, screenId: 'scr_wanderer' });
    tvOnA.disconnect();
    await sleep(100); // A notes the drop
    const tvOnB = open(B);
    expect((await ack(tvOnB, 'screen:join', { slug, screenId: 'scr_wanderer', screenToken: joined.screenToken })).ok).toBe(true);

    // Well past A's grace timer: A has no socket for the TV, but the record
    // says it is back.
    await sleep(800);
    for (const at of [A, B]) {
      const lobby = await lobbyAt(at, slug);
      expect(lobby.screens).toEqual(['scr_wanderer']);
      expect(lobby.hostScreenId).toBe('scr_wanderer');
    }
    expect((await ack(tvOnB, 'game:state', { slug, epoch: 'e', seq: 1, state: {} })).ok).toBe(true);
  });

  it("keeps a TV whose old socket drops only after it rejoined elsewhere", async () => {
    const slug = await remoteLobby();
    const tvOnA = open(A);
    const joined = await ack<{ screenToken?: string }>(tvOnA, 'screen:join', { slug, screenId: 'scr_late' });
    const tvOnB = open(B);
    expect((await ack(tvOnB, 'screen:join', { slug, screenId: 'scr_late', screenToken: joined.screenToken })).ok).toBe(true);
    tvOnA.disconnect();
    await sleep(800);
    expect((await lobbyAt(A, slug)).screens).toEqual(['scr_late']);
  });

  it('drops a TV that left even when the instance that saw it go never checks again', async () => {
    const slug = await remoteLobby();
    const hostTv = open(C);
    await ack(hostTv, 'screen:join', { slug, screenId: 'scr_gone' });
    const otherTv = open(B);
    await ack(otherTv, 'screen:join', { slug, screenId: 'scr_stays' });
    expect((await lobbyAt(B, slug)).hostScreenId).toBe('scr_gone');

    hostTv.disconnect();
    // C noted the drop but its timer won't fire; the polls on A or B do it.
    await expect
      .poll(async () => (await lobbyAt(A, slug)).screens, { timeout: 5_000, interval: 200 })
      .toEqual(['scr_stays']);
    expect((await lobbyAt(B, slug)).hostScreenId).toBe('scr_stays');
    expect((await ack(otherTv, 'game:state', { slug, epoch: 'e', seq: 1, state: {} })).ok).toBe(true);
  });
});
