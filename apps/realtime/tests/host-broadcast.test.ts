import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { createRealtimeServer, type RealtimeServerInstance } from '../src/index.js';

describe('game:state (host-authoritative broadcast)', () => {
  let instance: RealtimeServerInstance;
  let url = '';
  const sockets: Socket[] = [];

  beforeAll(async () => {
    instance = createRealtimeServer();
    await new Promise<void>((resolve) => instance.server.listen(0, resolve));
    url = `http://localhost:${(instance.server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    for (const socket of sockets) socket.disconnect();
    instance.io.close();
  });

  function open(): Socket {
    const socket = connect(url, { transports: ['websocket'], forceNew: true });
    sockets.push(socket);
    return socket;
  }

  function ack<T>(socket: Socket, event: string, payload: unknown): Promise<T & { ok: boolean; error?: string }> {
    return new Promise((resolve) => socket.emit(event, payload, resolve));
  }

  it('relays the host screen to the other screens and refuses everyone else', async () => {
    const created = await fetch(`${url}/api/lobbies`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mode":"remote"}' }).then((r) => r.json());
    const slug: string = created.lobby.slug;

    const hostTv = open();
    const guestTv = open();
    await ack(hostTv, 'screen:join', { slug, screenId: 'scr_hostscreen' });
    await ack(guestTv, 'screen:join', { slug, screenId: 'scr_guestscreen' });
    const phone = open();
    await ack(phone, 'controller:join', { slug, name: 'Alex', screenId: 'scr_hostscreen' });

    const atGuest: unknown[] = [];
    const atHost: unknown[] = [];
    guestTv.on('game:state', (e: unknown) => atGuest.push(e));
    hostTv.on('game:state', (e: unknown) => atHost.push(e));

    expect((await ack(hostTv, 'game:state', { slug, seq: 1, state: { x: 5 } })).ok).toBe(true);
    await expect.poll(() => atGuest.length).toBe(1);
    expect(atGuest[0]).toMatchObject({ seq: 1, state: { x: 5 } });
    expect(atHost).toHaveLength(0);

    const fromGuest = await ack(guestTv, 'game:state', { slug, seq: 1, state: {} });
    expect(fromGuest).toMatchObject({ ok: false, status: 403 });
    const fromPhone = await ack(phone, 'game:state', { slug, seq: 1, state: {} });
    expect(fromPhone).toMatchObject({ ok: false, status: 403 });
    const tooBig = await ack(hostTv, 'game:state', { slug, seq: 2, state: 'x'.repeat(40_000) });
    expect(tooBig).toMatchObject({ ok: false, status: 413 });
  });
});
