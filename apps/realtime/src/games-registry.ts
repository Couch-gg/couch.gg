// The dynamic published-games registry: durable submit → auto-publish with
// automated checks, per-game management-token self-service (PATCH/DELETE),
// community report + first-load probe auto-hide, and admin takedown/feature.
//
// The registry caches every record in memory so the socket-side manifest
// resolver (resolveById) can stay synchronous — the lobby store resolves a game
// on join/select/start with no await. REST handlers call ensureFresh() first so
// the public catalog reflects other-instance writes within the cache window.
//
// Security invariants (grep-enforced by the task):
//   - the plaintext management token is returned exactly once, from submit(),
//     and NEVER stored — only its sha256 hex lives on the record.
//   - token verification is constant-time (timingSafeEqual over hex buffers).
//   - no public payload ever includes managementTokenHash.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  RESERVED_GAME_IDS,
  validateExternalManifestInput,
  type ExternalManifestInput
} from '@couch/game-runtime';
import type { ExternalGameManifest } from '@couch/types';
import type { GamePersistence } from './persistence.js';

// A published external game plus the registry bookkeeping the manifest itself
// does not carry. `manifest` is always a full ExternalGameManifest with
// status:'published', origin:'external'. `featured` here is the source of truth;
// listPublic folds it back into the served manifest.
export interface PublishedGameRecord {
  manifest: ExternalGameManifest;
  managementTokenHash: string; // sha256 hex of the plaintext token
  createdAt: number;
  updatedAt: number;
  featured: boolean;
  hidden: boolean; // admin takedown OR report/probe auto-hide
  reports: number;
  probe: { status: 'ok' | 'unverified' | 'failed'; lastCheckedAt: number | null; failCount: number };
}

// A rejection the REST layer maps to an HTTP status. Mirrors LobbyError so
// index.ts can reuse its sendHttpError path.
export class RegistryError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly errors?: string[]
  ) {
    super(message);
  }
}

const REPORT_HIDE_THRESHOLD = 3;
const PROBE_FAIL_THRESHOLD = 3;
const PROBE_TIMEOUT_MS = 5000;
const TOKEN_BYTES = 16; // 128-bit management token

export interface SubmitOptions {
  // Ids already claimed by built-in or env-registered games. A submit that
  // collides with any of these is rejected 409 (RESERVED ids are additionally
  // caught by the validator).
  reservedIds?: Iterable<string>;
  // From attestation.handshakeOk: informational only. true → initial probe
  // status 'ok', otherwise 'unverified'. The real gate is the server probe.
  handshakeOk?: boolean;
  // Injectable server probe (default = real fetch) so tests never hit the
  // network. Resolves true when the entryUrl looks like a live HTML page.
  probeFn?: ProbeFn;
  now?: () => number;
}

export type ProbeFn = (entryUrl: string) => Promise<boolean>;

// Default server probe: GET the entryUrl with a 5s timeout, following redirects,
// expecting a 2xx response whose content-type contains 'text/html'.
//
// Accepted residual (documented): a redirect is followed but the final URL is
// NOT re-validated against private/loopback ranges, so a public entryUrl that
// 3xx-redirects to an internal host would still be probed. This is a known SSRF
// gap; the sandbox iframe — not the probe — is the real isolation boundary.
export async function defaultProbe(entryUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(entryUrl, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return false;
    const contentType = res.headers.get('content-type') ?? '';
    return contentType.toLowerCase().includes('text/html');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface SubmitResult {
  record: PublishedGameRecord;
  managementToken: string; // shown to the creator exactly once
}

export class GamesRegistry {
  // id → record. Authoritative between ensureFresh() re-lists; every mutation
  // updates this immediately so resolveById/listPublic never lag a write.
  private readonly cache = new Map<string, PublishedGameRecord>();
  private lastListedAt = 0;
  private inflightList: Promise<void> | null = null;

  constructor(private readonly persistence: GamePersistence) {}

  get enabled(): boolean {
    return this.persistence.enabled;
  }

  // Re-list from persistence when the cache is older than maxAgeMs. Single-flight:
  // concurrent callers share the one in-progress list so a burst of REST handlers
  // does not stampede the store.
  async ensureFresh(maxAgeMs = 30_000, now = Date.now()): Promise<void> {
    if (!this.persistence.enabled) return;
    if (now - this.lastListedAt < maxAgeMs) return;
    if (this.inflightList) return this.inflightList;
    this.inflightList = (async () => {
      try {
        const records = await this.persistence.listGames();
        this.cache.clear();
        for (const record of records) this.cache.set(record.manifest.id, record);
        this.lastListedAt = Date.now();
      } finally {
        this.inflightList = null;
      }
    })();
    return this.inflightList;
  }

  // Public catalog slice: visible = not hidden and not probe-failed. The served
  // manifest folds the record's featured flag in (the manifest's own featured is
  // never trusted — admins toggle the record).
  listPublic(): ExternalGameManifest[] {
    const out: ExternalGameManifest[] = [];
    for (const record of this.cache.values()) {
      if (record.hidden || record.probe.status === 'failed') continue;
      out.push({ ...record.manifest, featured: record.featured });
    }
    return out;
  }

  // Synchronous cache read for the lobby-store manifest resolver. Returns the
  // manifest even when hidden/failed so an in-progress game keeps resolving; the
  // catalog filter (listPublic) is what hides it from discovery.
  resolveById(id: string): ExternalGameManifest | null {
    const record = this.cache.get(id);
    if (!record) return null;
    return { ...record.manifest, featured: record.featured };
  }

  // Full admin listing — every record including hidden/failed, tokenHash stripped
  // by the REST serializer (never here; the record type carries it).
  listAll(): PublishedGameRecord[] {
    return [...this.cache.values()];
  }

  // Validate → reject id collisions (409) → server probe (422 on failure) →
  // compose the published manifest, mint a token, store its hash. Returns the
  // record plus the one-time plaintext token.
  async submit(input: unknown, opts: SubmitOptions = {}): Promise<SubmitResult> {
    if (!this.persistence.enabled) {
      throw new RegistryError('publishing unavailable', 503);
    }
    const now = opts.now ?? (() => Date.now());
    const probeFn = opts.probeFn ?? defaultProbe;

    const result = validateExternalManifestInput(input, {
      allowHttpLocalhost: !process.env.VERCEL
    });
    if (!result.ok) {
      throw new RegistryError('manifest is invalid', 422, result.errors);
    }
    const value = result.value;

    // Id must not collide with a built-in / env-registered game or an existing
    // registry record. (RESERVED ids are already rejected by the validator; this
    // is the belt-and-suspenders check for the dynamic side.)
    const reserved = new Set<string>([...RESERVED_GAME_IDS, ...(opts.reservedIds ?? [])]);
    if (reserved.has(value.id) || this.cache.has(value.id)) {
      throw new RegistryError(`id "${value.id}" is already taken`, 409);
    }

    const reachable = await probeFn(value.entryUrl);
    if (!reachable) {
      throw new RegistryError('entryUrl is not reachable or is not an HTML page', 422);
    }

    const at = now();
    const manifest = composeManifest(value, new Date(at).toISOString());
    const managementToken = randomBytes(TOKEN_BYTES).toString('base64url');

    const record: PublishedGameRecord = {
      manifest,
      managementTokenHash: sha256Hex(managementToken),
      createdAt: at,
      updatedAt: at,
      featured: false,
      hidden: false,
      reports: 0,
      probe: {
        status: opts.handshakeOk ? 'ok' : 'unverified',
        lastCheckedAt: opts.handshakeOk ? at : null,
        failCount: 0
      }
    };

    await this.persist(record);
    return { record, managementToken };
  }

  // Constant-time management-token check. False for an unknown id or a token
  // whose hash does not match. Never leaks which of the two failed via timing.
  verifyManagementToken(id: string, token: string): boolean {
    const record = this.cache.get(id);
    if (!record) return false;
    const provided = Buffer.from(sha256Hex(token), 'hex');
    const stored = Buffer.from(record.managementTokenHash, 'hex');
    if (provided.length !== stored.length) return false;
    return timingSafeEqual(provided, stored);
  }

  // Self-service update by management token. Re-validates the new manifest and
  // preserves the id (the body must keep the same id). An entryUrl change resets
  // the probe to 'unverified' (re-probed on next real load); otherwise the probe
  // state is kept.
  async update(id: string, token: string, input: unknown, now = Date.now()): Promise<PublishedGameRecord> {
    const record = this.requireRecord(id);
    if (!this.verifyManagementToken(id, token)) {
      throw new RegistryError('invalid management token', 401);
    }
    const result = validateExternalManifestInput(input, {
      allowHttpLocalhost: !process.env.VERCEL
    });
    if (!result.ok) {
      throw new RegistryError('manifest is invalid', 422, result.errors);
    }
    if (result.value.id !== id) {
      throw new RegistryError('id cannot be changed on update', 422);
    }
    const entryUrlChanged = result.value.entryUrl !== record.manifest.entryUrl;
    const updated: PublishedGameRecord = {
      ...record,
      manifest: composeManifest(result.value, record.manifest.publishedAt),
      updatedAt: now,
      probe: entryUrlChanged
        ? { status: 'unverified', lastCheckedAt: null, failCount: 0 }
        : record.probe
    };
    await this.persist(updated);
    return updated;
  }

  async remove(id: string, token: string): Promise<void> {
    this.requireRecord(id);
    if (!this.verifyManagementToken(id, token)) {
      throw new RegistryError('invalid management token', 401);
    }
    await this.persistence.deleteGame(id);
    this.cache.delete(id);
  }

  // Community report. Increments the counter; at the threshold the game is
  // auto-hidden. Returns the (possibly now-hidden) record.
  async report(id: string, now = Date.now()): Promise<PublishedGameRecord> {
    const record = this.requireRecord(id);
    const reports = record.reports + 1;
    const updated: PublishedGameRecord = {
      ...record,
      reports,
      hidden: record.hidden || reports >= REPORT_HIDE_THRESHOLD,
      updatedAt: now
    };
    await this.persist(updated);
    return updated;
  }

  // First-load probe result from a real TV. ok resets the fail counter and marks
  // the probe 'ok'; a failure increments failCount and, at the threshold of
  // consecutive fails, marks the probe 'failed' (which hides it from the catalog
  // via listPublic — perpetual URL-rot defense).
  async probeResult(id: string, ok: boolean, now = Date.now()): Promise<PublishedGameRecord> {
    const record = this.requireRecord(id);
    const probe = ok
      ? { status: 'ok' as const, lastCheckedAt: now, failCount: 0 }
      : (() => {
          const failCount = record.probe.failCount + 1;
          const status = failCount >= PROBE_FAIL_THRESHOLD ? ('failed' as const) : record.probe.status;
          return { status, lastCheckedAt: now, failCount };
        })();
    const updated: PublishedGameRecord = { ...record, probe, updatedAt: now };
    await this.persist(updated);
    return updated;
  }

  // Admin takedown / restore.
  async setHidden(id: string, hidden: boolean, now = Date.now()): Promise<PublishedGameRecord> {
    const record = this.requireRecord(id);
    const updated: PublishedGameRecord = { ...record, hidden, updatedAt: now };
    await this.persist(updated);
    return updated;
  }

  // Admin feature toggle.
  async setFeatured(id: string, featured: boolean, now = Date.now()): Promise<PublishedGameRecord> {
    const record = this.requireRecord(id);
    const updated: PublishedGameRecord = { ...record, featured, updatedAt: now };
    await this.persist(updated);
    return updated;
  }

  private requireRecord(id: string): PublishedGameRecord {
    const record = this.cache.get(id);
    if (!record) throw new RegistryError('game not found', 404);
    return record;
  }

  // Write-through: persist then update the cache immediately so a subsequent
  // sync resolveById/listPublic sees the new state without waiting on ensureFresh.
  private async persist(record: PublishedGameRecord): Promise<void> {
    await this.persistence.saveGame(record);
    this.cache.set(record.manifest.id, record);
  }
}

// Serialize a record for a public payload: the served manifest with the record's
// featured flag folded in. NEVER includes managementTokenHash.
export function publicGame(record: PublishedGameRecord): ExternalGameManifest {
  return { ...record.manifest, featured: record.featured };
}

// Admin view of a record: everything the operator needs to triage, minus the
// token hash (an operator can take down / feature by id; they never need the hash).
export function adminGameView(record: PublishedGameRecord): {
  manifest: ExternalGameManifest;
  createdAt: number;
  updatedAt: number;
  featured: boolean;
  hidden: boolean;
  reports: number;
  probe: PublishedGameRecord['probe'];
} {
  return {
    manifest: record.manifest,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    featured: record.featured,
    hidden: record.hidden,
    reports: record.reports,
    probe: record.probe
  };
}

// Compose the full published manifest from validated creator input. The server
// owns origin/status; publishedAt is preserved across updates.
function composeManifest(value: ExternalManifestInput, publishedAt: string): ExternalGameManifest {
  return {
    ...value,
    origin: 'external',
    status: 'published',
    publishedAt
  };
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
