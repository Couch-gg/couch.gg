import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSimulator, type Simulator, type SimulatorCore } from '../src/simulator';
import { checkControllerPatch, type CouchInputEnvelope, type CouchManifest, type CouchPlayer } from '../src/protocol';

// The simulator driven directly over a recording core, so each test sees the
// exact input stream a game would get.

const manifest: CouchManifest = {
  id: 'sim-test',
  title: 'Sim Test',
  description: 'simulator tests',
  minPlayers: 1,
  maxPlayers: 8,
  aspectRatio: '16:9',
  estimatedDurationMinutes: 3,
  controllerLayout: {
    kind: 'generic-buttons',
    controls: [
      { control: 'tap', type: 'button', label: 'Tap' },
      { control: 'charge', type: 'hold', label: 'Charge' },
      { control: 'move', type: 'dpad', label: 'Move' }
    ]
  }
};

interface Recorder {
  core: SimulatorCore;
  inputs: CouchInputEnvelope[];
  seed: () => string;
}

function recordingCore(): Recorder {
  let players: CouchPlayer[] = [];
  let seed = 'dev-start';
  const inputs: CouchInputEnvelope[] = [];
  const core: SimulatorCore = {
    get players() {
      return players;
    },
    get seed() {
      return seed;
    },
    setSeed: (next) => {
      seed = next;
    },
    dispatchInput: (input) => inputs.push(input),
    seedPlayers: (next) => {
      players = next;
    },
    addPlayer: (player) => {
      players = [...players, player];
    },
    removePlayer: (id) => {
      players = players.filter((p) => p.id !== id);
    },
    pause: () => {},
    resume: () => {}
  };
  return { core, inputs, seed: () => seed };
}

const actions = (inputs: CouchInputEnvelope[]) => inputs.map((i) => `${i.control}:${i.action}`);
const fire = (el: Element, type: string) => el.dispatchEvent(new Event(type, { bubbles: true }));
const key = (type: 'keydown' | 'keyup', code: string, repeat = false) =>
  window.dispatchEvent(new KeyboardEvent(type, { code, repeat }));
const pad = (playerId: string, control: string) =>
  document.querySelector<HTMLButtonElement>(`[data-player-id="${playerId}"] button[data-control="${control}"]`)!;

let rec: Recorder;
let sim: Simulator;

beforeEach(() => {
  vi.useFakeTimers();
  rec = recordingCore();
  sim = createSimulator({ manifest, core: rec.core });
});

afterEach(() => {
  sim.destroy();
  document.getElementById('couch-sim-style')?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('dev simulator pads', () => {
  it('a button releases only what it pressed, also on pointercancel', () => {
    const btn = pad('sim-p1', 'tap');
    fire(btn, 'pointerleave'); // hovering past it
    expect(rec.inputs).toEqual([]);

    fire(btn, 'pointerdown');
    fire(btn, 'pointerleave');
    fire(btn, 'pointerup');
    fire(btn, 'pointerdown');
    fire(btn, 'pointercancel');
    expect(actions(rec.inputs)).toEqual(['tap:press', 'tap:release', 'tap:press', 'tap:release']);
    expect(rec.inputs.every((i) => i.value === undefined)).toBe(true);
  });

  it('a hold ramps progress to 1 over 1500 ms, like the phone', () => {
    const hold = pad('sim-p1', 'charge');
    fire(hold, 'pointerdown');
    vi.advanceTimersByTime(720);
    const ticks = rec.inputs.filter((i) => i.action === 'change');
    expect(ticks).toHaveLength(6);
    expect((ticks.at(-1)!.value as { progress: number }).progress).toBeCloseTo(720 / 1500, 5);
    vi.advanceTimersByTime(840); // 1560 ms
    expect((rec.inputs.at(-1)!.value as { progress: number }).progress).toBe(1);
    fire(hold, 'pointerup');
    expect(rec.inputs.at(-1)).toMatchObject({ action: 'release', value: { heldMs: 1560 } });
  });

  it('the keyboard holds a hold control like the pad: press, progress ticks, release with heldMs', () => {
    key('keydown', 'Space');
    key('keydown', 'Space', true); // auto-repeat
    vi.advanceTimersByTime(360);
    key('keyup', 'Space');
    expect(actions(rec.inputs)).toEqual(['charge:press', 'charge:change', 'charge:change', 'charge:change', 'charge:release']);
    expect(rec.inputs[1].value).toEqual({ progress: 120 / 1500 });
    expect(rec.inputs.at(-1)!.value).toEqual({ heldMs: 360 });

    // Digit2 is the second button/hold control: the same hold.
    key('keydown', 'Digit2');
    vi.advanceTimersByTime(130);
    key('keyup', 'Digit2');
    expect(actions(rec.inputs.slice(5))).toEqual(['charge:press', 'charge:change', 'charge:release']);
    expect(rec.inputs.at(-1)!.value).toEqual({ heldMs: 130 });
  });

  it('keyboard and pointer share one control: no double press, the presser releases', () => {
    const btn = pad('sim-p1', 'tap');
    key('keydown', 'Digit1');
    fire(btn, 'pointerdown');
    fire(btn, 'pointerleave');
    fire(btn, 'pointerup');
    key('keyup', 'Digit1');
    expect(actions(rec.inputs)).toEqual(['tap:press', 'tap:release']);
  });

  it('a key let go while the window had no focus does not stay held', () => {
    key('keydown', 'Space');
    key('keydown', 'KeyW');
    vi.advanceTimersByTime(240);
    window.dispatchEvent(new Event('blur')); // the keyups go to DevTools
    expect(actions(rec.inputs)).toEqual([
      'charge:press', 'move:change', 'charge:change', 'charge:change', 'charge:release', 'move:release'
    ]);
    expect(rec.inputs[4].value).toEqual({ heldMs: 240 });
    expect(rec.inputs[5].value).toEqual({ dir: 'none' });
    vi.advanceTimersByTime(1_000);
    expect(rec.inputs).toHaveLength(6);

    // The pad works again; the key still down repeats without pressing, and
    // its late keyup does not release the pad's press.
    fire(pad('sim-p1', 'charge'), 'pointerdown');
    key('keydown', 'Space', true);
    key('keyup', 'Space');
    key('keyup', 'KeyW');
    expect(actions(rec.inputs.slice(6))).toEqual(['charge:press']);
    fire(pad('sim-p1', 'charge'), 'pointerup');
    expect(actions(rec.inputs.slice(6))).toEqual(['charge:press', 'charge:release']);

    // A fresh key press after that works as before.
    key('keydown', 'Space');
    key('keyup', 'Space');
    expect(actions(rec.inputs.slice(8))).toEqual(['charge:press', 'charge:release']);
  });

  it('a hidden page lets go of what is held, pads included', () => {
    fire(pad('sim-p2', 'charge'), 'pointerdown');
    key('keydown', 'Digit1');
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    visibility.mockRestore();
    expect(actions(rec.inputs)).toEqual(['charge:press', 'tap:press', 'charge:release', 'tap:release']);
    vi.advanceTimersByTime(1_000);
    fire(pad('sim-p2', 'charge'), 'pointerup');
    key('keyup', 'Digit1');
    expect(rec.inputs).toHaveLength(4);
  });

  it('stops listening for blur when destroyed', () => {
    key('keydown', 'Space');
    sim.destroy();
    const before = rec.inputs.length;
    window.dispatchEvent(new Event('blur'));
    expect(rec.inputs).toHaveLength(before);
  });

  it('a removed player stops sending hold ticks', () => {
    const add = [...document.querySelectorAll<HTMLButtonElement>('.couch-sim-btn')].find((b) =>
      b.textContent?.includes('Add player')
    )!;
    fire(add, 'click');
    fire(pad('sim-p3', 'charge'), 'pointerdown');
    const remove = [...document.querySelectorAll<HTMLButtonElement>('.couch-sim-btn')].find((b) =>
      b.textContent?.includes('Remove player')
    )!;
    fire(remove, 'click');
    const before = rec.inputs.length;
    vi.advanceTimersByTime(1_000);
    expect(rec.inputs.length).toBe(before);
  });
});

describe('dev simulator setController', () => {
  it('rejects the whole patch the platform would reject, with the reason in the console', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    sim.setController('sim-p1', { labels: { tap: 'SHIELD', nope: 'X' } });
    sim.setController('sim-p1', { labels: { tap: 'A'.repeat(17) } });
    sim.setController('sim-p1', { cooldowns: { tap: 120_000 } });
    sim.setController('sim-p1', { disabled: ['tap'], vibrate: [] });
    sim.setController('nobody', { labels: { tap: 'X' } });
    expect(error).toHaveBeenCalledTimes(5);
    expect(String(error.mock.calls[0][0])).toContain('unknown control "nope"');
    expect(String(error.mock.calls[4][0])).toContain('no player "nobody"');

    // Nothing of any rejected patch was applied.
    expect(pad('sim-p1', 'tap').textContent).toBe('Tap');
    expect(pad('sim-p1', 'tap').disabled).toBe(false);
    fire(pad('sim-p1', 'tap'), 'pointerdown');
    expect(actions(rec.inputs)).toEqual(['tap:press']);
  });

  it('releases a held control the moment it gets disabled, like the phone', () => {
    fire(pad('sim-p1', 'charge'), 'pointerdown');
    fire(pad('sim-p2', 'charge'), 'pointerdown');
    vi.advanceTimersByTime(130);
    sim.setController('sim-p1', { disabled: ['charge'] });
    const p1 = () => rec.inputs.filter((i) => i.playerId === 'sim-p1');
    expect(actions(p1())).toEqual(['charge:press', 'charge:change', 'charge:release']);
    expect(p1().at(-1)!.value).toEqual({ heldMs: 130 });

    // No more ticks, and the pointer coming up sends nothing more.
    vi.advanceTimersByTime(1_000);
    fire(pad('sim-p1', 'charge'), 'pointerup');
    expect(p1()).toHaveLength(3);
    // Another player's hold of the same control is not theirs to lose.
    expect(rec.inputs.filter((i) => i.playerId === 'sim-p2').at(-1)!.action).toBe('change');
  });

  it('releases a key-held control when its cooldown starts; the key must come up to press again', () => {
    key('keydown', 'Digit1');
    vi.advanceTimersByTime(50);
    sim.setController('sim-p1', { cooldowns: { tap: 500 } });
    expect(actions(rec.inputs)).toEqual(['tap:press', 'tap:release']);

    // Still held through the cooldown: auto-repeat presses nothing, not even after it ends.
    key('keydown', 'Digit1', true);
    vi.advanceTimersByTime(600);
    key('keydown', 'Digit1', true);
    key('keyup', 'Digit1');
    expect(rec.inputs).toHaveLength(2);

    key('keydown', 'Digit1');
    key('keyup', 'Digit1');
    expect(actions(rec.inputs.slice(2))).toEqual(['tap:press', 'tap:release']);
  });

  it('applies a valid patch as the server stores it (trimmed labels)', () => {
    sim.setController('sim-p2', { labels: { tap: '  SHIELD ' }, disabled: ['charge'] });
    expect(pad('sim-p2', 'tap').textContent).toBe('SHIELD');
    expect(pad('sim-p2', 'charge').disabled).toBe(true);
    expect(pad('sim-p1', 'tap').textContent).toBe('Tap');
  });
});

describe('dev simulator seed box', () => {
  it('sets couch.seed on commit, not per keystroke, and says what it did', () => {
    const input = document.querySelector<HTMLInputElement>('.couch-sim-seed-input')!;
    expect(input.value).toBe('dev-start');
    input.value = 'abc';
    fire(input, 'input');
    expect(rec.seed()).toBe('dev-start');

    fire(input, 'change');
    expect(rec.seed()).toBe('abc');
    expect(document.querySelector('.couch-sim-hint')!.textContent).toContain('next read');

    input.value = '   ';
    fire(input, 'change');
    expect(rec.seed()).toBe('abc');
    expect(input.value).toBe('abc');
  });
});

describe('checkControllerPatch (mirrors the server rules)', () => {
  const controls = ['tap', 'charge'];

  it('accepts and normalises a valid patch', () => {
    const result = checkControllerPatch(
      { labels: { tap: ' FIRE ' }, disabled: ['charge', 'charge'], cooldowns: { tap: 2999.6 }, vibrate: 80.4 },
      controls
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect({ ...result.patch.labels }).toEqual({ tap: 'FIRE' });
    expect(result.patch.disabled).toEqual(['charge']);
    expect({ ...result.patch.cooldowns }).toEqual({ tap: 3000 });
    expect(result.patch.vibrate).toEqual([80]);
  });

  it.each([
    ['not an object', null],
    ['an array', []],
    ['unknown label control', { labels: { nope: 'X' } }],
    ['inherited control name', { labels: { constructor: 'X' } }],
    ['empty label', { labels: { tap: '  ' } }],
    ['17-char label', { labels: { tap: 'A'.repeat(17) } }],
    ['disabled not a list', { disabled: 'tap' }],
    ['disabled unknown', { disabled: ['nope'] }],
    ['cooldown over 60 s', { cooldowns: { tap: 60_001 } }],
    ['negative cooldown', { cooldowns: { tap: -1 } }],
    ['cooldown not a number', { cooldowns: { tap: '100' } }],
    ['empty vibrate', { vibrate: [] }],
    ['11 vibrate steps', { vibrate: new Array(11).fill(10) }],
    ['vibrate step over 1 s', { vibrate: [1001] }]
  ])('rejects %s', (_name, patch) => {
    expect(checkControllerPatch(patch, controls).ok).toBe(false);
  });
});
