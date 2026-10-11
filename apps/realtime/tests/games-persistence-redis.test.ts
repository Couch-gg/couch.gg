import { createClient } from 'redis';
import { describe, expect, it } from 'vitest';
import { createProductionGamePersistence } from '../src/persistence.js';
import { GamesRegistry, type PublishedGameRecord } from '../src/games-registry.js';

// The Redis games store's conditional writes. Needs a real Redis: run with
// TEST_REDIS_URL=redis://localhost:6379. Two stores = two connections, like
// two serverless instances.
const redisUrl = process.env.TEST_REDIS_URL;

function record(id: string, title = 'Stored'): PublishedGameRecord {
  return {
    manifest: {
      id,
      title,
      description: 'A stored game.',
      minPlayers: 1,
      maxPlayers: 4,
      controllerLayout: { kind: 'generic-buttons', controls: [{ control: 'tap', type: 'button', label: 'Tap' }] },
      aspectRatio: '16:9',
      estimatedDurationMinutes: 2,
      thumbnail: { kind: 'css', gradient: 'linear-gradient(#000,#111)', icon: 'zap' },
      entryUrl: 'https://games.example.com/stored/',
      sdkProtocol: 1,
      origin: 'external',
      status: 'published',
      publishedAt: '2026-10-01T00:00:00.000Z'
    },
    managementTokenHash: 'ab'.repeat(32),
    createdAt: 1,
    updatedAt: 1,
    featured: false,
    hidden: false,
    reports: 0,
    probe: { status: 'unverified', lastCheckedAt: null, failCount: 0 }
  };
}

const uniqueId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describe.skipIf(!redisUrl)('Redis games store', () => {
  const a = createProductionGamePersistence(redisUrl);
  const b = createProductionGamePersistence(redisUrl);
  const c = createProductionGamePersistence(redisUrl);

  it('creates a record only on a free id', async () => {
    const id = uniqueId('create');
    expect(await a.createGame(record(id, 'First'))).toBe(true);
    expect(await b.createGame(record(id, 'Second'))).toBe(false);
    expect((await a.loadGame(id))?.manifest.title).toBe('First');
    expect((await b.listGames()).filter((game) => game.manifest.id === id)).toHaveLength(1);
  });

  it('loses no concurrent update and keeps a takedown made in between', async () => {
    const id = uniqueId('update');
    await a.createGame(record(id));
    let attempts = 0;
    const increment = (store: typeof a) =>
      store.updateGame(id, (current) => {
        attempts++;
        return { ...current, reports: current.reports + 1 };
      });
    await Promise.all([
      increment(a),
      increment(b),
      b.updateGame(id, (current) => ({ ...current, hidden: true })),
      increment(a),
      increment(b),
      increment(a)
    ]);
    expect(await a.loadGame(id)).toMatchObject({ hidden: true, reports: 5 });
    // Some writes had to start over (a plain GET + SET would have lost them).
    expect(attempts).toBeGreaterThan(5);
  });

  it('lands every one of many concurrent writes to one game', async () => {
    // Without a pause between attempts, writers that collided collide again
    // in lockstep and some run out of attempts (a 500 for an admin takedown).
    const id = uniqueId('crowd');
    await a.createGame(record(id));
    const stores = [a, b, c];
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, (_, i) =>
        stores[i % stores.length].updateGame(id, (current) => ({ ...current, reports: current.reports + 1 }))
      )
    );
    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    expect(await a.loadGame(id)).toMatchObject({ reports: 16 });
  });

  it('writes nothing for a probe ok on a game that is already ok', async () => {
    const id = uniqueId('healthy');
    await a.createGame({ ...record(id), probe: { status: 'ok', lastCheckedAt: 1_000, failCount: 0, failedBy: [] } });
    const registry = new GamesRegistry(a);
    // EXEC on a connection that WATCHes the key fails once anything wrote it.
    const watcher = createClient({ url: redisUrl });
    await watcher.connect();
    try {
      const key = `couch:game:${id}`;
      await watcher.watch(key);
      await registry.probeResult(id, true, 'tv-a', 2_000);
      await expect(watcher.multi().get(key).exec()).resolves.toHaveLength(1);
      // Once lastCheckedAt is old, the ok is written.
      await watcher.watch(key);
      await registry.probeResult(id, true, 'tv-a', 1_000 + 10 * 60_000);
      await expect(watcher.multi().get(key).exec()).rejects.toThrow();
      expect((await b.loadGame(id))?.probe.lastCheckedAt).toBe(601_000);
    } finally {
      watcher.destroy();
    }
  });

  it('never recreates a deleted record on update', async () => {
    const id = uniqueId('gone');
    await a.createGame(record(id));
    expect(await b.deleteGame(id)).toBe(true);
    expect(await a.updateGame(id, (current) => ({ ...current, reports: 9 }))).toBeNull();
    expect(await a.loadGame(id)).toBeNull();
    expect((await a.listGames()).some((game) => game.manifest.id === id)).toBe(false);
  });

  it('deletes only what the check accepts', async () => {
    const id = uniqueId('delete');
    await a.createGame(record(id));
    await expect(
      a.deleteGame(id, () => {
        throw new Error('wrong token');
      })
    ).rejects.toThrow('wrong token');
    expect(await a.loadGame(id)).not.toBeNull();
    expect(await a.deleteGame(id, () => undefined)).toBe(true);
    expect(await a.deleteGame(id)).toBe(false);
    expect((await b.listGames()).some((game) => game.manifest.id === id)).toBe(false);
  });

  it('hands out a one-time claim once, on every connection', async () => {
    const key = uniqueId('claim');
    expect(await a.claimOnce(key, 60_000)).toBe(true);
    expect(await b.claimOnce(key, 60_000)).toBe(false);
    expect(await b.claimOnce(`${key}-other`, 60_000)).toBe(true);
  });

  it('counts hits in a window shared by every connection, and starts a new one after it', async () => {
    const key = uniqueId('hits');
    expect(await a.countHit(key, 150)).toBe(1);
    expect(await b.countHit(key, 150)).toBe(2);
    expect(await a.countHit(`${key}-other`, 150)).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await b.countHit(key, 150)).toBe(1);
  });
});
