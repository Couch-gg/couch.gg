import { describe, expect, it } from 'vitest';
import { randomSlug } from '@couch/game-runtime';

describe('randomSlug', () => {
  it('returns 6 chars from the readable alphabet', () => {
    for (let i = 0; i < 50; i++) {
      expect(randomSlug()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });

  it('honours a custom length', () => {
    expect(randomSlug(10)).toHaveLength(10);
  });

  it('produces effectively-unique codes in bulk (no degenerate repetition)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(randomSlug());
    // Crypto-backed randomness yields ~5000 distinct codes from a ~730M keyspace;
    // a broken/seed-shared generator would collapse this hard.
    expect(seen.size).toBeGreaterThan(4990);
  });
});
