import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import type { GameInputEnvelope } from '@couch/types';
import { INPUT_LOG_LIMIT, LobbyStore, type LobbyRecord } from '../src/lobbies.js';
import { createLobbyPersistence, type LobbyPersistence } from '../src/persistence.js';

// The Redis input log behind external-game inputs: one script allocates the seq
// and appends the input, so concurrent instances never share a seq and no seq
// exists without its entry. Needs a real Redis: TEST_REDIS_URL=redis://localhost:6379.
const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!redisUrl)('Redis input log (appendNextInput)', () => {
  const raw = createClient({ url: redisUrl });
  // Two persistence objects, like two serverless instances. In one process they
  // share a connection; the concurrent appends still race at the request level.
  let instanceA: LobbyPersistence;
  let instanceB: LobbyPersistence;

  beforeAll(async () => {
    await raw.connect();
    instanceA = createLobbyPersistence(redisUrl);
    instanceB = createLobbyPersistence(redisUrl);
  });

  afterAll(async () => {
    await raw.close();
  });

  async function savedLobby(): Promise<LobbyRecord> {
    const lobby = new LobbyStore().createLobby();
    await instanceA.save(lobby);
    return lobby;
  }

  function input(i: number, value?: unknown): Omit<GameInputEnvelope, 'seq'> {
    return { at: new Date(1_700_000_000_000 + i).toISOString(), playerId: `p${i % 3}`, control: 'a', action: 'press', value };
  }

  it('hands out unique, gap-free seqs to concurrent appends from two instances', async () => {
    const lobby = await savedLobby();
    const seqs = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        (i % 2 ? instanceA : instanceB).appendNextInput!(lobby.slug, input(i, { i }), lobby.expiresAt)
      )
    );
    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));

    // Every seq that was handed out is in the log, under the input it was given for.
    const stored = (await raw.lRange(`couch:lobby:${lobby.slug}:inputs`, 0, -1)).map(
      (entry) => JSON.parse(entry) as GameInputEnvelope
    );
    expect(stored).toHaveLength(40);
    seqs.forEach((seq, i) => expect(stored.find((entry) => entry.seq === seq)?.value).toEqual({ i }));

    const loaded = await instanceB.load(lobby.slug);
    expect(loaded?.inputSeq).toBe(40);
    expect(loaded?.inputLog.map((entry) => entry.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it('stores the envelope exactly as given, with or without a value', async () => {
    const lobby = await savedLobby();
    const tricky = { text: 'a "quoted" } brace, ünïcode', list: [1, 2, { deep: null }] };
    const first = await instanceA.appendNextInput!(lobby.slug, input(1, tricky), lobby.expiresAt);
    const second = await instanceA.appendNextInput!(lobby.slug, input(2), lobby.expiresAt);

    const stored = await raw.lRange(`couch:lobby:${lobby.slug}:inputs`, 0, -1);
    expect(stored).toEqual([
      JSON.stringify({ seq: first, ...input(1, tricky) }),
      JSON.stringify({ seq: second, ...input(2) })
    ]);
    expect(JSON.parse(stored[1])).not.toHaveProperty('value');
  });

  it(`keeps the last ${INPUT_LOG_LIMIT} entries and sets the lobby's expiry on list and counter`, async () => {
    const lobby = await savedLobby();
    const total = INPUT_LOG_LIMIT + 5;
    for (let i = 1; i <= total; i++) await instanceA.appendNextInput!(lobby.slug, input(i), lobby.expiresAt);

    const loaded = await instanceA.load(lobby.slug);
    expect(loaded?.inputSeq).toBe(total);
    expect(loaded?.inputLog).toHaveLength(INPUT_LOG_LIMIT);
    expect(loaded?.inputLog[0].seq).toBe(total - INPUT_LOG_LIMIT + 1);
    expect(loaded?.inputLog.at(-1)?.seq).toBe(total);

    // PTTL rather than PEXPIRETIME so the test runs on Redis < 7 too.
    for (const key of [`couch:lobby:${lobby.slug}:inputs`, `couch:lobby:${lobby.slug}:inputseq`]) {
      const remaining = lobby.expiresAt - Date.now();
      const ttl = await raw.pTTL(key);
      expect(ttl).toBeLessThanOrEqual(remaining + 50);
      expect(ttl).toBeGreaterThan(remaining - 5_000);
    }
  });

  it('starts at seq 1 again after resetInputs', async () => {
    const lobby = await savedLobby();
    await instanceA.appendNextInput!(lobby.slug, input(1), lobby.expiresAt);
    await instanceA.appendNextInput!(lobby.slug, input(2), lobby.expiresAt);
    await instanceB.resetInputs!(lobby.slug);
    expect(await instanceB.appendNextInput!(lobby.slug, input(3), lobby.expiresAt)).toBe(1);
    expect((await instanceA.load(lobby.slug))?.inputLog.map((entry) => entry.seq)).toEqual([1]);
  });
});
