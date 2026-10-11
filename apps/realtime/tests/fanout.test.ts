import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe.skipIf(!redisUrl)('Redis fan-out across instances', () => {
  const servers: RealtimeServerInstance[] = [];
  const sockets: Socket[] = [];
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
});
