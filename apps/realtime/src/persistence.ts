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

function key(slug: string): string {
  return `couch:lobby:${slug.toUpperCase()}`;
}
