import type { PlayerId } from '@couch/types';
import {
  buildCastles,
  generateTerrain,
  placePlayers,
  simulateShot,
  applyCrater,
  settlePlayers,
  resolveCastleDamage,
  clampElevation
} from './sim.js';
import {
  PLAYER_HP,
  POWER_MAX,
  POWER_MIN,
  TURN_MS,
  WIND_MAX
} from './constants.js';

export interface TrebuchetRosterPlayer {
  id: PlayerId;
  name: string;
  colorIdx: number;
}

export interface TrebuchetUnit {
  id: PlayerId;
  name: string;
  colorIdx: number;
  x: number;
  y: number;
  hp: number;
  alive: boolean;
}

export interface CastleBlock {
  x: number;
  y: number;
  w: number;
  h: number;
  destroyed?: boolean;
}

export interface TrebuchetCastle {
  id: PlayerId | null;
  blocks: CastleBlock[];
}

export interface TrebuchetSnapshot {
  phase: 'ready' | 'running' | 'finished';
  seed: number;
  heights: number[];
  units: TrebuchetUnit[];
  castles: TrebuchetCastle[];
  order: PlayerId[];
  turn: PlayerId | null;
  wind: number;
  turnEndsAt: number | null;
  winner: PlayerId | null;
  draw: boolean;
}

export interface TrebuchetShotEvent {
  type: 'shot';
  shooterId: PlayerId;
  angle: number;
  power: number;
  wind: number;
  trajectory: Array<[number, number]>;
  result: {
    impact: { x: number; y: number } | null;
    crater: { x: number; y: number; r: number } | null;
    hits: Array<{ id: PlayerId; dmg: number; hp: number }>;
    castleHits: Array<{ id: PlayerId; dmg: number; hp: number; blocks: number[] }>;
    deaths: PlayerId[];
    settled: Array<{ id: PlayerId; y: number }>;
    plunge?: number;
  };
  next: { turn: PlayerId | null; wind: number; turnEndsAt: number } | null;
  winner: PlayerId | null;
  draw: boolean;
  snapshot: TrebuchetSnapshot;
}

export interface TrebuchetTurnEvent {
  type: 'turn';
  turn: PlayerId | null;
  wind: number;
  turnEndsAt: number;
  skipped: PlayerId | null;
  snapshot: TrebuchetSnapshot;
}

export interface TrebuchetStartEvent {
  type: 'start';
  snapshot: TrebuchetSnapshot;
}

export type TrebuchetEvent = TrebuchetStartEvent | TrebuchetShotEvent | TrebuchetTurnEvent;

interface EngineOptions {
  turnMs?: number;
  rng?: () => number;
  now?: () => number;
}

function clamp(value: unknown, lo: number, hi: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function rollWind(rng: () => number): number {
  const wind = (rng() * 2 - 1) * WIND_MAX;
  return Math.round(wind * 10) / 10;
}

export class TrebuchetEngine {
  private readonly turnMs: number;
  private readonly rng: () => number;
  private readonly now: () => number;
  private roster = new Map<PlayerId, TrebuchetRosterPlayer>();
  private units = new Map<PlayerId, TrebuchetUnit>();
  private heights = new Float64Array();
  private castles: TrebuchetCastle[] = [];
  private order: PlayerId[] = [];
  private phase: TrebuchetSnapshot['phase'] = 'ready';
  private seed = 0;
  private turn: PlayerId | null = null;
  private wind = 0;
  private turnEndsAt: number | null = null;
  private winner: PlayerId | null = null;
  private draw = false;

  constructor(options: EngineOptions = {}) {
    this.turnMs = options.turnMs ?? TURN_MS;
    this.rng = options.rng ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  static fromSnapshot(snapshot: TrebuchetSnapshot, options: EngineOptions = {}): TrebuchetEngine {
    const engine = new TrebuchetEngine(options);
    engine.roster = new Map(snapshot.units.map((unit) => [unit.id, { id: unit.id, name: unit.name, colorIdx: unit.colorIdx }]));
    engine.units = new Map(snapshot.units.map((unit) => [unit.id, { ...unit }]));
    engine.heights = Float64Array.from(snapshot.heights);
    engine.castles = snapshot.castles.map((castle) => ({
      id: castle.id,
      blocks: castle.blocks.map((block) => ({ ...block }))
    }));
    engine.order = snapshot.order.slice();
    engine.phase = snapshot.phase;
    engine.seed = snapshot.seed;
    engine.turn = snapshot.turn;
    engine.wind = snapshot.wind;
    engine.turnEndsAt = snapshot.turnEndsAt;
    engine.winner = snapshot.winner;
    engine.draw = snapshot.draw;
    return engine;
  }

  start(roster: TrebuchetRosterPlayer[]): TrebuchetStartEvent {
    this.roster = new Map(roster.map((player) => [player.id, player]));
    this.order = roster.map((player) => player.id);
    this.phase = 'running';
    this.winner = null;
    this.draw = false;
    this.seed = (this.rng() * 2 ** 31) | 0;
    this.heights = generateTerrain(this.seed);
    const positions = placePlayers(this.heights, this.order.length, this.seed);
    this.units.clear();

    for (let i = 0; i < this.order.length; i++) {
      const id = this.order[i];
      const rosterPlayer = this.roster.get(id);
      const pos = positions[i] ?? { x: 0, y: 0 };
      this.units.set(id, {
        id,
        name: rosterPlayer?.name ?? 'Player',
        colorIdx: rosterPlayer?.colorIdx ?? i,
        x: pos.x,
        y: pos.y,
        hp: PLAYER_HP,
        alive: true
      });
    }

    this.castles = buildCastles(
      this.heights,
      positions.map((pos, index) => ({ ...pos, id: this.order[index] }))
    );
    this.turn = this.order[(this.rng() * this.order.length) | 0] ?? this.order[0] ?? null;
    this.wind = rollWind(this.rng);
    this.turnEndsAt = this.now() + this.turnMs;
    return { type: 'start', snapshot: this.snapshot() };
  }

  rematch(roster: TrebuchetRosterPlayer[]): TrebuchetStartEvent {
    return this.start(roster);
  }

  fire(shooterId: PlayerId, rawAngle: unknown, rawPower: unknown): TrebuchetShotEvent | null {
    if (this.phase !== 'running') return null;
    if (shooterId !== this.turn) return null;
    const shooter = this.units.get(shooterId);
    if (!shooter?.alive) return null;

    const angle = clampElevation(rawAngle);
    const power = clamp(rawPower, POWER_MIN, POWER_MAX);
    const firedWind = this.wind;

    const simResult = simulateShot({
      shooterId,
      x: shooter.x,
      y: shooter.y,
      angle,
      power,
      wind: firedWind,
      heights: this.heights,
      players: this.simPlayers(),
      castles: this.castles
    });

    const trajectory = Array.isArray(simResult.trajectory) ? simResult.trajectory : [];
    const impact = simResult.impact ?? null;
    const crater = simResult.crater ?? null;
    const rawHits = Array.isArray(simResult.hits) ? simResult.hits : [];
    const plunge = typeof simResult.plunge === 'number' ? simResult.plunge : undefined;

    if (crater) {
      applyCrater(this.heights, crater);
    }

    const castleResult = resolveCastleDamage(this.castles, impact, this.heights);
    const rawCastleHits = Array.isArray(castleResult.castleHits) ? castleResult.castleHits : [];
    const blastDmg = new Map<PlayerId, number>();
    const castleDmg = new Map<PlayerId, number>();

    for (const hit of rawHits) {
      const unit = this.units.get(hit.id);
      if (!unit?.alive) continue;
      const dmg = Math.max(0, Math.round(Number(hit.dmg) || 0));
      blastDmg.set(hit.id, (blastDmg.get(hit.id) ?? 0) + dmg);
    }

    for (const hit of rawCastleHits) {
      if (hit.id == null) continue;
      const id = String(hit.id);
      const dmg = Math.max(0, Math.round(Number(hit.dmg) || 0));
      castleDmg.set(id, (castleDmg.get(id) ?? 0) + dmg);
    }

    const deaths: PlayerId[] = [];
    const finalHp = new Map<PlayerId, number>();
    const affected = new Set<PlayerId>([...blastDmg.keys(), ...castleDmg.keys()]);

    for (const id of affected) {
      const unit = this.units.get(id);
      if (!unit?.alive) continue;
      const total = (blastDmg.get(id) ?? 0) + (castleDmg.get(id) ?? 0);
      unit.hp = Math.max(0, unit.hp - total);
      unit.alive = unit.hp > 0;
      finalHp.set(id, unit.hp);
      if (!unit.alive) deaths.push(id);
    }

    const hpFor = (id: PlayerId) => finalHp.get(id) ?? this.units.get(id)?.hp ?? 0;
    const hits = rawHits
      .filter((hit) => blastDmg.has(hit.id))
      .map((hit) => ({ id: hit.id, dmg: Math.max(0, Math.round(Number(hit.dmg) || 0)), hp: hpFor(hit.id) }));

    const castleHits = rawCastleHits
      .filter((hit) => hit.id != null)
      .map((hit) => {
        const id = String(hit.id);
        return {
          id,
          dmg: Math.max(0, Math.round(Number(hit.dmg) || 0)),
          hp: hpFor(id),
          blocks: Array.isArray(hit.blocks) ? hit.blocks.slice() : []
        };
      });

    const settled = settlePlayers(this.heights, this.simPlayers()).map((move: { id: PlayerId; y: number }) => {
      const unit = this.units.get(move.id);
      if (unit) unit.y = move.y;
      return { id: move.id, y: move.y };
    });

    const alive = this.aliveIds();
    let next: TrebuchetShotEvent['next'] = null;
    this.winner = null;
    this.draw = false;

    if (alive.length <= 1) {
      this.phase = 'finished';
      this.turn = null;
      this.turnEndsAt = null;
      this.winner = alive[0] ?? null;
      this.draw = alive.length === 0;
    } else {
      this.turn = this.nextAliveAfter(shooterId);
      this.wind = rollWind(this.rng);
      this.turnEndsAt = this.now() + this.turnMs;
      next = { turn: this.turn, wind: this.wind, turnEndsAt: this.turnEndsAt };
    }

    const snapshot = this.snapshot();
    return {
      type: 'shot',
      shooterId,
      angle,
      power,
      wind: firedWind,
      trajectory,
      result: {
        impact,
        crater,
        hits,
        castleHits,
        deaths,
        settled,
        ...(plunge !== undefined ? { plunge } : {})
      },
      next,
      winner: this.winner,
      draw: this.draw,
      snapshot
    };
  }

  skipTurn(skipped: PlayerId | null = this.turn): TrebuchetTurnEvent | null {
    if (this.phase !== 'running') return null;
    const alive = this.aliveIds();
    if (alive.length <= 1) {
      this.phase = 'finished';
      this.turn = null;
      this.turnEndsAt = null;
      this.winner = alive[0] ?? null;
      this.draw = alive.length === 0;
      return null;
    }

    this.turn = this.nextAliveAfter(skipped);
    this.wind = rollWind(this.rng);
    this.turnEndsAt = this.now() + this.turnMs;
    return {
      type: 'turn',
      turn: this.turn,
      wind: this.wind,
      turnEndsAt: this.turnEndsAt,
      skipped,
      snapshot: this.snapshot()
    };
  }

  removePlayer(playerId: PlayerId): TrebuchetSnapshot {
    const unit = this.units.get(playerId);
    if (unit) {
      unit.alive = false;
      unit.hp = 0;
    }
    if (this.phase === 'running' && this.turn === playerId) {
      this.skipTurn(playerId);
    }
    const alive = this.aliveIds();
    if (this.phase === 'running' && alive.length <= 1) {
      this.phase = 'finished';
      this.turn = null;
      this.turnEndsAt = null;
      this.winner = alive[0] ?? null;
      this.draw = alive.length === 0;
    }
    return this.snapshot();
  }

  snapshot(): TrebuchetSnapshot {
    return {
      phase: this.phase,
      seed: this.seed,
      heights: Array.from(this.heights),
      units: this.order.map((id) => this.units.get(id)).filter((unit): unit is TrebuchetUnit => Boolean(unit)),
      castles: this.castles.map((castle) => ({
        id: castle.id,
        blocks: castle.blocks.map((block) => ({ ...block }))
      })),
      order: [...this.order],
      turn: this.turn,
      wind: this.wind,
      turnEndsAt: this.turnEndsAt,
      winner: this.winner,
      draw: this.draw
    };
  }

  private aliveIds(): PlayerId[] {
    return this.order.filter((id) => this.units.get(id)?.alive);
  }

  private nextAliveAfter(fromId: PlayerId | null): PlayerId | null {
    if (this.order.length === 0) return null;
    const start = fromId == null ? 0 : Math.max(0, this.order.indexOf(fromId) + 1);
    for (let step = 0; step < this.order.length; step++) {
      const id = this.order[(start + step) % this.order.length];
      if (this.units.get(id)?.alive) return id;
    }
    return null;
  }

  private simPlayers() {
    return this.order
      .map((id) => this.units.get(id))
      .filter((unit): unit is TrebuchetUnit => Boolean(unit))
      .map((unit) => ({ id: unit.id, x: unit.x, y: unit.y, hp: unit.hp, alive: unit.alive }));
  }
}
