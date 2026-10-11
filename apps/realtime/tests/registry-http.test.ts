import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { clientId, clientIdKey } from '../src/client-id.js';
import { createRealtimeServer, type RealtimeServerInstance } from '../src/index.js';
import { createProductionGamePersistence } from '../src/persistence.js';

// The published-games REST surface end to end: probe-result only counts from
// the host screen of a lobby playing the game, once per game session; reports
// and probe failures count once per client; an admin restore really brings a
// game back. The last block runs two instances on one Redis (TEST_REDIS_URL).

type Ack<T = unknown> = T & { ok: boolean; error?: string; status?: number };

const ADMIN_KEY = 'test-admin-key';
const redisUrl = process.env.TEST_REDIS_URL;

let htmlServer: http.Server;
let entryUrl = '';
const previousAdminKey = process.env.ADMIN_KEY;

beforeAll(async () => {
  // A live HTML page for the submit probe.
  htmlServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>game</title>');
  });
  await new Promise<void>((resolve) => htmlServer.listen(0, '127.0.0.1', resolve));
  entryUrl = `http://127.0.0.1:${(htmlServer.address() as AddressInfo).port}/`;
  process.env.ADMIN_KEY = ADMIN_KEY;
});

afterAll(() => {
  htmlServer.close();
  if (previousAdminKey === undefined) delete process.env.ADMIN_KEY;
  else process.env.ADMIN_KEY = previousAdminKey;
});

function manifest(id: string): Record<string, unknown> {
  return {
    id,
    title: 'Probe Target',
    description: 'A registry game for the REST tests.',
    minPlayers: 1,
    maxPlayers: 4,
    controllerLayout: { kind: 'generic-buttons', controls: [{ control: 'tap', type: 'button', label: 'Tap' }] },
    aspectRatio: '16:9',
    estimatedDurationMinutes: 2,
    thumbnail: { kind: 'css', gradient: 'linear-gradient(#000,#111)', icon: 'zap' },
    entryUrl,
    sdkProtocol: 1,
    supportsRemote: true
  };
}

// A client address of its own, so reruns against one Redis don't share budgets.
function randomIp(): string {
  return `10.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
}

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function start(at: string): Promise<RealtimeServerInstance & { url: string }> {
  const instance = createRealtimeServer();
  await new Promise<void>((resolve) => instance.server.listen(0, resolve));
  return Object.assign(instance, { url: `http://localhost:${(instance.server.address() as AddressInfo).port}${at}` });
}

// Publish a game on `submitAt`, then on `lobbyAt` open a lobby with a TV
// (screen id + token) and a player, select the game and start it.
async function runningGame(submitAt: string, lobbyAt: string, sockets: Socket[], socketUrl: string) {
  const gameId = uniqueId('probe');
  const submitted = await post(`${submitAt}/games`, { manifest: manifest(gameId) });
  expect(submitted.status).toBe(201);
  const created = await post(`${lobbyAt}/lobbies`, {});
  const slug = (created.body.lobby as { slug: string }).slug;
  const tv = connect(socketUrl, { transports: ['websocket'], forceNew: true });
  sockets.push(tv);
  const screenId = `scr_${Math.random().toString(36).slice(2, 10)}`;
  const joined = await new Promise<Ack<{ screenToken?: string }>>((resolve) =>
    tv.emit('screen:join', { slug, screenId }, resolve)
  );
  expect(joined.ok).toBe(true);
  const player = await post(`${lobbyAt}/lobbies/${slug}/players`, { name: 'Alex' });
  const playerToken = player.body.playerToken as string;
  for (const [event, payload] of [
    ['game:select', { slug, playerToken, gameId }],
    ['game:start', { slug, playerToken }]
  ] as const) {
    const acked = await new Promise<Ack>((resolve) => tv.emit(event, payload, resolve));
    expect(acked.ok, `${event}: ${acked.error}`).toBe(true);
  }
  return {
    gameId,
    slug,
    screenId,
    screenToken: joined.screenToken!,
    managementToken: submitted.body.managementToken as string,
    playerToken
  };
}

describe('published games over REST', () => {
  let instance: RealtimeServerInstance & { url: string };
  let api = '';
  const sockets: Socket[] = [];

  beforeAll(async () => {
    instance = await start('');
    api = `${instance.url}/api`;
  });

  afterAll(() => {
    for (const socket of sockets) socket.disconnect();
    instance.io.close();
  });

  it('counts a probe result only from the host screen, once per game session', async () => {
    const game = await runningGame(api, api, sockets, instance.url);
    const url = `${api}/games/${game.gameId}/probe-result`;
    const ip = { 'x-forwarded-for': '198.51.100.7' };

    // No screen credentials, a wrong token, an unknown slug: not counted.
    expect((await post(url, { slug: game.slug, ok: false }, ip)).body.counted).toBe(false);
    expect(
      (await post(url, { slug: game.slug, ok: false, screenId: game.screenId, screenToken: 'nope' }, ip)).body.counted
    ).toBe(false);
    expect((await post(url, { slug: 'ZZZZZZ', ok: false }, ip)).body.counted).toBe(false);

    const counted = await post(url, { slug: game.slug, ok: true, screenId: game.screenId, screenToken: game.screenToken }, ip);
    expect(counted.status).toBe(200);
    expect(counted.body).toMatchObject({ counted: true, status: 'ok' });

    // The same session again, ok or not: not counted.
    const again = await post(url, { slug: game.slug, ok: false, screenId: game.screenId, screenToken: game.screenToken }, ip);
    expect(again.status).toBe(202);
    expect(again.body.counted).toBe(false);

    // A probe for another game than the one running: not counted.
    const other = await post(`${api}/games/trebuchet/probe-result`, {
      slug: game.slug,
      ok: false,
      screenId: game.screenId,
      screenToken: game.screenToken
    });
    expect(other.body.counted).toBe(false);
  });

  it('rate-limits probe results per client', async () => {
    const ip = { 'x-forwarded-for': '203.0.113.99' };
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await post(`${api}/games/nope/probe-result`, { slug: '' }, ip)).status);
    expect(statuses.slice(0, 30).every((status) => status === 202)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it('counts reports per client, hides at 3 clients and comes back on restore', async () => {
    const gameId = uniqueId('reported');
    expect((await post(`${api}/games`, { manifest: manifest(gameId) })).status).toBe(201);
    const report = (ip: string) => post(`${api}/games/${gameId}/report`, {}, { 'x-forwarded-for': ip });
    const listed = async () =>
      ((await (await fetch(`${api}/games`)).json()) as { games: Array<{ id: string }> }).games.some((g) => g.id === gameId);

    expect((await report('192.0.2.1')).body).toMatchObject({ counted: true, hidden: false });
    expect((await report('192.0.2.1')).body).toMatchObject({ counted: false, hidden: false });
    // Addresses in one IPv6 /64 are one client.
    expect((await report('2001:db8:1:2::10')).body).toMatchObject({ counted: true, hidden: false });
    expect((await report('2001:db8:1:2:aaaa::20')).body).toMatchObject({ counted: false, hidden: false });
    expect(await listed()).toBe(true);
    expect((await report('192.0.2.3')).body).toMatchObject({ counted: true, hidden: true });
    expect(await listed()).toBe(false);

    const restored = await post(`${api}/admin/games/${gameId}/restore`, {}, { 'x-admin-key': ADMIN_KEY });
    expect(restored.status).toBe(200);
    expect(restored.body.game).toMatchObject({ hidden: false, reports: 0 });
    expect(await listed()).toBe(true);
    // One more report after the restore doesn't hide it again.
    expect((await report('192.0.2.4')).body).toMatchObject({ counted: true, hidden: false });
    expect(await listed()).toBe(true);
  });

  it('rate-limits reports per client', async () => {
    const ip = { 'x-forwarded-for': '192.0.2.200' };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post(`${api}/games/nope/report`, {}, ip)).status);
    expect(statuses).toEqual([404, 404, 404, 404, 404, 429]);
  });

  it('brings a probe-failed game back on restore', async () => {
    const gameId = uniqueId('failing');
    expect((await post(`${api}/games`, { manifest: manifest(gameId) })).status).toBe(201);
    const restore = () => post(`${api}/admin/games/${gameId}/restore`, {}, { 'x-admin-key': ADMIN_KEY });
    const admin = async () =>
      ((await (await fetch(`${api}/admin/games`, { headers: { 'x-admin-key': ADMIN_KEY } })).json()) as {
        games: Array<{ manifest: { id: string }; probe: { status: string; failCount: number } }>;
      }).games.find((g) => g.manifest.id === gameId);

    // Three sessions on three TVs (clients) fail to load it.
    for (const [i, ip] of ['198.51.100.21', '198.51.100.22', '198.51.100.23'].entries()) {
      const created = await post(`${api}/lobbies`, {});
      const slug = (created.body.lobby as { slug: string }).slug;
      const tv = connect(instance.url, { transports: ['websocket'], forceNew: true });
      sockets.push(tv);
      const screenId = `scr_fail${i}`;
      const joined = await new Promise<Ack<{ screenToken?: string }>>((resolve) =>
        tv.emit('screen:join', { slug, screenId }, resolve)
      );
      const player = await post(`${api}/lobbies/${slug}/players`, { name: 'Alex' });
      const playerToken = player.body.playerToken as string;
      await new Promise((resolve) => tv.emit('game:select', { slug, playerToken, gameId }, resolve));
      await new Promise((resolve) => tv.emit('game:start', { slug, playerToken }, resolve));
      const result = await post(
        `${api}/games/${gameId}/probe-result`,
        { slug, ok: false, screenId, screenToken: joined.screenToken },
        { 'x-forwarded-for': ip }
      );
      expect(result.body.counted).toBe(true);
    }
    const failed = await admin();
    expect(failed?.probe).toMatchObject({ status: 'failed', failCount: 3 });
    // The admin sees how many TVs failed, not who they were.
    expect(failed?.probe).not.toHaveProperty('failedBy');
    expect(failed).not.toHaveProperty('reporters');
    expect((await restore()).status).toBe(200);
    expect((await admin())?.probe.status).toBe('unverified');
    const games = ((await (await fetch(`${api}/games`)).json()) as { games: Array<{ id: string }> }).games;
    expect(games.some((g) => g.id === gameId)).toBe(true);
  });
});

describe.skipIf(!redisUrl)('published games across instances on one Redis', () => {
  const servers: Array<RealtimeServerInstance & { url: string }> = [];
  const sockets: Socket[] = [];
  const previousRedisUrl = process.env.REDIS_URL;

  beforeAll(async () => {
    process.env.REDIS_URL = redisUrl;
    for (let i = 0; i < 3; i++) servers.push(await start(''));
  });

  afterAll(() => {
    for (const socket of sockets) socket.disconnect();
    for (const instance of servers) instance.io.close();
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
  });

  const api = (at: number) => `${servers[at].url}/api`;
  const catalogIds = async (at: number) =>
    ((await (await fetch(`${api(at)}/games`)).json()) as { games: Array<{ id: string }> }).games.map((g) => g.id);
  // A new instance: its first catalog request lists the store into its cache,
  // which it then keeps for 30 s.
  const freshInstance = async () => {
    servers.push(await start(''));
    return servers.length - 1;
  };

  it('counts a probe result that lands on another instance than the lobby', async () => {
    const game = await runningGame(api(0), api(0), sockets, servers[0].url);
    const ip = randomIp();
    const result = await post(
      `${api(1)}/games/${game.gameId}/probe-result`,
      { slug: game.slug, ok: true, screenId: game.screenId, screenToken: game.screenToken },
      { 'x-forwarded-for': ip }
    );
    expect(result.body).toMatchObject({ counted: true, status: 'ok' });
    // The session's claim holds on every instance.
    const again = await post(
      `${api(2)}/games/${game.gameId}/probe-result`,
      { slug: game.slug, ok: false, screenId: game.screenId, screenToken: game.screenToken },
      { 'x-forwarded-for': ip }
    );
    expect(again.body.counted).toBe(false);
  });

  it('counts a client once on every instance, by an id its IP alone does not give', async () => {
    const gameId = uniqueId('reporter');
    expect((await post(`${api(0)}/games`, { manifest: manifest(gameId) })).status).toBe(201);
    const ip = randomIp();
    const report = (at: number) => post(`${api(at)}/games/${gameId}/report`, {}, { 'x-forwarded-for': ip });
    expect((await report(0)).body).toMatchObject({ counted: true });
    expect((await report(1)).body).toMatchObject({ counted: false });
    const stored = await createProductionGamePersistence(redisUrl).loadGame(gameId);
    // Keyed by the deployment's secret (here derived from REDIS_URL and ADMIN_KEY).
    expect(stored?.reporters).toEqual([clientId(ip, clientIdKey())]);
    const unsalted = createHash('sha256').update(`couch-client:${ip}`).digest('hex').slice(0, 32);
    expect(stored?.reporters).not.toContain(unsalted);
  });

  it('keeps a takedown made on another instance while this one has the game cached', async () => {
    const gameId = uniqueId('takedown');
    expect((await post(`${api(0)}/games`, { manifest: manifest(gameId) })).status).toBe(201);
    const stale = await freshInstance();
    expect(await catalogIds(stale)).toContain(gameId);
    const takedown = await post(`${api(2)}/admin/games/${gameId}/takedown`, {}, { 'x-admin-key': ADMIN_KEY });
    expect(takedown.status).toBe(200);
    // The stale instance still lists it from its cache, but writes to the stored record.
    expect(await catalogIds(stale)).toContain(gameId);
    expect((await post(`${api(stale)}/games/${gameId}/report`, {}, { 'x-forwarded-for': randomIp() })).body).toMatchObject({
      hidden: true
    });
    expect(await catalogIds(await freshInstance())).not.toContain(gameId);
  });

  it('does not bring back a game deleted on another instance', async () => {
    const gameId = uniqueId('deleted');
    const submitted = await post(`${api(0)}/games`, { manifest: manifest(gameId) });
    const stale = await freshInstance();
    expect(await catalogIds(stale)).toContain(gameId);
    const deleted = await fetch(`${api(0)}/games/${gameId}`, {
      method: 'DELETE',
      headers: { 'x-management-token': submitted.body.managementToken as string }
    });
    expect(deleted.status).toBe(204);
    const report = await post(`${api(stale)}/games/${gameId}/report`, {}, { 'x-forwarded-for': randomIp() });
    expect(report.status).toBe(404);
    expect(await catalogIds(await freshInstance())).not.toContain(gameId);
  });

  it('refuses a submit of an id another instance published meanwhile', async () => {
    const gameId = uniqueId('taken');
    const stale = await freshInstance();
    expect(await catalogIds(stale)).not.toContain(gameId); // lists before the game exists
    const first = await post(`${api(0)}/games`, { manifest: manifest(gameId) });
    expect(first.status).toBe(201);
    const second = await post(`${api(stale)}/games`, { manifest: { ...manifest(gameId), title: 'Hijacked' } });
    expect(second.status).toBe(409);
    // The first publisher keeps the game and its token.
    const renamed = await fetch(`${api(stale)}/games/${gameId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-management-token': first.body.managementToken as string },
      body: JSON.stringify({ manifest: { ...manifest(gameId), title: 'Still Mine' } })
    });
    expect(renamed.status).toBe(200);
  });
});
