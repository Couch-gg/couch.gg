import { describe, expect, it } from 'vitest';
import type { ControllerEvent, ExternalGameManifest, GameId, GameManifest } from '@couch/types';
import { getGameManifest } from '@couch/game-runtime';
import {
  LobbyStore,
  deserializeLobbyRecord,
  isTrebuchetSnapshot,
  serializeLobbyRecord,
  type ManifestResolver
} from '../src/lobbies.js';
import { RateLimiter } from '../src/rate-limit.js';
import { parseExternalGamesJson } from '../src/external-games.js';

// A minimal valid external manifest whose controls the relay validates against.
const TAP_RACE: ExternalGameManifest = {
  id: 'tap-race',
  title: 'Tap Race',
  description: 'First to thirty taps wins.',
  minPlayers: 2,
  maxPlayers: 4,
  controllerLayout: {
    kind: 'generic-buttons',
    controls: [
      { control: 'tap', type: 'button', label: 'Tap' },
      { control: 'gear', type: 'select', label: 'Gear', options: ['lo', 'hi'] }
    ]
  },
  aspectRatio: '16:9',
  estimatedDurationMinutes: 3,
  status: 'published',
  origin: 'external',
  entryUrl: 'https://games.example.com/tap-race/',
  supportsRemote: true,
  sdkProtocol: 1,
  publishedAt: '2026-07-01T00:00:00.000Z',
  thumbnail: { kind: 'css', gradient: 'linear-gradient(#000,#111)', icon: 'Zap' }
};

// A remote-incapable external variant for the selectGame 409 case.
const LOCAL_ONLY: ExternalGameManifest = {
  ...TAP_RACE,
  id: 'local-blast',
  title: 'Local Blast',
  supportsRemote: false
};

// Build a resolver that layers the external test manifests over the built-ins.
// Built-ins fall through to the runtime's throwing getGameManifest (wrapped to
// null) so a default-trebuchet lobby still resolves during join.
function makeResolver(...externals: ExternalGameManifest[]): ManifestResolver {
  const byId = new Map<GameId, GameManifest>(externals.map((game) => [game.id, game]));
  return (id) => byId.get(id) ?? tryBuiltin(id);
}

function tryBuiltin(id: GameId): GameManifest | null {
  try {
    return getGameManifest(id);
  } catch {
    return null;
  }
}

// Start an external game with `n` players and return the store, slug, and tokens.
function startedExternal(mode: 'local' | 'remote' = 'local', n = 2) {
  const store = new LobbyStore(makeResolver(TAP_RACE, LOCAL_ONLY));
  const lobby = store.createLobby(Date.now(), mode);
  const tokens: Array<{ id: string; token: string }> = [];
  const host = store.joinPlayer(lobby.slug, 'Alex');
  tokens.push({ id: host.player.id, token: host.playerToken });
  for (let i = 1; i < n; i++) {
    const guest = store.joinPlayer(lobby.slug, `P${i}`);
    tokens.push({ id: guest.player.id, token: guest.playerToken });
  }
  store.selectGame(lobby.slug, host.playerToken, TAP_RACE.id);
  const started = store.startGame(lobby.slug, host.playerToken);
  return { store, slug: lobby.slug, tokens, host, started };
}

// Build a well-formed relayed input controller event.
function tapEvent(action: 'press' | 'release' | 'change' = 'press', data?: unknown): ControllerEvent {
  return {
    playerId: 'ignored-by-server',
    type: 'game',
    control: 'tap',
    value: { action, ...(data !== undefined ? { data } : {}) },
    timestamp: Date.now()
  };
}

describe('external startGame', () => {
  it('starts with no engine, an external snapshot with a seed, and returns null', () => {
    const { store, slug, started } = startedExternal();
    expect(started).toBeNull();

    const record = store.getLobby(slug);
    expect(record.engine).toBeNull();
    expect(record.state).toBe('playing');
    expect(record.gameSession?.state).toBe('running');

    const snapshot = record.gameSession?.snapshot as { kind?: string; seed?: string };
    expect(snapshot.kind).toBe('external');
    expect(typeof snapshot.seed).toBe('string');
    expect((snapshot.seed as string).length).toBeGreaterThanOrEqual(12);
    expect(record.inputSeq).toBe(0);
    expect(record.inputLog).toHaveLength(0);
  });

  it('resets inputSeq/inputLog on each start (fresh counter per game)', () => {
    const { store, slug, tokens } = startedExternal();
    store.recordGameInput(slug, tokens[0].token, tapEvent());
    store.recordGameInput(slug, tokens[1].token, tapEvent());
    expect(store.getLobby(slug).inputSeq).toBe(2);

    // Force back to waiting and restart — seq must restart at 1 on the next input.
    const record = store.getLobby(slug);
    record.state = 'waiting';
    store.startGame(slug, tokens[0].token);
    expect(store.getLobby(slug).inputSeq).toBe(0);
    const env = store.recordGameInput(slug, tokens[0].token, tapEvent());
    expect(env.seq).toBe(1);
  });
});

describe('recordGameInput', () => {
  it('stamps monotonically increasing seq starting at 1', () => {
    const { store, slug, tokens } = startedExternal();
    const a = store.recordGameInput(slug, tokens[0].token, tapEvent());
    const b = store.recordGameInput(slug, tokens[1].token, tapEvent());
    const c = store.recordGameInput(slug, tokens[0].token, tapEvent('release'));
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(store.getLobby(slug).inputLog.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('derives playerId from the token and ignores the payload playerId', () => {
    const { store, slug, tokens } = startedExternal();
    const env = store.recordGameInput(slug, tokens[1].token, tapEvent());
    expect(env.playerId).toBe(tokens[1].id);
    expect(env.playerId).not.toBe('ignored-by-server');
  });

  it('trims the input log ring buffer to the last 128 entries', () => {
    const { store, slug, tokens } = startedExternal();
    for (let i = 0; i < 200; i++) {
      store.recordGameInput(slug, tokens[0].token, tapEvent());
    }
    const log = store.getLobby(slug).inputLog;
    expect(log).toHaveLength(128);
    // Oldest kept entry is seq 73 (200 total, keep last 128 → 73..200).
    expect(log[0].seq).toBe(73);
    expect(log[log.length - 1].seq).toBe(200);
  });

  it('publicLobby exposes mode and only the last 64 input-log entries', () => {
    const { store, slug, tokens } = startedExternal('remote');
    for (let i = 0; i < 100; i++) {
      store.recordGameInput(slug, tokens[0].token, tapEvent());
    }
    const pub = store.publicLobby(slug);
    expect(pub.mode).toBe('remote');
    expect(pub.inputLog).toHaveLength(64);
    expect(pub.inputLog?.[0].seq).toBe(37); // 100 total, last 64 → 37..100
    expect(pub.inputLog?.[63].seq).toBe(100);
  });

  it('rejects an unknown control name', () => {
    const { store, slug, tokens } = startedExternal();
    const evt = { ...tapEvent(), control: 'not-a-control' };
    expect(() => store.recordGameInput(slug, tokens[0].token, evt)).toThrow(/Steuerung/);
  });

  it('rejects an invalid action', () => {
    const { store, slug, tokens } = startedExternal();
    const evt: ControllerEvent = { ...tapEvent(), value: { action: 'wiggle' } };
    expect(() => store.recordGameInput(slug, tokens[0].token, evt)).toThrow(/Aktion/);
  });

  it('rejects a value payload larger than 1KB', () => {
    const { store, slug, tokens } = startedExternal();
    const big = 'x'.repeat(1100);
    expect(() => store.recordGameInput(slug, tokens[0].token, tapEvent('change', big))).toThrow(/groß/);
  });

  it('accepts a value payload at the 1KB boundary', () => {
    const { store, slug, tokens } = startedExternal();
    // "<1024 chars>" JSON-encodes to length 1024 including the surrounding quotes.
    const ok = 'y'.repeat(1022);
    const env = store.recordGameInput(slug, tokens[0].token, tapEvent('change', ok));
    expect(env.value).toBe(ok);
    expect(JSON.stringify(ok).length).toBe(1024);
  });

  it('rejects input when the lobby is not playing', () => {
    const store = new LobbyStore(makeResolver(TAP_RACE));
    const lobby = store.createLobby();
    const host = store.joinPlayer(lobby.slug, 'Alex');
    store.joinPlayer(lobby.slug, 'Bea');
    store.selectGame(lobby.slug, host.playerToken, TAP_RACE.id);
    // Not started yet → state 'waiting'.
    expect(() => store.recordGameInput(lobby.slug, host.playerToken, tapEvent())).toThrow(/laufendes/);
  });

  it('rejects input from an unknown token (401)', () => {
    const { store, slug } = startedExternal();
    expect(() => store.recordGameInput(slug, 'bogus-token', tapEvent())).toThrow(/Controller/);
  });
});

describe('finishExternalGame', () => {
  it('sets scores, finishes the session, ends the lobby, and returns true', () => {
    const { store, slug, tokens } = startedExternal();
    const ok = store.finishExternalGame(slug, [
      { playerId: tokens[0].id, score: 30 },
      { playerId: tokens[1].id, score: 12 }
    ]);
    expect(ok).toBe(true);

    const record = store.getLobby(slug);
    expect(record.state).toBe('ended');
    expect(record.gameSession?.state).toBe('finished');
    const snapshot = record.gameSession?.snapshot as { scores?: Array<{ playerId: string; score: number }> };
    expect(snapshot.scores).toEqual([
      { playerId: tokens[0].id, score: 30 },
      { playerId: tokens[1].id, score: 12 }
    ]);
  });

  it('is idempotent — a second finish is a no-op returning false', () => {
    const { store, slug, tokens } = startedExternal();
    expect(store.finishExternalGame(slug, [{ playerId: tokens[0].id, score: 5 }])).toBe(true);
    expect(store.finishExternalGame(slug, [{ playerId: tokens[0].id, score: 99 }])).toBe(false);
    // The first result stands.
    const snapshot = store.getLobby(slug).gameSession?.snapshot as { scores?: Array<{ score: number }> };
    expect(snapshot.scores?.[0].score).toBe(5);
  });

  it('filters reported scores down to the current roster', () => {
    const { store, slug, tokens } = startedExternal();
    const ok = store.finishExternalGame(slug, [
      { playerId: tokens[0].id, score: 20 },
      { playerId: 'ghost-player', score: 999 }
    ]);
    expect(ok).toBe(true);
    const snapshot = store.getLobby(slug).gameSession?.snapshot as { scores?: Array<{ playerId: string }> };
    expect(snapshot.scores?.map((s) => s.playerId)).toEqual([tokens[0].id]);
  });

  it('returns false when there is no external session', () => {
    const store = new LobbyStore(makeResolver(TAP_RACE));
    const lobby = store.createLobby();
    store.joinPlayer(lobby.slug, 'Alex');
    expect(store.finishExternalGame(lobby.slug, [])).toBe(false);
  });

  it('rejects malformed scores (non-array or bad entries)', () => {
    const { store, slug } = startedExternal();
    expect(() => store.finishExternalGame(slug, 'nope' as unknown)).toThrow(/Punktestände/);
  });
});

describe('snapshot guards', () => {
  it('isTrebuchetSnapshot distinguishes external snapshots', () => {
    expect(isTrebuchetSnapshot({ kind: 'external', seed: 'abc' })).toBe(false);
    expect(isTrebuchetSnapshot({ units: [], phase: 'running' })).toBe(true);
    expect(isTrebuchetSnapshot(null)).toBe(false);
  });

  it('renaming a player during an external game does not crash', () => {
    const { store, slug, tokens } = startedExternal();
    const renamed = store.renamePlayer(slug, tokens[0].token, 'Zed');
    expect(renamed.player.name).toBe('Zed');
    // No trebuchet snapshot rewrite happened.
    expect(renamed.gameEvent).toBeNull();
  });

  it('disconnect cleanup during an external game does not crash', () => {
    const { store, slug, tokens } = startedExternal('local', 2);
    store.markDisconnected(slug, tokens[1].id, 100);
    const result = store.removeIfStillDisconnected(slug, tokens[1].id, 100);
    expect(result).not.toBeNull();
    expect(result?.gameEvent).toBeNull();
    // The surviving player remains; the lobby did not fault on the external snapshot.
    expect(store.getLobby(slug).players.has(tokens[0].id)).toBe(true);
  });
});

describe('serialize round-trip', () => {
  it('preserves mode/inputSeq/inputLog and does NOT rebuild an engine for external', () => {
    const { store, slug, tokens } = startedExternal('remote');
    store.recordGameInput(slug, tokens[0].token, tapEvent());
    store.recordGameInput(slug, tokens[1].token, tapEvent('release'));

    const record = store.getLobby(slug);
    const restored = deserializeLobbyRecord(serializeLobbyRecord(record));

    expect(restored.mode).toBe('remote');
    expect(restored.inputSeq).toBe(2);
    expect(restored.inputLog).toHaveLength(2);
    expect(restored.inputLog.map((e) => e.seq)).toEqual([1, 2]);
    // External snapshot in 'playing' state must NOT resurrect a Trebuchet engine.
    expect(restored.engine).toBeNull();
    const snapshot = restored.gameSession?.snapshot as { kind?: string };
    expect(snapshot.kind).toBe('external');
  });

  it('defaults mode/inputSeq/inputLog for records persisted without them', () => {
    const store = new LobbyStore(makeResolver(TAP_RACE));
    const lobby = store.createLobby();
    store.joinPlayer(lobby.slug, 'Alex');
    const serialized = serializeLobbyRecord(store.getLobby(lobby.slug));
    // Simulate a pre-external persisted record.
    delete (serialized as { mode?: unknown }).mode;
    delete (serialized as { inputSeq?: unknown }).inputSeq;
    delete (serialized as { inputLog?: unknown }).inputLog;
    const restored = deserializeLobbyRecord(serialized);
    expect(restored.mode).toBe('local');
    expect(restored.inputSeq).toBe(0);
    expect(restored.inputLog).toEqual([]);
  });
});

describe('selectGame remote gating', () => {
  it('rejects a non-remote external game in a remote lobby (409)', () => {
    const store = new LobbyStore(makeResolver(TAP_RACE, LOCAL_ONLY));
    const lobby = store.createLobby(Date.now(), 'remote');
    const host = store.joinPlayer(lobby.slug, 'Alex');
    expect(() => store.selectGame(lobby.slug, host.playerToken, LOCAL_ONLY.id)).toThrow(/Remote Couch/);
  });

  it('allows a remote-capable external game in a remote lobby', () => {
    const store = new LobbyStore(makeResolver(TAP_RACE, LOCAL_ONLY));
    const lobby = store.createLobby(Date.now(), 'remote');
    const host = store.joinPlayer(lobby.slug, 'Alex');
    const pub = store.selectGame(lobby.slug, host.playerToken, TAP_RACE.id);
    expect(pub.currentGameId).toBe(TAP_RACE.id);
  });

  it('allows a non-remote external game in a local lobby', () => {
    const store = new LobbyStore(makeResolver(TAP_RACE, LOCAL_ONLY));
    const lobby = store.createLobby(Date.now(), 'local');
    const host = store.joinPlayer(lobby.slug, 'Alex');
    const pub = store.selectGame(lobby.slug, host.playerToken, LOCAL_ONLY.id);
    expect(pub.currentGameId).toBe(LOCAL_ONLY.id);
  });
});

describe('RateLimiter', () => {
  it('sustains 10 inputs/sec for a single player', () => {
    const rl = new RateLimiter();
    let now = 1_000_000;
    let allowed = 0;
    // 30 ticks, one every 100ms → exactly 10/s. Bucket starts full (20) so all pass.
    for (let i = 0; i < 30; i++) {
      if (rl.allow('ROOM', 'p1', now)) allowed++;
      now += 100;
    }
    expect(allowed).toBe(30);
  });

  it('drops a burst beyond the per-player capacity of 20', () => {
    const rl = new RateLimiter();
    const now = 2_000_000;
    let allowed = 0;
    for (let i = 0; i < 25; i++) {
      if (rl.allow('ROOM', 'p1', now)) allowed++;
    }
    // Capacity 20 with no time elapsed → 20 allowed, 5 dropped.
    expect(allowed).toBe(20);
  });

  it('enforces the per-slug aggregate capacity of 60 across players', () => {
    const rl = new RateLimiter();
    const now = 3_000_000;
    let allowed = 0;
    // 8 players each firing 10 instantly = 80 attempts. Per-player cap (20) never
    // binds here; the slug aggregate cap (60) does.
    for (let p = 0; p < 8; p++) {
      for (let i = 0; i < 10; i++) {
        if (rl.allow('ROOM', `p${p}`, now)) allowed++;
      }
    }
    expect(allowed).toBe(60);
  });

  it('refills tokens over time', () => {
    const rl = new RateLimiter();
    let now = 4_000_000;
    // Drain the player bucket (20).
    for (let i = 0; i < 20; i++) rl.allow('ROOM', 'p1', now);
    expect(rl.allow('ROOM', 'p1', now)).toBe(false);
    // After 1s, ~10 tokens refill (player refill 10/s).
    now += 1000;
    let allowed = 0;
    for (let i = 0; i < 12; i++) {
      if (rl.allow('ROOM', 'p1', now)) allowed++;
    }
    expect(allowed).toBe(10);
  });

  it('keeps per-player buckets independent', () => {
    const rl = new RateLimiter();
    const now = 5_000_000;
    for (let i = 0; i < 20; i++) rl.allow('ROOM', 'p1', now);
    expect(rl.allow('ROOM', 'p1', now)).toBe(false);
    // A different player in the same slug still has their own bucket.
    expect(rl.allow('ROOM', 'p2', now)).toBe(true);
  });
});

describe('parseExternalGamesJson', () => {
  const silent = () => undefined;

  it('accepts a valid entry and stamps origin/status/publishedAt', () => {
    const input = JSON.stringify([
      {
        id: 'tap-race',
        title: 'Tap Race',
        description: 'First to thirty taps wins.',
        minPlayers: 2,
        maxPlayers: 4,
        controllerLayout: { kind: 'generic-buttons', controls: [{ control: 'tap', type: 'button', label: 'Tap' }] },
        aspectRatio: '16:9',
        estimatedDurationMinutes: 3,
        thumbnail: { kind: 'css', gradient: 'linear-gradient(#000,#111)', icon: 'Zap' },
        entryUrl: 'https://games.example.com/tap-race/',
        sdkProtocol: 1
      }
    ]);
    const out = parseExternalGamesJson(input, { now: () => 'STAMP', onWarn: silent });
    expect(out).toHaveLength(1);
    expect(out[0].origin).toBe('external');
    expect(out[0].status).toBe('published');
    expect(out[0].publishedAt).toBe('STAMP');
    expect(out[0].id).toBe('tap-race');
  });

  it('skips invalid entries but keeps valid ones', () => {
    const input = JSON.stringify([
      { id: 'BAD ID', title: 'x' }, // invalid
      {
        id: 'good-game',
        title: 'Good',
        description: 'A good game.',
        minPlayers: 1,
        maxPlayers: 2,
        controllerLayout: { kind: 'generic-buttons', controls: [{ control: 'go', type: 'button', label: 'Go' }] },
        aspectRatio: '4:3',
        estimatedDurationMinutes: 5,
        thumbnail: { kind: 'css', gradient: 'g', icon: 'i' },
        entryUrl: 'https://example.com/',
        sdkProtocol: 1
      }
    ]);
    const warnings: string[] = [];
    const out = parseExternalGamesJson(input, { onWarn: (m) => warnings.push(m) });
    expect(out.map((g) => g.id)).toEqual(['good-game']);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('returns [] for empty, malformed, or non-array input', () => {
    expect(parseExternalGamesJson('', { onWarn: silent })).toEqual([]);
    expect(parseExternalGamesJson(undefined, { onWarn: silent })).toEqual([]);
    expect(parseExternalGamesJson('{not json', { onWarn: silent })).toEqual([]);
    expect(parseExternalGamesJson('{"id":"x"}', { onWarn: silent })).toEqual([]);
  });
});
