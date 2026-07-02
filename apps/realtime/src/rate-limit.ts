// Per-instance token-bucket rate limiter for relayed external game inputs.
//
// Two buckets are checked on every input:
//   - per-player: capacity 20, refill 10 tokens/s (keyed `${slug}:${playerId}`)
//   - per-slug aggregate: capacity 60, refill 30 tokens/s (keyed `${slug}`)
// Both must have a token available for the input to be allowed; the token is
// only consumed from each when both pass, so a rejected input never drains the
// other bucket. This bounds a single controller's burst while also capping the
// whole lobby's fan-in.
//
// Caveat (documented, accepted at this scale): the limiter is per serverless
// instance, so on a multi-instance deploy the effective ceiling multiplies by
// the instance count. Fine for input-relay abuse defense; not a hard quota.
//
// The clock is injectable so tests can advance time deterministically.

interface Bucket {
  tokens: number;
  lastRefill: number;
  lastTouched: number;
}

const PLAYER_CAPACITY = 20;
const PLAYER_REFILL_PER_SEC = 10;
const SLUG_CAPACITY = 60;
const SLUG_REFILL_PER_SEC = 30;
const IDLE_PRUNE_MS = 60_000;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastPrune = 0;

  private refill(bucket: Bucket, capacity: number, refillPerSec: number, now: number): void {
    const elapsedMs = now - bucket.lastRefill;
    if (elapsedMs > 0) {
      bucket.tokens = Math.min(capacity, bucket.tokens + (elapsedMs / 1000) * refillPerSec);
      bucket.lastRefill = now;
    }
    bucket.lastTouched = now;
  }

  private getBucket(key: string, capacity: number, now: number): Bucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now, lastTouched: now };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  // Drop buckets that have been idle for longer than IDLE_PRUNE_MS. Called
  // opportunistically (at most once per IDLE_PRUNE_MS) so it never dominates the
  // hot path.
  private pruneIdle(now: number): void {
    if (now - this.lastPrune < IDLE_PRUNE_MS) return;
    this.lastPrune = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastTouched > IDLE_PRUNE_MS) this.buckets.delete(key);
    }
  }

  // Returns true (and consumes a token from each bucket) when the input is within
  // both the per-player and per-slug limits, false otherwise. A rejected input
  // consumes nothing.
  allow(slug: string, playerId: string, now = Date.now()): boolean {
    this.pruneIdle(now);

    const playerBucket = this.getBucket(`${slug}:${playerId}`, PLAYER_CAPACITY, now);
    const slugBucket = this.getBucket(slug, SLUG_CAPACITY, now);

    this.refill(playerBucket, PLAYER_CAPACITY, PLAYER_REFILL_PER_SEC, now);
    this.refill(slugBucket, SLUG_CAPACITY, SLUG_REFILL_PER_SEC, now);

    if (playerBucket.tokens < 1 || slugBucket.tokens < 1) return false;

    playerBucket.tokens -= 1;
    slugBucket.tokens -= 1;
    return true;
  }
}
