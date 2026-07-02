import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { GamePersistence } from '../src/persistence.js';
import {
  GamesRegistry,
  RegistryError,
  publicGame,
  type ProbeFn,
  type PublishedGameRecord
} from '../src/games-registry.js';

// A test-local in-memory GamePersistence. Structurally identical to the shipped
// InMemoryGamePersistence but constructed here so the suite is independent of
// process.env (the factory branches on REDIS_URL / VERCEL). Clones on the way in
// and out so the registry can never mutate stored records by reference — which
// is also what lets the ensureFresh single-flight assertion count real list calls.
function makePersistence(): GamePersistence & { listCalls: number } {
  const games = new Map<string, PublishedGameRecord>();
  const store = {
    enabled: true,
    listCalls: 0,
    async loadGame(id: string) {
      const r = games.get(id);
      return r ? structuredClone(r) : null;
    },
    async saveGame(record: PublishedGameRecord) {
      games.set(record.manifest.id, structuredClone(record));
    },
    async deleteGame(id: string) {
      games.delete(id);
    },
    async listGames() {
      store.listCalls++;
      return [...games.values()].map((r) => structuredClone(r));
    }
  };
  return store;
}

// A disabled persistence (models Vercel-without-Redis) to prove the 503 path.
const disabledPersistence: GamePersistence = {
  enabled: false,
  async loadGame() {
    return null;
  },
  async saveGame() {
    throw new Error('disabled');
  },
  async deleteGame() {},
  async listGames() {
    return [];
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
    await registry.probeResult('tap-race', false);
    await registry.probeResult('tap-race', false);
    await registry.probeResult('tap-race', false);
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
  it('auto-hides after 3 reports', async () => {
    const registry = new GamesRegistry(makePersistence());
    await submitTapRace(registry);
    const first = await registry.report('tap-race');
    expect(first.hidden).toBe(false);
    const second = await registry.report('tap-race');
    expect(second.hidden).toBe(false);
    const third = await registry.report('tap-race');
    expect(third.hidden).toBe(true);
    expect(registry.listPublic()).toHaveLength(0);
  });

  it('throws 404 reporting an unknown game', async () => {
    const registry = new GamesRegistry(makePersistence());
    await expect(registry.report('nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('probeResult', () => {
  it('marks failed after 3 consecutive fails', async () => {
    const registry = new GamesRegistry(makePersistence());
    await submitTapRace(registry);
    await registry.probeResult('tap-race', false);
    await registry.probeResult('tap-race', false);
    const third = await registry.probeResult('tap-race', false);
    expect(third.probe.status).toBe('failed');
    expect(third.probe.failCount).toBe(3);
  });

  it('one ok resets the fail count and status', async () => {
    const registry = new GamesRegistry(makePersistence());
    await submitTapRace(registry);
    await registry.probeResult('tap-race', false);
    await registry.probeResult('tap-race', false);
    const recovered = await registry.probeResult('tap-race', true);
    expect(recovered.probe.status).toBe('ok');
    expect(recovered.probe.failCount).toBe(0);
    // And it is visible again.
    expect(registry.listPublic()).toHaveLength(1);
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
    await registry.probeResult('tap-race', true); // status -> ok
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
});

describe('ensureFresh single-flight', () => {
  it('collapses concurrent stale calls into a single listGames', async () => {
    const persistence = makePersistence();
    // Seed a record directly through persistence so the registry cache is empty
    // and stale, forcing a re-list.
    const registry = new GamesRegistry(makePersistence()); // temp to build a record
    const { record } = await submitTapRace(registry);
    await persistence.saveGame(record);
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

describe('defaultProbe injection point', () => {
  it('submit uses the injected probeFn, not the network', async () => {
    const registry = new GamesRegistry(makePersistence());
    const spy = vi.fn(async () => true);
    await registry.submit(manifestInput(), { probeFn: spy });
    expect(spy).toHaveBeenCalledWith('https://games.example.com/tap-race/');
  });
});
