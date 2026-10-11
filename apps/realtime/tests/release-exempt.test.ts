import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { ExternalGameManifest } from '@couch/types';
import { createRealtimeServer, type RealtimeServerInstance } from '../src/index.js';

const PAD: ExternalGameManifest = {
  id: 'release-pad',
  title: 'Release Pad',
  description: 'Test game.',
  minPlayers: 1,
  maxPlayers: 4,
  controllerLayout: { kind: 'generic-buttons', controls: [{ control: 'run', type: 'button', label: 'Run' }] },
  aspectRatio: '16:9',
  estimatedDurationMinutes: 1,
  status: 'published',
  origin: 'external',
  entryUrl: 'https://games.example.com/pad/',
  sdkProtocol: 1,
  publishedAt: '2026-10-01T00:00:00.000Z',
  thumbnail: { kind: 'css', gradient: 'linear-gradient(#000,#111)', icon: 'Zap' }
};

describe('rate limit never drops a release', () => {
  let instance: RealtimeServerInstance;
  let url = '';
  const sockets: Socket[] = [];

  beforeAll(async () => {
    process.env.EXTERNAL_GAMES_JSON = JSON.stringify([PAD]);
    instance = createRealtimeServer();
    await new Promise<void>((resolve) => instance.server.listen(0, resolve));
    url = `http://localhost:${(instance.server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    for (const socket of sockets) socket.disconnect();
    instance.io.close();
    delete process.env.EXTERNAL_GAMES_JSON;
  });

  function ack<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
    return new Promise((resolve, reject) =>
      socket.emit(event, payload, (res: T & { ok?: boolean; error?: string }) =>
        res?.ok === false ? reject(new Error(res.error)) : resolve(res)
      )
    );
  }

  it('relays the release after the press budget is exhausted', async () => {
    const created = await fetch(`${url}/api/lobbies`, { method: 'POST' }).then((r) => r.json());
    const slug: string = created.lobby.slug;
    const phone = connect(url, { transports: ['websocket'], forceNew: true });
    sockets.push(phone);
    const host = await ack<{ playerToken: string }>(phone, 'controller:join', { slug, name: 'Ann' });
    await ack(phone, 'game:select', { slug, playerToken: host.playerToken, gameId: PAD.id });
    await ack(phone, 'game:start', { slug, playerToken: host.playerToken });

    const send = (action: 'press' | 'release') =>
      ack<{ dropped?: boolean; seq?: number }>(phone, 'controller:event', {
        slug,
        playerToken: host.playerToken,
        event: { playerId: 'x', type: 'game', control: 'run', value: { action }, timestamp: Date.now() }
      });

    const presses = [];
    for (let i = 0; i < 60; i++) presses.push(await send('press'));
    expect(presses.some((res) => res.dropped)).toBe(true);
    expect((await send('press')).dropped).toBe(true);

    const release = await send('release');
    expect(release.dropped).toBeUndefined();
    expect(typeof release.seq).toBe('number');
  });
});
