import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { FALLBACK_THUMBNAIL_GRADIENT, FALLBACK_THUMBNAIL_ICON } from '@couch/game-runtime';
import { GameWriteConflictError, InMemoryGamePersistence, type GamePersistence } from '../src/persistence.js';
import {
  GamesRegistry,
  RegistryError,
  adminGameView,
  publicGame,
  type ProbeFn,
  type PublishedGameRecord
} from '../src/games-registry.js';

// The shipped in-memory store, built directly so the suite is independent of
// process.env (the factory branches on REDIS_URL / VERCEL). It clones on the way
// in and out so the registry can never mutate stored records by reference.
// listCalls counts real list calls for the ensureFresh single-flight assertion.
function makePersistence(): InMemoryGamePersistence & { listCalls: number } {
  const store = Object.assign(new InMemoryGamePersistence(), { listCalls: 0 });
  const list = store.listGames.bind(store);
  store.listGames = async () => {
    store.listCalls++;
    return list();
  };
  return store;
}

// A disabled persistence (models Vercel-without-Redis) to prove the 503 path.
const disabledPersistence: GamePersistence = {
  enabled: false,
  async loadGame() {
    return null;
  },
  async createGame() {
    throw new Error('disabled');
  },
  async updateGame() {
    return null;
  },
  async deleteGame() {
    return false;
  },
  async listGames() {
    return [];
  },
  async claimOnce() {
    return false;
  },
  async countHit() {
    return 0;
  }
};

// Minimal valid creator-supplied manifest input. Overrides let each test tweak
// one field without repeating the whole object.
function manifestInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tap-race',
    title: 'Tap Race',
    description: 'First to thirty taps wins.',
    minPlayers: 2,
    maxPlayers: 4,
    controllerLayout: {
      kind: 'generic-buttons',
      controls: [{ control: 'tap', type: 'button', label: 'Tap' }]
    },
    aspectRatio: '16:9',
    estimatedDurationMinutes: 3,
    thumbnail: { kind: 'css', gradient: 'linear-gradient(#000,#111)', icon: 'Zap' },
    entryUrl: 'https://games.example.com/tap-race/',
    sdkProtocol: 1,
    ...overrides
  };
}

const okProbe: ProbeFn = async () => true;
const failProbe: ProbeFn = async () => false;

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

async function submitTapRace(registry: GamesRegistry, overrides: Record<string, unknown> = {}) {
  return registry.submit(manifestInput(overrides), { probeFn: okProbe });
}

describe('submit', () => {
  it('publishes on the happy path and returns the token exactly once', async () => {
    const registry = new GamesRegistry(makePersistence());
    const { record, managementToken } = await submitTapRace(registry);

    expect(managementToken).toBeTruthy();
    expect(record.manifest.id).toBe('tap-race');
    expect(record.manifest.origin).toBe('external');
    expect(record.manifest.status).toBe('published');
    expect(typeof record.manifest.publishedAt).toBe('string');
    expect(record.hidden).toBe(false);
    expect(record.featured).toBe(false);
    expect(record.reports).toBe(0);
    // The record stores the sha256 hash, NEVER the plaintext token.
    expect(record.managementTokenHash).toBe(sha256Hex(managementToken));
    expect(record.managementTokenHash).not.toBe(managementToken);
    expect(JSON.stringify(record)).not.toContain(managementToken);
  });

  it('sets probe status from the handshake attestation (ok vs unverified)', async () => {
    const registry = new GamesRegistry(makePersistence());
    const withHandshake = await registry.submit(manifestInput({ id: 'hs-yes' }), {
      probeFn: okProbe,
      handshakeOk: true
    });
    const without = await registry.submit(manifestInput({ id: 'hs-no' }), { probeFn: okProbe });
    expect(withHandshake.record.probe.status).toBe('ok');
    expect(without.record.probe.status).toBe('unverified');
  });

  it('rejects a probe failure with 422 and does not publish', async () => {
    const registry = new GamesRegistry(makePersistence());
    await expect(registry.submit(manifestInput(), { probeFn: failProbe })).rejects.toMatchObject({
      status: 422
    });
    // Nothing was published.
    expect(registry.resolveById('tap-race')).toBeNull();
    expect(registry.listPublic()).toHaveLength(0);
  });

  it('propagates validator errors as a 422 with the error list', async () => {
    const registry = new GamesRegistry(makePersistence());
    let thrown: unknown;
    try {
      await registry.submit(manifestInput({ id: 'BAD ID' }), { probeFn: okProbe });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RegistryError);
    expect((thrown as RegistryError).status).toBe(422);
    expect((thrown as RegistryError).errors?.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects an id that collides with a reserved/builtin id (409)', async () => {
    const registry = new GamesRegistry(makePersistence());
    await expect(
      registry.submit(manifestInput({ id: 'my-game' }), { probeFn: okProbe, reservedIds: ['my-game'] })
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a double-submit of the same id (409)', async () => {
    const registry = new GamesRegistry(makePersistence());
    await submitTapRace(registry);
    await expect(submitTapRace(registry)).rejects.toMatchObject({ status: 409 });
  });

  it('throws 503 when persistence is disabled', async () => {
    const registry = new GamesRegistry(disabledPersistence);
    await expect(submitTapRace(registry)).rejects.toMatchObject({ status: 503 });
  });
});

describe('listPublic / resolveById', () => {
  it('folds the featured flag into the served manifest', async () => {
    const registry = new GamesRegistry(makePersistence());
    await submitTapRace(registry);
    await registry.setFeatured('tap-race', true);
    expect(registry.listPublic()[0].featured).toBe(true);
    expect(registry.resolveById('tap-race')?.featured).toBe(true);
  });

  it('hides hidden games from listPublic but still resolves them by id', async () => {
    const registry = new GamesRegistry(makePersistence());
    await submitTapRace(registry);
    await registry.setHidden('tap-race', true);
    expect(registry.listPublic()).toHaveLength(0);
    // resolveById still returns it so an in-progress game keeps resolving.
    expect(registry.resolveById('tap-race')?.id).toBe('tap-race');
  });

  it('hides probe-failed games from listPublic', async () => {
    const registry = new GamesRegistry(makePersistence());
    await submitTapRace(registry);
    await registry.probeResult('tap-race', false, 'tv-a');
    await registry.probeResult('tap-race', false, 'tv-b');
    await registry.probeResult('tap-race', false, 'tv-c');
    expect(registry.resolveById('tap-race')).not.toBeNull();
    expect(registry.listPublic()).toHaveLength(0);
  });

  it('never exposes the token hash via the public serializer', async () => {
    const registry = new GamesRegistry(makePersistence());
    const { record } = await submitTapRace(registry);
    const serialized = JSON.stringify(publicGame(record));
    expect(serialized).not.toContain('managementTokenHash');
    expect(serialized).not.toContain(record.managementTokenHash);
  });
});

describe('report auto-hide', () => {
  it('auto-hides after reports from 3 different clients', async () => {
    const registry = new GamesRegistry(makePersistence());
    await submitTapRace(registry);
    const first = await registry.report('tap-race', 'client-a');
    expect(first.record.hidden).toBe(false);
    const second = await registry.report('tap-race', 'client-b');
    expect(second.record.hidden).toBe(false);
    const third = await registry.report('tap-race', 'client-c');
    expect(third.counted).toBe(true);
    expect(third.record.hidden).toBe(true);
    expect(registry.listPublic()).toHaveLength(0);
  });

  it('counts each client once, however often it reports', async () => {
    const registry = new GamesRegistry(makePersistence());
    await submitTapRace(registry);
    const counted: boolean[] = [];
    for (let i = 0; i < 5; i++) counted.push((await registry.report('tap-race', 'client-a')).counted);
    expect(counted).toEqual([true, false, false, false, false]);
    const stored = (await registry.report('tap-race', 'client-a')).record;
    expect(stored.reports).toBe(1);
    expect(stored.hidden).toBe(false);
    expect(registry.listPublic()).toHaveLength(1);
  });

  it('throws 404 reporting an unknown game', async () => {
    const registry = new GamesRegistry(makePersistence());
    await expect(registry.report('nope', 'client-a')).rejects.toMatchObject({ status: 404 });
  });

  it('a restore clears the reports, so one more report does not hide it again', async () => {
    const registry = new GamesRegistry(makePersistence());
    await submitTapRace(registry);
    for (const client of ['client-a', 'client-b', 'client-c']) await registry.report('tap-race', client);
    const restored = await registry.setHidden('tap-race', false);
    expect(restored).toMatchObject({ hidden: false, reports: 0, reporters: [] });
    // Even an earlier reporter may report again after the restore.
    const again = await registry.report('tap-race', 'client-a');
    expect(again.counted).toBe(true);
    expect(again.record).toMatchObject({ hidden: false, reports: 1 });
  });

  it('keeps counting on top of a record stored before reporters were tracked', async () => {
    const persistence = makePersistence();
    const registry = new GamesRegistry(persistence);
    await submitTapRace(registry);
    await persistence.updateGame('tap-race', (record) => {
      const legacy = { ...record, reports: 2 };
      delete legacy.reporters;
      return legacy;
    });
    const third = await registry.report('tap-race', 'client-a');
    expect(third.record).toMatchObject({ reports: 3, hidden: true, reporters: ['client-a'] });
  });
});

describe('probeResult', () => {
  it('marks failed after failures from 3 different clients', async () => {
    const registry = new GamesRegistry(makePersistence());
    await submitTapRace(registry);
    await registry.probeResult('tap-race', false, 'tv-a');
    await registry.probeResult('tap-race', false, 'tv-b');
    const third = await registry.probeResult('tap-race', false, 'tv-c');
    expect(third.probe.status).toBe('failed');
    expect(third.probe.failCount).toBe(3);
  });

  it('counts the failures of one client once', async () => {
    const registry = new GamesRegistry(makePersistence());
    await submitTapRace(registry);
    for (let i = 0; i < 5; i++) await registry.probeResult('tap-race', false, 'tv-a');
    const stored = await registry.probeResult('tap-race', false, 'tv-a');
    expect(stored.probe).toMatchObject({ status: 'unverified', failCount: 1, failedBy: ['tv-a'] });
    expect(registry.listPublic()).toHaveLength(1);
  });

  it('one ok resets the fail count and status', async () => {
    const registry = new GamesRegistry(makePersistence());
    await submitTapRace(registry);
    await registry.probeResult('tap-race', false, 'tv-a');
    await registry.probeResult('tap-race', false, 'tv-b');
    const recovered = await registry.probeResult('tap-race', true, 'tv-c');
    expect(recovered.probe.status).toBe('ok');
    expect(recovered.probe.failCount).toBe(0);
    expect(recovered.probe.failedBy).toEqual([]);
    // And it is visible again.
    expect(registry.listPublic()).toHaveLength(1);
  });

  it('writes an ok for a game that is already ok once per 10 minutes', async () => {
    const persistence = makePersistence();
    const registry = new GamesRegistry(persistence);
    await registry.submit(manifestInput(), { probeFn: okProbe, handshakeOk: true, now: () => 1_000 });
    // Every start of a popular game reports ok: those leave the record alone...
    const soon = await registry.probeResult('tap-race', true, 'tv-a', 1_000 + 9 * 60_000);
    expect(soon).toMatchObject({ updatedAt: 1_000, probe: { status: 'ok', lastCheckedAt: 1_000 } });
    expect(await persistence.loadGame('tap-race')).toMatchObject({ updatedAt: 1_000 });
    // ...until lastCheckedAt is 10 minutes old.
    const later = await registry.probeResult('tap-race', true, 'tv-b', 1_000 + 10 * 60_000);
    expect(later).toMatchObject({ updatedAt: 601_000, probe: { status: 'ok', lastCheckedAt: 601_000 } });
    expect(await persistence.loadGame('tap-race')).toMatchObject({ updatedAt: 601_000 });
  });

  it('writes a failure that already counts once per 10 minutes, and an ok after failures at once', async () => {
    const persistence = makePersistence();
    const registry = new GamesRegistry(persistence);
    await submitTapRace(registry);
    await registry.probeResult('tap-race', false, 'tv-a', 5_000);
    const repeated = await registry.probeResult('tap-race', false, 'tv-a', 6_000);
    expect(repeated).toMatchObject({ updatedAt: 5_000, probe: { failCount: 1, lastCheckedAt: 5_000 } });
    const later = await registry.probeResult('tap-race', false, 'tv-a', 5_000 + 10 * 60_000);
    expect(later.probe).toMatchObject({ failCount: 1, lastCheckedAt: 605_000 });
    // An ok after a failure always counts, however recent the last check.
    const recovered = await registry.probeResult('tap-race', true, 'tv-b', 606_000);
    expect(recovered.probe).toMatchObject({ status: 'ok', failCount: 0, lastCheckedAt: 606_000 });
  });

  it('a restore takes a probe-failed game back into the catalog', async () => {
    const registry = new GamesRegistry(makePersistence());
    await submitTapRace(registry);
    for (const tv of ['tv-a', 'tv-b', 'tv-c']) await registry.probeResult('tap-race', false, tv);
    expect(registry.listPublic()).toHaveLength(0);
    const restored = await registry.setHidden('tap-race', false);
    expect(restored.probe).toMatchObject({ status: 'unverified', failCount: 0, failedBy: [] });
    expect(registry.listPublic()).toHaveLength(1);
  });

  it('gives each game session one claim', async () => {
    const registry = new GamesRegistry(makePersistence());
    expect(await registry.claimProbe('tap-race', 'session_1')).toBe(true);
    expect(await registry.claimProbe('tap-race', 'session_1')).toBe(false);
    expect(await registry.claimProbe('tap-race', 'session_2')).toBe(true);
    expect(await registry.claimProbe('other-game', 'session_1')).toBe(true);
  });
});

describe('management token verify / update / remove', () => {
  it('verifies the right token and rejects a wrong one', async () => {
    const registry = new GamesRegistry(makePersistence());
    const { managementToken } = await submitTapRace(registry);
    expect(registry.verifyManagementToken('tap-race', managementToken)).toBe(true);
    expect(registry.verifyManagementToken('tap-race', 'wrong-token')).toBe(false);
    expect(registry.verifyManagementToken('missing', managementToken)).toBe(false);
  });

  it('updates with the right token and re-validates', async () => {
    const registry = new GamesRegistry(makePersistence());
    const { managementToken } = await submitTapRace(registry);
    const updated = await registry.update(
      'tap-race',
      managementToken,
      manifestInput({ title: 'Tap Race Deluxe' })
    );
    expect(updated.manifest.title).toBe('Tap Race Deluxe');
    // publishedAt is preserved across updates.
    expect(updated.manifest.publishedAt).toBeTruthy();
  });

  it('rejects an update with the wrong token (401)', async () => {
    const registry = new GamesRegistry(makePersistence());
    await submitTapRace(registry);
    await expect(
      registry.update('tap-race', 'wrong', manifestInput({ title: 'Nope' }))
    ).rejects.toMatchObject({ status: 401 });
  });

  it('resets the probe to unverified when entryUrl changes, else keeps it', async () => {
    const registry = new GamesRegistry(makePersistence());
    const { managementToken } = await submitTapRace(registry);
    await registry.probeResult('tap-race', true, 'tv-a'); // status -> ok
    // Same entryUrl → probe kept.
    const kept = await registry.update('tap-race', managementToken, manifestInput({ title: 'Same URL' }));
    expect(kept.probe.status).toBe('ok');
    // Changed entryUrl → probe reset to unverified.
    const reset = await registry.update(
      'tap-race',
      managementToken,
      manifestInput({ entryUrl: 'https://games.example.com/tap-race-v2/' })
    );
    expect(reset.probe.status).toBe('unverified');
    expect(reset.probe.failCount).toBe(0);
  });

  it('rejects changing the id on update (422)', async () => {
    const registry = new GamesRegistry(makePersistence());
    const { managementToken } = await submitTapRace(registry);
    await expect(
      registry.update('tap-race', managementToken, manifestInput({ id: 'different-id' }))
    ).rejects.toMatchObject({ status: 422 });
  });

  it('removes with the right token and rejects the wrong one', async () => {
    const registry = new GamesRegistry(makePersistence());
    const { managementToken } = await submitTapRace(registry);
    await expect(registry.remove('tap-race', 'wrong')).rejects.toMatchObject({ status: 401 });
    await registry.remove('tap-race', managementToken);
    expect(registry.resolveById('tap-race')).toBeNull();
  });
});

describe('admin ops', () => {
  it('setHidden and setFeatured mutate and persist', async () => {
    const persistence = makePersistence();
    const registry = new GamesRegistry(persistence);
    await submitTapRace(registry);

    await registry.setHidden('tap-race', true);
    expect(await persistence.loadGame('tap-race')).toMatchObject({ hidden: true });

    await registry.setFeatured('tap-race', true);
    expect(await persistence.loadGame('tap-race')).toMatchObject({ featured: true });

    await registry.setHidden('tap-race', false);
    expect(registry.listPublic()).toHaveLength(1);
  });

  it('listAll includes hidden and failed games', async () => {
    const registry = new GamesRegistry(makePersistence());
    await submitTapRace(registry);
    await registry.submit(manifestInput({ id: 'second' }), { probeFn: okProbe });
    await registry.setHidden('tap-race', true);
    expect(registry.listAll()).toHaveLength(2);
    expect(registry.listPublic()).toHaveLength(1);
  });

  it('throws 404 for admin ops on an unknown game', async () => {
    const registry = new GamesRegistry(makePersistence());
    await expect(registry.setHidden('nope', true)).rejects.toMatchObject({ status: 404 });
    await expect(registry.setFeatured('nope', true)).rejects.toMatchObject({ status: 404 });
  });

  it('shows the counts but not the client ids behind reports and probe failures', async () => {
    const registry = new GamesRegistry(makePersistence());
    await submitTapRace(registry);
    await registry.report('tap-race', 'reporter-id-a');
    const record = await registry.probeResult('tap-race', false, 'failing-tv-id-b');
    const view = adminGameView(record);
    expect(view).toMatchObject({ reports: 1, probe: { status: 'unverified', failCount: 1 } });
    expect(view.probe).not.toHaveProperty('failedBy');
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('reporter-id-a');
    expect(serialized).not.toContain('failing-tv-id-b');
  });
});

describe('writes that keep losing to concurrent writes', () => {
  it('fail with a 503, so the caller knows to try again', async () => {
    const persistence = makePersistence();
    const registry = new GamesRegistry(persistence);
    const { managementToken } = await submitTapRace(registry);
    persistence.updateGame = async (id) => {
      throw new GameWriteConflictError(id);
    };
    persistence.deleteGame = async (id) => {
      throw new GameWriteConflictError(id);
    };
    const retryLater = { status: 503, message: 'too many concurrent changes to this game, try again' };
    await expect(registry.setHidden('tap-race', true)).rejects.toMatchObject(retryLater);
    await expect(registry.setFeatured('tap-race', true)).rejects.toMatchObject(retryLater);
    await expect(registry.report('tap-race', 'client-a')).rejects.toMatchObject(retryLater);
    await expect(registry.probeResult('tap-race', false, 'tv-a')).rejects.toMatchObject(retryLater);
    await expect(registry.update('tap-race', managementToken, manifestInput())).rejects.toMatchObject(retryLater);
    await expect(registry.remove('tap-race', managementToken)).rejects.toBeInstanceOf(RegistryError);
    // Nothing was dropped from the cache on the way.
    expect(registry.resolveById('tap-race')).not.toBeNull();
  });

  it('pass any other store failure through as it is', async () => {
    const persistence = makePersistence();
    const registry = new GamesRegistry(persistence);
    await submitTapRace(registry);
    persistence.updateGame = async () => {
      throw new Error('connection lost');
    };
    await expect(registry.setHidden('tap-race', true)).rejects.toThrow('connection lost');
    await expect(registry.setHidden('tap-race', true)).rejects.not.toBeInstanceOf(RegistryError);
  });
});

describe('ensureFresh single-flight', () => {
  it('collapses concurrent stale calls into a single listGames', async () => {
    const persistence = makePersistence();
    // Seed a record directly through persistence so the registry cache is empty
    // and stale, forcing a re-list.
    const registry = new GamesRegistry(makePersistence()); // temp to build a record
    const { record } = await submitTapRace(registry);
    await persistence.createGame(record);
    persistence.listCalls = 0;

    const target = new GamesRegistry(persistence);
    // Cache is fresh-at-0; force staleness by passing a large "now".
    const now = 10_000_000;
    await Promise.all([
      target.ensureFresh(30_000, now),
      target.ensureFresh(30_000, now),
      target.ensureFresh(30_000, now)
    ]);
    // Three concurrent stale calls → exactly one underlying list.
    expect(persistence.listCalls).toBe(1);
    expect(target.resolveById('tap-race')?.id).toBe('tap-race');
  });

  it('does not re-list while the cache is fresh', async () => {
    const persistence = makePersistence();
    const registry = new GamesRegistry(persistence);
    // First ensureFresh at now=1000 lists once (lastListedAt starts at 0).
    await registry.ensureFresh(30_000, 1000);
    const afterFirst = persistence.listCalls;
    // A second call well within the window does not re-list.
    await registry.ensureFresh(30_000, 1000 + 5_000);
    expect(persistence.listCalls).toBe(afterFirst);
  });

  it('is a no-op when persistence is disabled', async () => {
    const registry = new GamesRegistry(disabledPersistence);
    await registry.ensureFresh(0, 10_000_000);
    expect(registry.listPublic()).toHaveLength(0);
  });
});

// Two registries on one store stand in for two serverless instances. Each one
// lists the store into its cache (ensureFresh) and keeps that for 30 s.
describe('instances with a stale cache', () => {
  async function twoInstances() {
    const persistence = makePersistence();
    const a = new GamesRegistry(persistence);
    const b = new GamesRegistry(persistence);
    const { managementToken } = await submitTapRace(a);
    await b.ensureFresh(30_000, 10_000_000);
    return { persistence, a, b, managementToken };
  }

  it('does not undo a takedown with a report, probe result or feature toggle', async () => {
    const { persistence, a, b } = await twoInstances();
    await a.setHidden('tap-race', true);
    // b still caches the visible record.
    expect(b.listPublic()).toHaveLength(1);
    await b.report('tap-race', 'client-a');
    await b.probeResult('tap-race', true, 'tv-a');
    await b.setFeatured('tap-race', true);
    expect(await persistence.loadGame('tap-race')).toMatchObject({ hidden: true, featured: true, reports: 1 });
    // ...and b's cache caught up with the stored record on its own write.
    expect(b.listPublic()).toHaveLength(0);
  });

  it('does not bring back a deleted game', async () => {
    const { persistence, a, b, managementToken } = await twoInstances();
    await a.remove('tap-race', managementToken);
    await expect(b.report('tap-race', 'client-a')).rejects.toMatchObject({ status: 404 });
    await expect(b.probeResult('tap-race', false, 'tv-a')).rejects.toMatchObject({ status: 404 });
    await expect(b.setHidden('tap-race', false)).rejects.toMatchObject({ status: 404 });
    await expect(b.setFeatured('tap-race', true)).rejects.toMatchObject({ status: 404 });
    await expect(b.update('tap-race', managementToken, manifestInput())).rejects.toMatchObject({ status: 404 });
    expect(await persistence.loadGame('tap-race')).toBeNull();
    expect(b.resolveById('tap-race')).toBeNull();
    const fresh = new GamesRegistry(persistence);
    await fresh.ensureFresh(30_000, 10_000_000);
    expect(fresh.listAll()).toHaveLength(0);
  });

  it('refuses a submit of an id another instance took meanwhile', async () => {
    const persistence = makePersistence();
    const a = new GamesRegistry(persistence);
    const b = new GamesRegistry(persistence);
    await b.ensureFresh(30_000, 10_000_000); // b lists before the game exists
    const { managementToken } = await submitTapRace(a);
    await expect(submitTapRace(b, { title: 'Hijacked' })).rejects.toMatchObject({ status: 409 });
    const fresh = new GamesRegistry(persistence);
    await fresh.ensureFresh(30_000, 10_000_000);
    expect(fresh.resolveById('tap-race')?.title).toBe('Tap Race');
    expect(fresh.verifyManagementToken('tap-race', managementToken)).toBe(true);
  });

  it('lets only one of two concurrent submits of one id through', async () => {
    const registry = new GamesRegistry(makePersistence());
    // A slow probe: both submits pass the cache check before either writes.
    const slowProbe: ProbeFn = () => new Promise((resolve) => setTimeout(() => resolve(true), 20));
    const results = await Promise.allSettled([
      registry.submit(manifestInput(), { probeFn: slowProbe }),
      registry.submit(manifestInput({ title: 'Second' }), { probeFn: slowProbe })
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409 });
  });

  it('checks the management token against the stored record, not the cached one', async () => {
    const { a, b, managementToken: oldToken } = await twoInstances();
    // The game is deleted and someone else publishes the same id.
    await a.remove('tap-race', oldToken);
    const { managementToken: newToken } = await submitTapRace(a, { title: 'New Owner' });
    // b's cache still holds the old record with the old token's hash.
    await expect(b.update('tap-race', oldToken, manifestInput({ title: 'Mine' }))).rejects.toMatchObject({ status: 401 });
    await expect(b.remove('tap-race', oldToken)).rejects.toMatchObject({ status: 401 });
    const updated = await b.update('tap-race', newToken, manifestInput({ title: 'New Owner 2' }));
    expect(updated.manifest.title).toBe('New Owner 2');
  });
});

describe('request budget', () => {
  it('is shared by every instance on the store', async () => {
    const persistence = makePersistence();
    const a = new GamesRegistry(persistence);
    const b = new GamesRegistry(persistence);
    const allowed: boolean[] = [];
    for (let i = 0; i < 6; i++) allowed.push(await (i % 2 ? a : b).allowRequest('report', 'client-a'));
    expect(allowed).toEqual([true, true, true, true, true, false]);
    // Separate per client and per kind.
    expect(await a.allowRequest('report', 'client-b')).toBe(true);
    expect(await a.allowRequest('probe', 'client-a')).toBe(true);
  });
});

describe('thumbnails', () => {
  it('serves a record stored before the thumbnail rules with the fallback look', async () => {
    const persistence = makePersistence();
    const registry = new GamesRegistry(persistence);
    const { record } = await submitTapRace(registry);
    // As if published before icons and gradients were checked.
    const legacy: PublishedGameRecord = structuredClone(record);
    legacy.manifest.id = 'old-thumb';
    legacy.manifest.thumbnail = {
      kind: 'css',
      gradient: 'url(https://tracker.example/p.gif?x=1) center/cover',
      icon: 'createLucideIcon'
    };
    await persistence.createGame(legacy);
    const fresh = new GamesRegistry(persistence);
    await fresh.ensureFresh(30_000, 10_000_000);

    const served = fresh.listPublic().find((game) => game.id === 'old-thumb');
    expect(served?.thumbnail).toEqual({ kind: 'css', gradient: FALLBACK_THUMBNAIL_GRADIENT, icon: FALLBACK_THUMBNAIL_ICON });
    expect(fresh.resolveById('old-thumb')?.thumbnail.icon).toBe(FALLBACK_THUMBNAIL_ICON);
    expect(publicGame(legacy).thumbnail.gradient).toBe(FALLBACK_THUMBNAIL_GRADIENT);
    // The admin view shows what is really stored.
    expect(adminGameView(legacy).manifest.thumbnail.icon).toBe('createLucideIcon');
  });

  it('rejects a thumbnail the catalog cannot render on update', async () => {
    const registry = new GamesRegistry(makePersistence());
    const { managementToken } = await submitTapRace(registry);
    await expect(
      registry.update(
        'tap-race',
        managementToken,
        manifestInput({ thumbnail: { kind: 'css', gradient: 'linear-gradient(#000,#111)', icon: 'Icon' } })
      )
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      registry.submit(
        manifestInput({
          id: 'tracker',
          thumbnail: { kind: 'css', gradient: 'url(https://tracker.example/p.gif)', icon: 'zap' }
        }),
        { probeFn: okProbe }
      )
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('defaultProbe injection point', () => {
  it('submit uses the injected probeFn, not the network', async () => {
    const registry = new GamesRegistry(makePersistence());
    const spy = vi.fn(async () => true);
    await registry.submit(manifestInput(), { probeFn: spy });
    expect(spy).toHaveBeenCalledWith('https://games.example.com/tap-race/');
  });
});
