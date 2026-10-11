import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { ExternalGameManifest } from '@couch/types';
import { createRealtimeServer, type RealtimeServerInstance } from '../src/index.js';

const DUEL: ExternalGameManifest = {
  id: 'screen-duel',
  title: 'Screen Duel',
  description: 'Test game.',
  minPlayers: 1,
  maxPlayers: 4,
  controllerLayout: { kind: 'generic-buttons', controls: [{ control: 'jump', type: 'button', label: 'Jump' }] },
  aspectRatio: '16:9',
  estimatedDurationMinutes: 1,
  status: 'published',
  origin: 'external',
  entryUrl: 'https://games.example.com/duel/',
  supportsRemote: true,
  sdkProtocol: 1,
  publishedAt: '2026-10-01T00:00:00.000Z',
  thumbnail: { kind: 'css', gradient: 'linear-gradient(#000,#111)', icon: 'Zap' }
};

type Ack<T = unknown> = T & { ok: boolean; error?: string; status?: number };

describe('host screens (host-authoritative broadcast)', () => {
  let instance: RealtimeServerInstance;
  let url = '';
  const sockets: Socket[] = [];

  beforeAll(async () => {
    process.env.EXTERNAL_GAMES_JSON = JSON.stringify([DUEL]);
    instance = createRealtimeServer({ screenGraceMs: 150 });
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

  function collect(socket: Socket, event: string): unknown[] {
    const seen: unknown[] = [];
    socket.on(event, (e: unknown) => seen.push(e));
    return seen;
  }

  async function remoteLobby(): Promise<string> {
    const created = await fetch(`${url}/api/lobbies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"mode":"remote"}'
    }).then((r) => r.json());
    return created.lobby.slug;
  }

  // Two TVs and a phone each: Alex (host) sits at TV A, Bea at TV B.
  async function twoScreens(gameRunning = false) {
    const slug = await remoteLobby();
    const tvA = open();
    const tvB = open();
    const joinA = await ack<{ screenToken?: string }>(tvA, 'screen:join', { slug, screenId: 'scr_tva' });
    const joinB = await ack<{ screenToken?: string }>(tvB, 'screen:join', { slug, screenId: 'scr_tvb' });
    const alex = open();
    const bea = open();
    const host = await ack<{ playerToken: string; player: { id: string } }>(alex, 'controller:join', { slug, name: 'Alex', screenId: 'scr_tva' });
    const guest = await ack<{ playerToken: string; player: { id: string } }>(bea, 'controller:join', { slug, name: 'Bea', screenId: 'scr_tvb' });
    if (gameRunning) {
      await ack(alex, 'game:select', { slug, playerToken: host.playerToken, gameId: DUEL.id });
      expect((await ack(alex, 'game:start', { slug, playerToken: host.playerToken })).ok).toBe(true);
    }
    return { slug, tvA, tvB, joinA, joinB, alex, bea, host, guest };
  }

  const lobbyOf = (slug: string) => fetch(`${url}/api/lobbies/${slug}`).then((r) => r.json()).then((body) => body.lobby);

  it('relays the host screen to the other screens and refuses everyone else', async () => {
    const { slug, tvA, tvB, alex } = await twoScreens();
    const atGuest = collect(tvB, 'game:state');
    const atHost = collect(tvA, 'game:state');

    expect((await ack(tvA, 'game:state', { slug, epoch: 'run1', seq: 1, state: { x: 5 } })).ok).toBe(true);
    await expect.poll(() => atGuest.length).toBe(1);
    expect(atGuest[0]).toMatchObject({ epoch: 'run1', seq: 1, state: { x: 5 } });
    expect(atHost).toHaveLength(0);

    const fromGuest = await ack(tvB, 'game:state', { slug, epoch: 'x', seq: 1, state: {} });
    expect(fromGuest).toMatchObject({ ok: false, status: 403 });
    const fromPhone = await ack(alex, 'game:state', { slug, epoch: 'x', seq: 1, state: {} });
    expect(fromPhone).toMatchObject({ ok: false, status: 403 });
    const tooBig = await ack(tvA, 'game:state', { slug, epoch: 'run1', seq: 2, state: 'x'.repeat(40_000) });
    expect(tooBig).toMatchObject({ ok: false, status: 413 });
    const badEpoch = await ack(tvA, 'game:state', { slug, epoch: 'e'.repeat(33), seq: 2, state: {} });
    expect(badEpoch).toMatchObject({ ok: false, status: 400 });
  });

  it('sends game:state and game:input to screens only, controller:state to its player only', async () => {
    const { slug, tvA, tvB, alex, bea, host, guest } = await twoScreens(true);
    const inputsAtB = collect(tvB, 'game:input');
    const statesAtAlex = collect(alex, 'game:state');
    const inputsAtAlex = collect(alex, 'game:input');
    const inputsAtBea = collect(bea, 'game:input');
    const controllerAtAlex = collect(alex, 'controller:state');
    const controllerAtBea = collect(bea, 'controller:state');

    await ack(tvA, 'game:state', { slug, epoch: 'run1', seq: 1, state: { x: 1 } });
    await ack(bea, 'controller:event', {
      slug,
      playerToken: guest.playerToken,
      event: { playerId: 'x', type: 'game', control: 'jump', value: { action: 'press' }, timestamp: Date.now() }
    });
    const patched = await ack(tvA, 'screen:controller', { slug, playerId: guest.player.id, patch: { labels: { jump: 'HOP' } } });
    expect(patched).toMatchObject({ ok: true, state: { labels: { jump: 'HOP' } } });

    await expect.poll(() => inputsAtB.length).toBe(1);
    await expect.poll(() => controllerAtBea.length).toBe(1);
    // A round trip on each phone socket flushes anything still in flight to it.
    await ack(alex, 'controller:rename', { slug, playerToken: host.playerToken, name: 'Alex' });
    await ack(bea, 'controller:rename', { slug, playerToken: guest.playerToken, name: 'Bea' });
    expect(statesAtAlex).toHaveLength(0);
    expect(inputsAtAlex).toHaveLength(0);
    expect(inputsAtBea).toHaveLength(0);
    expect(controllerAtAlex).toHaveLength(0);
  });

  it('binds a screen id to its first join, so the public host id cannot be joined as', async () => {
    const { slug, joinA } = await twoScreens();
    expect(typeof joinA.screenToken).toBe('string');

    // The host screen id is public (lobby snapshot); knowing it is not enough.
    expect((await lobbyOf(slug)).hostScreenId).toBe('scr_tva');
    const impostor = open();
    expect(await ack(impostor, 'screen:join', { slug, screenId: 'scr_tva' })).toMatchObject({ ok: false, status: 403 });
    expect(await ack(impostor, 'screen:join', { slug, screenId: 'scr_tva', screenToken: 'nope' })).toMatchObject({ ok: false, status: 403 });
    expect(await ack(impostor, 'game:state', { slug, epoch: 'x', seq: 1, state: {} })).toMatchObject({ ok: false, status: 403 });

    // The real TV rejoining (reload, reconnect) presents its token.
    const reloaded = open();
    const rejoin = await ack<{ screenToken?: string }>(reloaded, 'screen:join', { slug, screenId: 'scr_tva', screenToken: joinA.screenToken });
    expect(rejoin.ok).toBe(true);
    expect(rejoin.screenToken).toBeUndefined();
    expect((await ack(reloaded, 'game:state', { slug, epoch: 'run2', seq: 1, state: {} })).ok).toBe(true);
  });

  it('refuses screens beyond the maximum instead of evicting the host screen', async () => {
    const { slug, tvA } = await twoScreens();
    for (let i = 0; i < 6; i++) {
      expect((await ack(open(), 'screen:join', { slug, screenId: `scr_extra${i}` })).ok).toBe(true);
    }
    expect(await ack(open(), 'screen:join', { slug, screenId: 'scr_onetoomany' })).toMatchObject({ ok: false, status: 409 });
    const lobby = await lobbyOf(slug);
    expect(lobby.screens).toHaveLength(8);
    expect(lobby.screens).not.toContain('scr_onetoomany');
    expect(lobby.hostScreenId).toBe('scr_tva');
    expect((await ack(tvA, 'game:state', { slug, epoch: 'run1', seq: 1, state: {} })).ok).toBe(true);
  });

  it('lets only the host screen finish the game or drive the phones', async () => {
    const { slug, tvA, tvB, bea, guest } = await twoScreens(true);
    const controllerAtBea = collect(bea, 'controller:state');

    const ignored = await ack(tvB, 'screen:controller', { slug, playerId: guest.player.id, patch: { disabled: ['jump'] } });
    expect(ignored).toEqual({ ok: true, ignored: true });
    expect((await lobbyOf(slug)).controllerState?.[guest.player.id]).toBeUndefined();

    const scores = [{ playerId: guest.player.id, score: 99 }];
    expect(await ack(tvB, 'game:finish', { slug, scores })).toMatchObject({ ok: false, status: 403 });
    expect((await lobbyOf(slug)).state).toBe('playing');

    expect(await ack(tvA, 'screen:controller', { slug, playerId: guest.player.id, patch: { disabled: ['jump'] } })).toMatchObject({ ok: true });
    await expect.poll(() => controllerAtBea.length).toBe(1);
    expect(await ack(tvA, 'game:finish', { slug, scores })).toEqual({ ok: true, finished: true });
    expect((await lobbyOf(slug)).state).toBe('ended');
  });

  it('drops a screen whose TV is gone after the grace period, so a live screen takes over', async () => {
    const { slug, tvA, tvB, joinB } = await twoScreens(true);
    tvA.disconnect();
    await expect.poll(async () => (await lobbyOf(slug)).screens, { timeout: 5_000 }).toEqual(['scr_tvb']);
    const lobby = await lobbyOf(slug);
    // Alex still sits at TV A, but a dead seat is never the host screen.
    expect(lobby.players.find((p: { name: string }) => p.name === 'Alex').screenId).toBe('scr_tva');
    expect(lobby.hostScreenId).toBe('scr_tvb');
    expect((await ack(tvB, 'game:state', { slug, epoch: 'run2', seq: 1, state: {} })).ok).toBe(true);
    expect(joinB.ok).toBe(true);
  });

  it('keeps a screen that comes back within the grace period (reload)', async () => {
    const { slug, tvA, joinA } = await twoScreens();
    tvA.disconnect();
    const reloaded = open();
    expect((await ack(reloaded, 'screen:join', { slug, screenId: 'scr_tva', screenToken: joinA.screenToken })).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const lobby = await lobbyOf(slug);
    expect(lobby.screens).toEqual(['scr_tva', 'scr_tvb']);
    expect(lobby.hostScreenId).toBe('scr_tva');
  });
});
