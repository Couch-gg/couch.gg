import { describe, expect, it } from 'vitest';
import { TrebuchetEngine } from '../src/engine.js';

const roster = [
  { id: 'p1', name: 'Alex', colorIdx: 0 },
  { id: 'p2', name: 'Bea', colorIdx: 1 }
];

describe('TrebuchetEngine', () => {
  it('starts a real authoritative game snapshot', () => {
    const engine = new TrebuchetEngine({ rng: () => 0.2, now: () => 1_000 });
    const event = engine.start(roster);
    expect(event.snapshot.phase).toBe('running');
    expect(event.snapshot.units).toHaveLength(2);
    expect(event.snapshot.heights).toHaveLength(480);
    expect(event.snapshot.castles).toHaveLength(2);
    expect(event.snapshot.turnEndsAt).toBe(61_000);
  });

  it('accepts only the current player fire event and advances the turn', () => {
    const engine = new TrebuchetEngine({ rng: () => 0, now: () => 2_000 });
    const start = engine.start(roster);
    const current = start.snapshot.turn!;
    const other = roster.find((player) => player.id !== current)!.id;

    expect(engine.fire(other, 60, 80)).toBeNull();
    const shot = engine.fire(current, 60, 80);

    expect(shot).not.toBeNull();
    expect(shot?.type).toBe('shot');
    expect(shot?.snapshot.turn).toBe(other);
    expect(shot?.snapshot.phase).toMatch(/running|finished/);
    expect(shot?.trajectory.length).toBeGreaterThan(1);
  });
});
