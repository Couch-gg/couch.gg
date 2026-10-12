import { describe, expect, it } from 'vitest';
import type { ControllerEvent, ExternalGameManifest, GameId, GameManifest } from '@couch/types';
import { FALLBACK_THUMBNAIL_GRADIENT, FALLBACK_THUMBNAIL_ICON, getGameManifest } from '@couch/game-runtime';
import {
  LobbyStore,
  deserializeLobbyRecord,
  hostScreenId,
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

describe('commitGameInput (externally allocated seq)', () => {
  it('keeps the log sorted when seqs from other instances land out of order', () => {
    const { store, slug, tokens } = startedExternal();
    const first = store.prepareGameInput(slug, tokens[0].token, tapEvent());
    const second = store.prepareGameInput(slug, tokens[1].token, tapEvent());
    store.commitGameInput(slug, second, 2);
    store.commitGameInput(slug, first, 1);
    expect(store.getLobby(slug).inputLog.map((e) => e.seq)).toEqual([1, 2]);
    expect(store.getLobby(slug).inputSeq).toBe(2);
  });

  it('stamps the at stored with the seq instead of a fresh one', () => {
    const { store, slug, tokens } = startedExternal();
    const prepared = store.prepareGameInput(slug, tokens[0].token, tapEvent());
    const envelope = store.commitGameInput(slug, prepared, 1, '2026-10-01T00:00:00.000Z');
    expect(envelope.at).toBe('2026-10-01T00:00:00.000Z');
    expect(store.getLobby(slug).inputLog[0]).toEqual(envelope);
  });

  it('rejects before a seq is taken', () => {
    const { store, slug, tokens } = startedExternal();
    expect(() => store.prepareGameInput(slug, tokens[0].token, tapEvent('bogus' as never))).toThrow(/Aktion/);
    expect(store.getLobby(slug).inputSeq).toBe(0);
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
  it('sustains 20 inputs/sec for a single player (a stick plus buttons)', () => {
    const rl = new RateLimiter();
    let now = 1_000_000;
    let allowed = 0;
    // 60 ticks, one every 50ms → exactly 20/s. Bucket starts full (40) so all pass.
    for (let i = 0; i < 60; i++) {
      if (rl.allow('ROOM', 'p1', now)) allowed++;
      now += 50;
    }
    expect(allowed).toBe(60);
  });

  it('drops a burst beyond the per-player capacity of 40', () => {
    const rl = new RateLimiter();
    const now = 2_000_000;
    let allowed = 0;
    for (let i = 0; i < 45; i++) {
      if (rl.allow('ROOM', 'p1', now)) allowed++;
    }
    expect(allowed).toBe(40);
  });

  it('enforces the per-slug aggregate capacity of 320 across players', () => {
    const rl = new RateLimiter();
    const now = 3_000_000;
    let allowed = 0;
    // 10 player ids each firing 40 instantly = 400 attempts. Per-player cap (40)
    // never binds here; the slug aggregate cap (8 x 40 = 320) does.
    for (let p = 0; p < 10; p++) {
      for (let i = 0; i < 40; i++) {
        if (rl.allow('ROOM', `p${p}`, now)) allowed++;
      }
    }
    expect(allowed).toBe(320);
  });

  it('fits a full lobby of 8 sticks at 15 changes/s plus buttons without drops', () => {
    const rl = new RateLimiter();
    let now = 3_500_000;
    let dropped = 0;
    // 10 s of 8 players each sending 20 inputs/s (a stick at ~15/s plus taps).
    for (let tick = 0; tick < 200; tick++) {
      for (let p = 0; p < 8; p++) {
        if (!rl.allow('ROOM', `p${p}`, now)) dropped++;
      }
      now += 50;
    }
    expect(dropped).toBe(0);
  });

  it('refills tokens over time', () => {
    const rl = new RateLimiter();
    let now = 4_000_000;
    for (let i = 0; i < 40; i++) rl.allow('ROOM', 'p1', now);
    expect(rl.allow('ROOM', 'p1', now)).toBe(false);
    // After 1s, 20 tokens refill (player refill 20/s).
    now += 1000;
    let allowed = 0;
    for (let i = 0; i < 25; i++) {
      if (rl.allow('ROOM', 'p1', now)) allowed++;
    }
    expect(allowed).toBe(20);
  });

  it('keeps per-player buckets independent', () => {
    const rl = new RateLimiter();
    const now = 5_000_000;
    for (let i = 0; i < 40; i++) rl.allow('ROOM', 'p1', now);
    expect(rl.allow('ROOM', 'p1', now)).toBe(false);
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

  it('keeps an entry whose thumbnail breaks the catalog rules, with the fallback look', () => {
    const input = JSON.stringify([
      {
        id: 'old-thumb',
        title: 'Old Thumb',
        description: 'Registered before the thumbnail rules.',
        minPlayers: 1,
        maxPlayers: 2,
        controllerLayout: { kind: 'generic-buttons', controls: [{ control: 'go', type: 'button', label: 'Go' }] },
        aspectRatio: '16:9',
        estimatedDurationMinutes: 5,
        thumbnail: {
          kind: 'css',
          gradient: 'url(https://tracker.example/p.gif?x=1) center/cover',
          icon: 'createLucideIcon',
          accent: '#62d5d5'
        },
        entryUrl: 'https://example.com/',
        sdkProtocol: 1
      }
    ]);
    const warnings: string[] = [];
    const out = parseExternalGamesJson(input, { onWarn: (m) => warnings.push(m) });
    expect(out).toHaveLength(1);
    expect(out[0].thumbnail).toEqual({
      kind: 'css',
      gradient: FALLBACK_THUMBNAIL_GRADIENT,
      icon: FALLBACK_THUMBNAIL_ICON,
      accent: '#62d5d5'
    });
    expect(warnings.join(' ')).toMatch(/icon, gradient/);
  });

  it('returns [] for empty, malformed, or non-array input', () => {
    expect(parseExternalGamesJson('', { onWarn: silent })).toEqual([]);
    expect(parseExternalGamesJson(undefined, { onWarn: silent })).toEqual([]);
    expect(parseExternalGamesJson('{not json', { onWarn: silent })).toEqual([]);
    expect(parseExternalGamesJson('{"id":"x"}', { onWarn: silent })).toEqual([]);
  });
});

describe('setControllerState (couch.setController)', () => {
  it('keeps labels/disabled across patches and replaces one-shot effects', () => {
    const { store, slug, tokens } = startedExternal();
    const first = store.setControllerState(slug, tokens[0].id, { labels: { tap: 'SHIELD' }, cooldowns: { tap: 3000 }, vibrate: 80 });
    expect(first).toEqual({ seq: 1, labels: { tap: 'SHIELD' }, disabled: [], cooldowns: { tap: 3000 }, vibrate: [80] });

    const second = store.setControllerState(slug, tokens[0].id, { disabled: ['gear'] });
    expect(second).toEqual({ seq: 2, labels: { tap: 'SHIELD' }, disabled: ['gear'], cooldowns: {}, vibrate: null });
    expect(store.publicLobby(slug).controllerState?.[tokens[1].id]).toBeUndefined();
  });

  it('rejects unknown controls and out-of-range values', () => {
    const { store, slug, tokens } = startedExternal();
    expect(() => store.setControllerState(slug, tokens[0].id, { labels: { nope: 'X' } })).toThrow(/Unbekannte/);
    expect(() => store.setControllerState(slug, tokens[0].id, { labels: { tap: 'A'.repeat(17) } })).toThrow(/Label/);
    expect(() => store.setControllerState(slug, tokens[0].id, { cooldowns: { tap: 120_000 } })).toThrow(/Cooldown/);
    expect(() => store.setControllerState(slug, tokens[0].id, { vibrate: [] })).toThrow(/vibrate/);
    expect(() => store.setControllerState(slug, 'player_ghost', { labels: { tap: 'X' } })).toThrow(/Spieler/);
  });

  it('stores labels/cooldowns for prototype-named controls as own keys', () => {
    // A manifest that predates the validator's reserved-name rule.
    const PROTO: ExternalGameManifest = {
      ...TAP_RACE,
      id: 'proto-pad',
      controllerLayout: {
        kind: 'generic-buttons',
        controls: [
          { control: '__proto__', type: 'button', label: 'P' },
          { control: 'constructor', type: 'button', label: 'C' }
        ]
      }
    };
    const store = new LobbyStore(makeResolver(PROTO));
    const lobby = store.createLobby(Date.now(), 'local');
    const host = store.joinPlayer(lobby.slug, 'Alex');
    store.joinPlayer(lobby.slug, 'Bea');
    store.selectGame(lobby.slug, host.playerToken, PROTO.id);
    store.startGame(lobby.slug, host.playerToken);

    const state = store.setControllerState(lobby.slug, host.player.id, {
      labels: { ['__proto__']: 'SHIELD', constructor: 'BASH' },
      cooldowns: { ['__proto__']: 500 }
    });
    expect(Object.hasOwn(state.labels, '__proto__')).toBe(true);
    expect(state.labels['__proto__']).toBe('SHIELD');
    expect(state.labels.constructor).toBe('BASH');
    expect(Object.hasOwn(state.cooldowns, '__proto__')).toBe(true);
    expect(Object.hasOwn(state.cooldowns, 'constructor')).toBe(false);
    expect(JSON.parse(JSON.stringify(state)).labels).toEqual({ ['__proto__']: 'SHIELD', constructor: 'BASH' });
  });

  it('is cleared when a new round starts and survives persistence', () => {
    const { store, slug, tokens, host } = startedExternal();
    store.setControllerState(slug, tokens[0].id, { labels: { tap: 'SHIELD' } });
    const restored = deserializeLobbyRecord(serializeLobbyRecord(store.getLobby(slug)));
    expect(restored.controllerState[tokens[0].id].labels).toEqual({ tap: 'SHIELD' });

    store.finishExternalGame(slug, []);
    store.getLobby(slug).state = 'waiting';
    store.startGame(slug, host.playerToken);
    expect(store.getLobby(slug).controllerState).toEqual({});
  });
});

describe('screens and the host screen (host-authoritative mode)', () => {
  it("picks the host player's screen, else the first screen that joined", () => {
    const store = new LobbyStore(makeResolver(TAP_RACE));
    const lobby = store.createLobby(Date.now(), 'remote');
    expect(store.publicLobby(lobby.slug).hostScreenId).toBeNull();

    store.joinScreen(lobby.slug, 'scr_guest', undefined);
    const hostScreen = store.joinScreen(lobby.slug, 'scr_host', undefined);
    expect(store.joinScreen(lobby.slug, 'scr_host', hostScreen.screenToken).changed).toBe(false); // already known
    expect(store.joinScreen(lobby.slug, 'not a screen id', undefined)).toEqual({ screenId: null, changed: false });
    expect(store.publicLobby(lobby.slug).hostScreenId).toBe('scr_guest');

    const host = store.joinPlayer(lobby.slug, 'Alex', undefined, 'scr_host');
    const guest = store.joinPlayer(lobby.slug, 'Bea', undefined, 'scr_guest');
    const pub = store.publicLobby(lobby.slug);
    expect(pub.hostScreenId).toBe('scr_host');
    expect(pub.players.map((p) => [p.name, p.screenId])).toEqual([
      ['Alex', 'scr_host'],
      ['Bea', 'scr_guest']
    ]);
    expect(hostScreenId(store.getLobby(lobby.slug))).toBe('scr_host');

    // Seats survive persistence; a reconnect without a seat keeps the old one.
    const restored = deserializeLobbyRecord(serializeLobbyRecord(store.getLobby(lobby.slug)));
    expect(restored.screens).toEqual(['scr_guest', 'scr_host']);
    store.joinPlayer(lobby.slug, 'Bea', guest.playerToken);
    expect(store.getLobby(lobby.slug).players.get(guest.player.id)?.screenId).toBe('scr_guest');
    expect(host.player.screenId).toBe('scr_host');
  });

  it('binds a screen id to the token from its first join', () => {
    const store = new LobbyStore(makeResolver(TAP_RACE));
    const { slug } = store.createLobby(Date.now(), 'remote');
    const first = store.joinScreen(slug, 'scr_tv', undefined);
    expect(first).toMatchObject({ screenId: 'scr_tv', changed: true });
    expect(typeof first.screenToken).toBe('string');
    expect(first.screenToken!.length).toBeGreaterThanOrEqual(32);

    // Rejoin (reload/reconnect): the token is required, and not handed out again.
    expect(() => store.joinScreen(slug, 'scr_tv', undefined)).toThrow(/anderen Gerät/);
    expect(() => store.joinScreen(slug, 'scr_tv', 'guessed')).toThrow(/anderen Gerät/);
    expect(store.joinScreen(slug, 'scr_tv', first.screenToken)).toEqual({ screenId: 'scr_tv', changed: false, screenToken: undefined });

    // Only the hash is kept, it survives persistence, and it is never public.
    const record = store.getLobby(slug);
    expect(Object.values(record.screenSecrets)).not.toContain(first.screenToken);
    const restored = deserializeLobbyRecord(serializeLobbyRecord(record));
    expect(restored.screenSecrets).toEqual(record.screenSecrets);
    expect(JSON.stringify(store.publicLobby(slug))).not.toContain(record.screenSecrets.scr_tv.hash);
  });

  it('refuses a new screen once the lobby is full instead of evicting one', () => {
    const store = new LobbyStore(makeResolver(TAP_RACE));
    const { slug } = store.createLobby(Date.now(), 'remote');
    for (let i = 0; i < 8; i++) store.joinScreen(slug, `scr_tv${i}`, undefined);
    expect(() => store.joinScreen(slug, 'scr_late', undefined)).toThrow(/genug Screens/);
    expect(store.getLobby(slug).screens).toEqual(['scr_tv0', 'scr_tv1', 'scr_tv2', 'scr_tv3', 'scr_tv4', 'scr_tv5', 'scr_tv6', 'scr_tv7']);
    expect(store.publicLobby(slug).hostScreenId).toBe('scr_tv0');
    expect(store.getLobby(slug).screenSecrets.scr_late).toBeUndefined();
  });

  it('falls back to a live screen when the host seat is removed, and the TV can come back', () => {
    const store = new LobbyStore(makeResolver(TAP_RACE));
    const { slug } = store.createLobby(Date.now(), 'remote');
    const a = store.joinScreen(slug, 'scr_a', undefined);
    store.joinScreen(slug, 'scr_b', undefined);
    store.joinPlayer(slug, 'Alex', undefined, 'scr_a');
    expect(store.publicLobby(slug).hostScreenId).toBe('scr_a');

    expect(store.removeScreen(slug, 'scr_a')).toBe(true);
    expect(store.removeScreen(slug, 'scr_a')).toBe(false);
    expect(store.publicLobby(slug).hostScreenId).toBe('scr_b');

    // The same TV rejoins with its token and is the host seat again; nobody
    // else can claim its id meanwhile.
    expect(() => store.joinScreen(slug, 'scr_a', undefined)).toThrow(/anderen Gerät/);
    expect(store.joinScreen(slug, 'scr_a', a.screenToken).changed).toBe(true);
    expect(store.publicLobby(slug).hostScreenId).toBe('scr_a');
  });

  it('notes a dropped screen in the record, so a rejoin on another instance keeps it', () => {
    const grace = 10_000;
    const instanceA = new LobbyStore(makeResolver(TAP_RACE));
    const { slug } = instanceA.createLobby(Date.now(), 'remote');
    const tv = instanceA.joinScreen(slug, 'scr_tv', undefined, 'sock-1');
    expect(instanceA.markScreenLeft(slug, 'scr_tv', 'sock-1', 1_000)).toBe(true);
    expect(instanceA.markScreenLeft(slug, 'scr_tv', 'sock-1', 2_000)).toBe(false); // already noted

    // The TV comes back on instance B, which only knows the stored record.
    const instanceB = new LobbyStore(makeResolver(TAP_RACE));
    instanceB.lobbies.set(slug, deserializeLobbyRecord(serializeLobbyRecord(instanceA.getLobby(slug))));
    expect(instanceB.joinScreen(slug, 'scr_tv', tv.screenToken, 'sock-2').changed).toBe(true);

    // A's grace check reads the record B saved: the TV is back, nothing goes.
    instanceA.lobbies.set(slug, deserializeLobbyRecord(serializeLobbyRecord(instanceB.getLobby(slug))));
    expect(instanceA.dropGoneScreens(slug, 1_000 + grace, grace)).toBe(false);
    expect(instanceA.getLobby(slug).screens).toEqual(['scr_tv']);
    expect(instanceA.publicLobby(slug).hostScreenId).toBe('scr_tv');
  });

  it("ignores the drop of a socket the screen already replaced (the old one's disconnect came late)", () => {
    const store = new LobbyStore(makeResolver(TAP_RACE));
    const { slug } = store.createLobby(Date.now(), 'local');
    const tv = store.joinScreen(slug, 'scr_tv', undefined, 'sock-old');
    store.joinScreen(slug, 'scr_tv', tv.screenToken, 'sock-new');
    expect(store.markScreenLeft(slug, 'scr_tv', 'sock-old', 1_000)).toBe(false);
    expect(store.dropGoneScreens(slug, 1_000_000, 10)).toBe(false);
    expect(store.getLobby(slug).screens).toEqual(['scr_tv']);
    // A screen that was never listed or never had a socket isn't noted either.
    expect(store.markScreenLeft(slug, 'scr_other', 'sock-new', 1_000)).toBe(false);
  });

  it('drops a screen whose socket has been gone for the grace period, and lets it come back', () => {
    const store = new LobbyStore(makeResolver(TAP_RACE));
    const { slug } = store.createLobby(Date.now(), 'remote');
    const a = store.joinScreen(slug, 'scr_a', undefined, 'sock-a');
    store.joinScreen(slug, 'scr_b', undefined, 'sock-b');
    store.joinPlayer(slug, 'Alex', undefined, 'scr_a');
    store.markScreenLeft(slug, 'scr_a', 'sock-a', 1_000);
    // Within the grace it keeps its place (and the host role).
    expect(store.dropGoneScreens(slug, 10_999, 10_000)).toBe(false);
    expect(store.publicLobby(slug).hostScreenId).toBe('scr_a');
    expect(store.dropGoneScreens(slug, 11_000, 10_000)).toBe(true);
    expect(store.getLobby(slug).screens).toEqual(['scr_b']);
    expect(store.getLobby(slug).screenPresence.scr_a).toBeUndefined();
    expect(store.publicLobby(slug).hostScreenId).toBe('scr_b');
    // Nothing about presence is public.
    expect(JSON.stringify(store.publicLobby(slug))).not.toContain('sock-');

    // The binding stays: only the same TV can take the seat back.
    expect(() => store.joinScreen(slug, 'scr_a', undefined, 'sock-x')).toThrow(/anderen Gerät/);
    expect(store.joinScreen(slug, 'scr_a', a.screenToken, 'sock-a2').changed).toBe(true);
    expect(store.publicLobby(slug).hostScreenId).toBe('scr_a');
  });

  it('forgets the oldest bindings of screens that left, so throwaway ids cannot lock new TVs out', () => {
    const store = new LobbyStore(makeResolver(TAP_RACE));
    const { slug } = store.createLobby(Date.now(), 'remote');
    const tv = store.joinScreen(slug, 'scr_tv', undefined, 'sock-tv', 1);
    // Alex sat at a TV that left: its id is still his seat.
    const seat = store.joinScreen(slug, 'scr_seat', undefined, 'sock-seat', 2);
    store.joinPlayer(slug, 'Alex', undefined, 'scr_seat');
    store.removeScreen(slug, 'scr_seat');

    // 40 throwaway ids join and leave (one after another, newest last).
    for (let i = 0; i < 40; i++) {
      store.joinScreen(slug, `scr_junk${i}`, undefined, `sock-junk${i}`, 10 + i);
      store.removeScreen(slug, `scr_junk${i}`);
    }
    const fresh = store.joinScreen(slug, 'scr_new', undefined, 'sock-new', 100);
    expect(typeof fresh.screenToken).toBe('string');
    const secrets = store.getLobby(slug).screenSecrets;
    expect(Object.keys(secrets).length).toBeLessThanOrEqual(32);
    expect(secrets.scr_junk0).toBeUndefined();
    expect(secrets.scr_junk39).toBeDefined();
    expect(store.getLobby(slug).screens).toEqual(['scr_tv', 'scr_new']);

    // Listed screens and seats keep their binding.
    expect(() => store.joinScreen(slug, 'scr_tv', undefined)).toThrow(/anderen Gerät/);
    expect(() => store.joinScreen(slug, 'scr_seat', undefined)).toThrow(/anderen Gerät/);
    expect(store.joinScreen(slug, 'scr_tv', tv.screenToken).screenId).toBe('scr_tv');
    expect(store.joinScreen(slug, 'scr_seat', seat.screenToken).screenId).toBe('scr_seat');

    // A forgotten TV that comes back is simply bound anew.
    const back = store.joinScreen(slug, 'scr_junk0', 'its-old-token', 'sock-back');
    expect(typeof back.screenToken).toBe('string');
  });

  it('reads screen bindings stored as a bare hash (before bind times were kept)', () => {
    const store = new LobbyStore(makeResolver(TAP_RACE));
    const { slug } = store.createLobby(Date.now(), 'remote');
    const tv = store.joinScreen(slug, 'scr_tv', undefined);
    const serialized = serializeLobbyRecord(store.getLobby(slug));
    const legacy = {
      ...serialized,
      screenSecrets: { scr_tv: (serialized.screenSecrets!.scr_tv as { hash: string }).hash },
      screenPresence: undefined
    };
    const restored = deserializeLobbyRecord(legacy);
    expect(restored.screenSecrets.scr_tv).toEqual({ hash: legacy.screenSecrets.scr_tv, at: 0 });
    expect(restored.screenPresence).toEqual({});
    store.lobbies.set(slug, restored);
    expect(store.joinScreen(slug, 'scr_tv', tv.screenToken).screenId).toBe('scr_tv');
    expect(() => store.joinScreen(slug, 'scr_tv', 'wrong')).toThrow(/anderen Gerät/);
  });
});
