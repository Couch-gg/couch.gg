import { PollingQueueClient } from '@vercel/queue';
import { createClient, type RedisClientType } from 'redis';
import {
  deserializeLobbyRecord,
  serializeLobbyRecord,
  type LobbyRecord,
  type SerializedLobbyRecord
} from './lobbies.js';

export interface LobbyPersistence {
  enabled: boolean;
  delete(slug: string): Promise<void>;
  load(slug: string): Promise<LobbyRecord | null>;
  save(lobby: LobbyRecord): Promise<void>;
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
  async save() {}
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
}

function key(slug: string): string {
  return `couch:lobby:${slug.toUpperCase()}`;
}

function topic(slug: string): string {
  return `couch_lobby_${slug.toUpperCase()}`;
}

function retentionSeconds(lobby: LobbyRecord): number {
  const seconds = Math.ceil((lobby.expiresAt - Date.now()) / 1000);
  return Math.min(604800, Math.max(60, seconds));
}
