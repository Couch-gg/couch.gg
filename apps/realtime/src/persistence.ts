import { PollingQueueClient } from '@vercel/queue';
import { createClient, type RedisClientType } from 'redis';
import {
  deserializeLobbyRecord,
  serializeLobbyRecord,
  type LobbyRecord,
  type SerializedLobbyRecord
} from './lobbies.js';
import type { PublishedGameRecord } from './games-registry.js';
import { SCREEN_CLAIM_GRACE_MS, type ScreenRecord } from './screens.js';

// Durable store for the published-games registry. Unlike lobbies/screens these
// records have NO TTL — a published game lives until it is explicitly deleted or
// taken down. The registry class caches on top of this and re-lists when stale.
//
// Every write is conditional, so an instance working from a stale cache can't
// undo another instance's write: a new record only lands on a free id, an
// update only replaces the exact record it read (and never brings back a
// deleted one), and a delete only removes the record it checked.
export interface GamePersistence {
  enabled: boolean;
  loadGame(id: string): Promise<PublishedGameRecord | null>;
  // Store a new record. False (nothing written) when the id is taken.
  createGame(record: PublishedGameRecord): Promise<boolean>;
  // Read-modify-write of the stored record: `change` gets it and returns the
  // next one, or throws to write nothing. Starts over when another write got
  // in between, so `change` may run more than once. Null (nothing written)
  // when there is no record.
  updateGame(id: string, change: (current: PublishedGameRecord) => PublishedGameRecord): Promise<PublishedGameRecord | null>;
  // Delete the stored record once `check` accepts it (it throws to keep the
  // record). False when there is no record.
  deleteGame(id: string, check?: (current: PublishedGameRecord) => void): Promise<boolean>;
  listGames(): Promise<PublishedGameRecord[]>;
  // Take a one-time marker for ttlMs (e.g. one probe result per game session).
  // False when it is already taken.
  claimOnce(key: string, ttlMs: number): Promise<boolean>;
  // Count a hit against a limit every instance shares: the number of hits on
  // `key` in the window of windowMs that began with its first hit.
  countHit(key: string, windowMs: number): Promise<number>;
}

export interface LobbyPersistence {
  enabled: boolean;
  delete(slug: string): Promise<void>;
  load(slug: string): Promise<LobbyRecord | null>;
  save(lobby: LobbyRecord): Promise<void>;
  loadScreen(id: string): Promise<ScreenRecord | null>;
  saveScreen(record: ScreenRecord): Promise<void>;
  deleteScreen(id: string): Promise<void>;
}

// A claimed screen lives until claimedAt + grace; an unclaimed one until expiresAt.
function screenDeadline(record: ScreenRecord): number {
  return record.claimedAt != null ? record.claimedAt + SCREEN_CLAIM_GRACE_MS : record.expiresAt;
}

export function createLobbyPersistence(redisUrl = process.env.REDIS_URL): LobbyPersistence {
  if (!redisUrl) return disabledPersistence;
  return new RedisLobbyPersistence(redisUrl);
}

export function createProductionLobbyPersistence(redisUrl = process.env.REDIS_URL): LobbyPersistence {
  if (redisUrl) return new RedisLobbyPersistence(redisUrl);
  if (process.env.VERCEL) return new QueueLobbyPersistence();
  return disabledPersistence;
}

const disabledPersistence: LobbyPersistence = {
  enabled: false,
  async delete() {},
  async load() {
    return null;
  },
  async save() {},
  async loadScreen() {
    return null;
  },
  async saveScreen() {},
  async deleteScreen() {}
};

class RedisLobbyPersistence implements LobbyPersistence {
  enabled = true;
  private clientPromise: Promise<RedisClientType> | null = null;

  constructor(private readonly redisUrl: string) {}

  async load(slug: string): Promise<LobbyRecord | null> {
    const client = await this.client();
    const raw = await client.get(key(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SerializedLobbyRecord;
    if (parsed.expiresAt <= Date.now()) {
      await this.delete(slug);
      return null;
    }
    return deserializeLobbyRecord(parsed);
  }

  async save(lobby: LobbyRecord): Promise<void> {
    const client = await this.client();
    await client.set(key(lobby.slug), JSON.stringify(serializeLobbyRecord(lobby)), {
      PXAT: lobby.expiresAt
    });
  }

  async delete(slug: string): Promise<void> {
    const client = await this.client();
    await client.del(key(slug));
  }

  async loadScreen(id: string): Promise<ScreenRecord | null> {
    const client = await this.client();
    const raw = await client.get(screenKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ScreenRecord;
    if (screenDeadline(parsed) <= Date.now()) {
      await this.deleteScreen(id);
      return null;
    }
    return parsed;
  }

  async saveScreen(record: ScreenRecord): Promise<void> {
    const client = await this.client();
    await client.set(screenKey(record.id), JSON.stringify(record), {
      PXAT: screenDeadline(record)
    });
  }

  async deleteScreen(id: string): Promise<void> {
    const client = await this.client();
    await client.del(screenKey(id));
  }

  private async client(): Promise<RedisClientType> {
    if (!this.clientPromise) {
      const client = createClient({ url: this.redisUrl });
      client.on('error', (err: unknown) => {
        console.error('Redis lobby persistence error', err);
      });
      this.clientPromise = client.connect() as Promise<RedisClientType>;
    }
    return this.clientPromise;
  }
}

interface QueueSnapshotMessage {
  kind: 'snapshot';
  at: number;
  lobby: SerializedLobbyRecord;
}

interface QueueScreenMessage {
  kind: 'screen';
  at: number;
  record: ScreenRecord;
}

class QueueLobbyPersistence implements LobbyPersistence {
  enabled = true;
  private readonly queue = new PollingQueueClient({
    deploymentId: null,
    region: process.env.QUEUE_REGION ?? process.env.VERCEL_REGION ?? 'iad1'
  });

  async load(slug: string): Promise<LobbyRecord | null> {
    const normalized = slug.toUpperCase();
    let latest: QueueSnapshotMessage | null = null;
    const consumerGroup = `loader_${normalized}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    for (let batch = 0; batch < 50; batch++) {
      const result = await this.queue.receive<QueueSnapshotMessage>(
        topic(normalized),
        consumerGroup,
        (message) => {
          if (message.kind === 'snapshot') latest = message;
        },
        { limit: 10, visibilityTimeoutSeconds: 30 }
      );
      if (!result.ok) break;
    }

    const message = latest as QueueSnapshotMessage | null;
    if (!message) return null;
    if (message.lobby.expiresAt <= Date.now()) return null;
    return deserializeLobbyRecord(message.lobby);
  }

  async save(lobby: LobbyRecord): Promise<void> {
    await this.queue.send<QueueSnapshotMessage>(
      topic(lobby.slug),
      {
        kind: 'snapshot',
        at: Date.now(),
        lobby: serializeLobbyRecord(lobby)
      },
      {
        retentionSeconds: retentionSeconds(lobby),
        idempotencyKey: `${lobby.slug}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      }
    );
  }

  async delete(slug: string): Promise<void> {
    const expired = deserializeLobbyRecord({
      id: `expired_${slug.toUpperCase()}`,
      slug: slug.toUpperCase(),
      name: `Expired ${slug.toUpperCase()}`,
      hostPlayerId: null,
      createdAt: Date.now(),
      expiresAt: Date.now() - 1,
      currentGameId: 'trebuchet',
      state: 'ended',
      players: [],
      activity: [],
      gameSession: null
    });
    await this.save(expired);
  }

  async loadScreen(id: string): Promise<ScreenRecord | null> {
    let latest: QueueScreenMessage | null = null;
    const consumerGroup = `loader_${id}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    for (let batch = 0; batch < 50; batch++) {
      const result = await this.queue.receive<QueueScreenMessage>(
        screenTopic(id),
        consumerGroup,
        (message) => {
          if (message.kind === 'screen') latest = message;
        },
        { limit: 10, visibilityTimeoutSeconds: 30 }
      );
      if (!result.ok) break;
    }

    const message = latest as QueueScreenMessage | null;
    if (!message) return null;
    if (screenDeadline(message.record) <= Date.now()) return null;
    return message.record;
  }

  async saveScreen(record: ScreenRecord): Promise<void> {
    await this.queue.send<QueueScreenMessage>(
      screenTopic(record.id),
      {
        kind: 'screen',
        at: Date.now(),
        record
      },
      {
        retentionSeconds: screenRetentionSeconds(record),
        idempotencyKey: `${record.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      }
    );
  }

  async deleteScreen(id: string): Promise<void> {
    await this.saveScreen({
      id,
      createdAt: Date.now(),
      expiresAt: Date.now() - 1,
      claimedSlug: null,
      claimedAt: null
    });
  }
}

// --- Games registry persistence ---------------------------------------------
//
// Redis when REDIS_URL is set; otherwise an in-memory Map so local dev and e2e
// get the full submit flow without Redis. On Vercel without Redis the registry
// is disabled (submit returns 503, catalog stays builtin-only) — the Queue is
// deliberately NOT used here: it is a log, the wrong shape for a keyed index we
// must overwrite/delete in place.
export function createProductionGamePersistence(redisUrl = process.env.REDIS_URL): GamePersistence {
  if (redisUrl) return new RedisGamePersistence(redisUrl);
  if (process.env.VERCEL) return disabledGamePersistence;
  return new InMemoryGamePersistence();
}

const disabledGamePersistence: GamePersistence = {
  enabled: false,
  async loadGame() {
    return null;
  },
  async createGame() {
    throw new Error('Games persistence is disabled');
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

// Full submit flow without Redis (local dev + e2e). Clones on the way in and out
// so callers can never mutate the stored record by reference. Each method runs
// without an await between its read and its write, so it is atomic here.
export class InMemoryGamePersistence implements GamePersistence {
  enabled = true;
  private readonly games = new Map<string, PublishedGameRecord>();
  private readonly claims = new Map<string, number>(); // key → expiresAt
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  async loadGame(id: string): Promise<PublishedGameRecord | null> {
    const record = this.games.get(id);
    return record ? clone(record) : null;
  }

  async createGame(record: PublishedGameRecord): Promise<boolean> {
    if (this.games.has(record.manifest.id)) return false;
    this.games.set(record.manifest.id, clone(record));
    return true;
  }

  async updateGame(
    id: string,
    change: (current: PublishedGameRecord) => PublishedGameRecord
  ): Promise<PublishedGameRecord | null> {
    const current = this.games.get(id);
    if (!current) return null;
    const next = change(clone(current));
    this.games.set(id, clone(next));
    return clone(next);
  }

  async deleteGame(id: string, check?: (current: PublishedGameRecord) => void): Promise<boolean> {
    const current = this.games.get(id);
    if (!current) return false;
    check?.(clone(current));
    this.games.delete(id);
    return true;
  }

  async listGames(): Promise<PublishedGameRecord[]> {
    return [...this.games.values()].map(clone);
  }

  async claimOnce(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    pruneExpired(this.claims, (expiresAt) => expiresAt <= now);
    if ((this.claims.get(key) ?? 0) > now) return false;
    this.claims.set(key, now + ttlMs);
    return true;
  }

  async countHit(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    pruneExpired(this.hits, (window) => window.resetAt <= now);
    const window = this.hits.get(key);
    if (!window || window.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowMs });
      return 1;
    }
    window.count += 1;
    return window.count;
  }
}

// Drop expired entries once a map gets big, so dev servers don't grow forever.
function pruneExpired<V>(map: Map<string, V>, expired: (value: V) => boolean): void {
  if (map.size < 1000) return;
  for (const [key, value] of map) if (expired(value)) map.delete(key);
}

// Conditional writes run as Lua scripts, atomic on the Redis side. Each takes
// the raw JSON it read as the expected value, so a write that lost a race
// changes nothing and the caller reads again. (Multi-key scripts are fine:
// listGames already MGETs across keys, so the store is not a Redis Cluster.)
// KEYS: game key, index. ARGV: record JSON, id.
const CREATE_GAME_SCRIPT = `
if not redis.call('SET', KEYS[1], ARGV[1], 'NX') then return 0 end
redis.call('SADD', KEYS[2], ARGV[2])
return 1`;
// KEYS: game key. ARGV: expected JSON, next JSON.
const REPLACE_GAME_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`;
// KEYS: game key, index. ARGV: expected JSON, id.
const DELETE_GAME_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[2])
return 1`;
// KEYS: counter key. ARGV: window in ms.
const COUNT_HIT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return hits`;
// How often a read-modify-write starts over before giving up.
const MAX_WRITE_ATTEMPTS = 8;

class RedisGamePersistence implements GamePersistence {
  enabled = true;
  private clientPromise: Promise<RedisClientType> | null = null;

  constructor(private readonly redisUrl: string) {}

  async loadGame(id: string): Promise<PublishedGameRecord | null> {
    const client = await this.client();
    const raw = await client.get(gameKey(id));
    if (!raw) return null;
    return JSON.parse(raw) as PublishedGameRecord;
  }

  // Plain SET (no PXAT/EX) — published games are durable, not TTL'd. The id is
  // also added to the index SET so listGames can enumerate without SCAN.
  async createGame(record: PublishedGameRecord): Promise<boolean> {
    const client = await this.client();
    const created = await client.eval(CREATE_GAME_SCRIPT, {
      keys: [gameKey(record.manifest.id), GAMES_INDEX_KEY],
      arguments: [JSON.stringify(record), record.manifest.id]
    });
    return Number(created) === 1;
  }

  async updateGame(
    id: string,
    change: (current: PublishedGameRecord) => PublishedGameRecord
  ): Promise<PublishedGameRecord | null> {
    const client = await this.client();
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const raw = await client.get(gameKey(id));
      if (!raw) return null;
      const next = change(JSON.parse(raw) as PublishedGameRecord);
      const encoded = JSON.stringify(next);
      if (encoded === raw) return next;
      const replaced = await client.eval(REPLACE_GAME_SCRIPT, { keys: [gameKey(id)], arguments: [raw, encoded] });
      if (Number(replaced) === 1) return next;
    }
    throw new Error(`Games persistence: too many concurrent writes to ${id}`);
  }

  async deleteGame(id: string, check?: (current: PublishedGameRecord) => void): Promise<boolean> {
    const client = await this.client();
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const raw = await client.get(gameKey(id));
      if (!raw) return false;
      check?.(JSON.parse(raw) as PublishedGameRecord);
      const deleted = await client.eval(DELETE_GAME_SCRIPT, {
        keys: [gameKey(id), GAMES_INDEX_KEY],
        arguments: [raw, id]
      });
      if (Number(deleted) === 1) return true;
    }
    throw new Error(`Games persistence: too many concurrent writes to ${id}`);
  }

  // SMEMBERS + MGET, pruning any index ids whose record has vanished (e.g. a key
  // was manually deleted) so the index never accumulates dangling entries.
  async listGames(): Promise<PublishedGameRecord[]> {
    const client = await this.client();
    const ids = await client.sMembers(GAMES_INDEX_KEY);
    if (ids.length === 0) return [];
    const keys = ids.map((id) => gameKey(id));
    const raws = await client.mGet(keys);
    const out: PublishedGameRecord[] = [];
    const dangling: string[] = [];
    raws.forEach((raw, i) => {
      if (raw == null) {
        dangling.push(ids[i]);
        return;
      }
      out.push(JSON.parse(raw) as PublishedGameRecord);
    });
    if (dangling.length > 0) await client.sRem(GAMES_INDEX_KEY, dangling);
    return out;
  }

  async claimOnce(key: string, ttlMs: number): Promise<boolean> {
    const client = await this.client();
    const claimed = await client.set(`couch:once:${key}`, '1', {
      condition: 'NX',
      expiration: { type: 'PX', value: ttlMs }
    });
    return claimed !== null;
  }

  async countHit(key: string, windowMs: number): Promise<number> {
    const client = await this.client();
    const hits = await client.eval(COUNT_HIT_SCRIPT, { keys: [`couch:rate:${key}`], arguments: [String(windowMs)] });
    return Number(hits);
  }

  private async client(): Promise<RedisClientType> {
    if (!this.clientPromise) {
      const client = createClient({ url: this.redisUrl });
      client.on('error', (err: unknown) => {
        console.error('Redis games persistence error', err);
      });
      this.clientPromise = client.connect() as Promise<RedisClientType>;
    }
    return this.clientPromise;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function gameKey(id: string): string {
  return `couch:game:${id}`;
}

const GAMES_INDEX_KEY = 'couch:games:index';

function key(slug: string): string {
  return `couch:lobby:${slug.toUpperCase()}`;
}

function screenKey(id: string): string {
  return `couch:screen:${id}`;
}

function screenTopic(id: string): string {
  return `couch_screen_${id}`;
}

function screenRetentionSeconds(record: ScreenRecord): number {
  const seconds = Math.ceil((screenDeadline(record) - Date.now()) / 1000);
  return Math.min(604800, Math.max(60, seconds));
}

function topic(slug: string): string {
  return `couch_lobby_${slug.toUpperCase()}`;
}

function retentionSeconds(lobby: LobbyRecord): number {
  const seconds = Math.ceil((lobby.expiresAt - Date.now()) / 1000);
  return Math.min(604800, Math.max(60, seconds));
}
