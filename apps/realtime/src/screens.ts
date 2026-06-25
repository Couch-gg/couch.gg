import type { LobbySlug, ScreenId, ScreenRecordPublic } from '@couch/types';
import { createId } from '@couch/game-runtime';
import { LobbyError } from './lobbies.js';

export const SCREEN_TTL_MS = 10 * 60 * 1000; // unclaimed lifetime
export const SCREEN_CLAIM_GRACE_MS = 60 * 1000; // keep a claimed screen this long so a dropped client can still read the result

export interface ScreenRecord {
  id: ScreenId;
  createdAt: number;
  expiresAt: number; // createdAt + SCREEN_TTL_MS
  claimedSlug: LobbySlug | null;
  claimedAt: number | null;
}

// In-memory only: a multi-instance deployment would need a shared store (e.g. Redis).
export class ScreenRegistry {
  readonly screens = new Map<ScreenId, ScreenRecord>();

  register(now = Date.now()): ScreenRecord {
    let id = createId('scr');
    while (this.screens.has(id)) id = createId('scr');
    const record: ScreenRecord = {
      id,
      createdAt: now,
      expiresAt: now + SCREEN_TTL_MS,
      claimedSlug: null,
      claimedAt: null
    };
    this.screens.set(id, record);
    return record;
  }

  registerOrReuse(id: string | undefined, now = Date.now()): ScreenRecord {
    if (id) {
      const existing = this.get(id, now);
      if (existing) return existing;
    }
    return this.register(now);
  }

  get(id: string, now = Date.now()): ScreenRecord | null {
    const record = this.screens.get(id);
    if (!record) return null;
    const deadline = record.claimedAt != null ? record.claimedAt + SCREEN_CLAIM_GRACE_MS : record.expiresAt;
    if (deadline <= now) {
      this.screens.delete(id);
      return null;
    }
    return record;
  }

  claim(id: string, slug: LobbySlug, now = Date.now()): ScreenRecord {
    const record = this.get(id, now);
    if (!record) throw new LobbyError('Screen abgelaufen', 410);
    if (record.claimedSlug && record.claimedSlug !== slug) throw new LobbyError('Screen schon vergeben', 409);
    record.claimedSlug = slug;
    record.claimedAt = now;
    return record;
  }

  pruneExpired(now = Date.now()): number {
    let removed = 0;
    for (const [id, record] of this.screens) {
      const deadline = record.claimedAt != null ? record.claimedAt + SCREEN_CLAIM_GRACE_MS : record.expiresAt;
      if (deadline <= now) {
        this.screens.delete(id);
        removed++;
      }
    }
    return removed;
  }

  toPublic(record: ScreenRecord): ScreenRecordPublic {
    return {
      id: record.id,
      expiresAt: new Date(record.expiresAt).toISOString(),
      claimedSlug: record.claimedSlug
    };
  }
}
