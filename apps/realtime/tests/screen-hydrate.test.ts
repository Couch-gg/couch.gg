import { describe, expect, it } from 'vitest';
import { ScreenRegistry, SCREEN_TTL_MS, SCREEN_CLAIM_GRACE_MS, type ScreenRecord } from '../src/screens.js';

describe('ScreenRegistry.hydrate (cross-instance pairing)', () => {
  it('lets a second registry claim/read a screen it only learned via hydration', () => {
    // Instance A registers the screen (as the desktop's POST /screens would).
    const instanceA = new ScreenRegistry();
    const record = instanceA.register(1000);

    // The record travels through shared persistence to a different serverless
    // instance. Instance B has never seen this id in its in-memory Map.
    const instanceB = new ScreenRegistry();
    expect(instanceB.get(record.id, 1000)).toBeNull();

    // Hydrate it in (as hydrateScreen would after persistence.loadScreen).
    const hydrated = instanceB.hydrate({ ...record }, 1000);
    expect(hydrated).not.toBeNull();
    expect(instanceB.get(record.id, 1000)?.id).toBe(record.id);

    // Instance B can now claim it (the phone's claim hitting a different instance).
    const claimed = instanceB.claim(record.id, 'ABCDEF', 2000);
    expect(claimed.claimedSlug).toBe('ABCDEF');
    expect(instanceB.get(record.id, 2000)?.claimedSlug).toBe('ABCDEF');
  });

  it('drops an already-expired record on hydrate instead of resurrecting it', () => {
    const registry = new ScreenRegistry();
    const expired: ScreenRecord = {
      id: 'scr_dead',
      createdAt: 0,
      expiresAt: SCREEN_TTL_MS, // unclaimed deadline = expiresAt
      claimedSlug: null,
      claimedAt: null
    };

    // now is past the TTL deadline -> hydrate must refuse it.
    expect(registry.hydrate({ ...expired }, SCREEN_TTL_MS + 1)).toBeNull();
    expect(registry.screens.has('scr_dead')).toBe(false);
    expect(registry.get('scr_dead', SCREEN_TTL_MS + 1)).toBeNull();
  });

  it('honors the claim grace deadline when hydrating a claimed record', () => {
    const registry = new ScreenRegistry();
    const claimedAt = SCREEN_TTL_MS - 1; // claimed near the end of the TTL window
    const claimed: ScreenRecord = {
      id: 'scr_claimed',
      createdAt: 0,
      expiresAt: SCREEN_TTL_MS,
      claimedSlug: 'ABCDEF',
      claimedAt
    };
    const graceDeadline = claimedAt + SCREEN_CLAIM_GRACE_MS;

    // Within grace: hydrate keeps it even though expiresAt already passed.
    expect(registry.hydrate({ ...claimed }, graceDeadline - 1)).not.toBeNull();
    expect(registry.get('scr_claimed', graceDeadline - 1)?.claimedSlug).toBe('ABCDEF');

    // At/after the grace deadline: hydrate drops it.
    const fresh = new ScreenRegistry();
    expect(fresh.hydrate({ ...claimed }, graceDeadline)).toBeNull();
    expect(fresh.screens.has('scr_claimed')).toBe(false);
  });
});
