import { describe, expect, it } from 'vitest';
import { ScreenRegistry, SCREEN_TTL_MS, SCREEN_CLAIM_GRACE_MS } from '../src/screens.js';
import { LobbyError } from '../src/lobbies.js';

describe('ScreenRegistry', () => {
  it('registers a screen and reads it back via get', () => {
    const registry = new ScreenRegistry();
    const record = registry.register(1000);

    expect(record.id).toMatch(/^scr_/);
    expect(record.claimedSlug).toBeNull();
    expect(record.claimedAt).toBeNull();
    expect(record.expiresAt).toBe(1000 + SCREEN_TTL_MS);
    expect(registry.get(record.id, 1000)).toBe(record);
  });

  it('reuses a live id but mints a fresh one when absent', () => {
    const registry = new ScreenRegistry();
    const first = registry.register(0);
    const reused = registry.registerOrReuse(first.id, 1000);
    expect(reused.id).toBe(first.id);

    const minted = registry.registerOrReuse('scr_does_not_exist', 1000);
    expect(minted.id).not.toBe(first.id);
    expect(registry.screens.size).toBe(2);
  });

  it('claims a screen and is idempotent for the same slug', () => {
    const registry = new ScreenRegistry();
    const record = registry.register(0);
    const claimed = registry.claim(record.id, 'ABCDEF', 500);
    expect(claimed.claimedSlug).toBe('ABCDEF');
    expect(claimed.claimedAt).toBe(500);

    const reclaimed = registry.claim(record.id, 'ABCDEF', 800);
    expect(reclaimed.claimedSlug).toBe('ABCDEF');
    expect(reclaimed.claimedAt).toBe(800);
  });

  it('rejects a claim by a different slug (409)', () => {
    const registry = new ScreenRegistry();
    const record = registry.register(0);
    registry.claim(record.id, 'ABCDEF', 0);
    try {
      registry.claim(record.id, 'ZZZZZZ', 0);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LobbyError);
      expect((err as LobbyError).status).toBe(409);
    }
  });

  it('rejects a claim for an unknown id (410)', () => {
    const registry = new ScreenRegistry();
    try {
      registry.claim('scr_nope', 'ABCDEF', 0);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LobbyError);
      expect((err as LobbyError).status).toBe(410);
    }
  });

  it('treats an unclaimed screen past its TTL as expired (410 on claim)', () => {
    const registry = new ScreenRegistry();
    const record = registry.register(0);
    // Just after TTL with no claim -> get() returns null and prunes it.
    expect(registry.get(record.id, SCREEN_TTL_MS + 1)).toBeNull();
    try {
      registry.claim(record.id, 'ABCDEF', SCREEN_TTL_MS + 1);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as LobbyError).status).toBe(410);
    }
  });

  it('keeps a claimed screen alive through the grace window then expires it', () => {
    const registry = new ScreenRegistry();
    const record = registry.register(0);
    registry.claim(record.id, 'ABCDEF', SCREEN_TTL_MS - 1);
    const claimedAt = SCREEN_TTL_MS - 1;
    // Still readable within the grace window, even though TTL already passed.
    expect(registry.get(record.id, claimedAt + SCREEN_CLAIM_GRACE_MS - 1)).toBe(record);
    // Gone once the grace deadline is reached.
    expect(registry.get(record.id, claimedAt + SCREEN_CLAIM_GRACE_MS)).toBeNull();
  });

  it('pruneExpired removes an expired unclaimed record and reports the count', () => {
    const registry = new ScreenRegistry();
    registry.register(0); // will expire
    const live = registry.register(SCREEN_TTL_MS); // still live at prune time
    const removed = registry.pruneExpired(SCREEN_TTL_MS + 1);
    expect(removed).toBe(1);
    expect(registry.screens.size).toBe(1);
    expect(registry.screens.has(live.id)).toBe(true);
  });

  it('toPublic exposes an ISO expiry and the claimed slug', () => {
    const registry = new ScreenRegistry();
    const record = registry.register(0);
    registry.claim(record.id, 'ABCDEF', 0);
    const pub = registry.toPublic(record);
    expect(pub.id).toBe(record.id);
    expect(pub.claimedSlug).toBe('ABCDEF');
    expect(pub.expiresAt).toBe(new Date(record.expiresAt).toISOString());
  });
});
