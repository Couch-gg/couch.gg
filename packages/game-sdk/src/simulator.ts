/**
 * Dev simulator — the built-in overlay shown when a game runs standalone
 * (top-level, `mode: 'dev'`, or in an iframe no couch.gg host answers). Vanilla
 * DOM only; styles are injected via one inline <style> (no CSS imports, so it
 * works from file:// and inside LLM sandboxes). Every fake input is stamped with
 * an incrementing `seq` and dispatched through the SAME core funnel as live
 * `couch:input` messages, in the shapes the real phone sends.
 */

import {
  checkControllerPatch,
  type CouchControl,
  type CouchControllerPatch,
  type CouchInputEnvelope,
  type CouchManifest,
  type CouchPlayer,
  type CouchScore
} from './protocol';

/**
 * The slice of the SDK core the simulator drives. Mirrors the live message
 * handlers exactly, so simulated players behave like real ones.
 */
export interface SimulatorCore {
  readonly players: CouchPlayer[];
  readonly seed: string;
  setSeed(seed: string): void;
  dispatchInput(input: CouchInputEnvelope): void;
  /** Set the starting roster without a playersChanged, like couch:init. */
  seedPlayers(players: CouchPlayer[]): void;
  addPlayer(player: CouchPlayer): void;
  removePlayer(playerId: string): void;
  pause(reason: string): void;
  resume(): void;
}

export interface SimulatorOptions {
  manifest: CouchManifest;
  core: SimulatorCore;
}

export interface Simulator {
  /** Show a game-over toast with the reported scores. */
  showGameOver(scores: CouchScore[]): void;
  /** Apply a game's couch.setController patch to that player's fake phone. */
  setController(playerId: string, patch: CouchControllerPatch): void;
  /** Tear the overlay down (used by tests / hot reloads). */
  destroy(): void;
}

const STYLE_ID = 'couch-sim-style';
const ROOT_ID = 'couch-sim-root';

/** Names auto-assigned to fake players, in order. */
const FAKE_NAMES = ['Alex', 'Bea', 'Cyd', 'Dex', 'Eli', 'Fin', 'Gus', 'Hana'];
const MAX_PLAYERS = 8;
/** Progress emit cadence while a hold control is held down (ms). */
const HOLD_TICK_MS = 120;
/** A hold's `progress` reaches 1 after this long, as on the phone (ms). */
const HOLD_RAMP_MS = 1500;
/** Minimum gap between coalesced slider `change` emits (ms). */
const SLIDER_COALESCE_MS = 100;

/** Guard: are we in a DOM environment we can render into? */
function hasDom(): boolean {
  return typeof document !== 'undefined' && !!document.body;
}

export function createSimulator(opts: SimulatorOptions): Simulator {
  if (!hasDom()) {
    // No DOM (e.g. SSR / worker) — return an inert handle.
    return { showGameOver: () => {}, setController: () => {}, destroy: () => {} };
  }

  const { manifest, core } = opts;
  const controls: CouchControl[] = manifest.controllerLayout?.controls ?? [];

  let seq = 0;
  const nextSeq = (): number => (seq += 1);

  /** Emit an input through the shared core funnel, stamped with seq + timestamp. */
  // Per-player setController state, mirrored onto the fake phones. A disabled or
  // cooling-down control swallows presses/changes like the real phone does.
  const overrides = new Map<string, { labels: Record<string, string>; disabled: Set<string>; coolUntil: Map<string, number> }>();
  const overrideFor = (playerId: string) => {
    let entry = overrides.get(playerId);
    if (!entry) {
      entry = { labels: {}, disabled: new Set(), coolUntil: new Map() };
      overrides.set(playerId, entry);
    }
    return entry;
  };
  const isBlocked = (playerId: string, control: string): boolean => {
    const entry = overrides.get(playerId);
    if (!entry) return false;
    return entry.disabled.has(control) || (entry.coolUntil.get(control) ?? 0) > Date.now();
  };
  const labelFor = (playerId: string, control: CouchControl): string => {
    const labels = overrides.get(playerId)?.labels;
    const own = labels && Object.hasOwn(labels, control.control) ? labels[control.control] : undefined;
    return own ?? (control.label || control.control);
  };

  /** Returns false when a disabled or cooling-down control swallowed it. */
  const emitInput = (
    playerId: string,
    control: string,
    action: CouchInputEnvelope['action'],
    value?: unknown
  ): boolean => {
    if (action !== 'release' && isBlocked(playerId, control)) return false;
    core.dispatchInput({
      seq: nextSeq(),
      at: Date.now(),
      playerId,
      control,
      action,
      value
    });
    return true;
  };

  // Buttons and holds that are down, per player and control. The pointer and
  // the keyboard share this, so either one drives the control like a phone
  // does: one press, then (holds) a { progress } tick every HOLD_TICK_MS, then
  // one release ({ heldMs } for holds). A release without a press never happens.
  interface Held {
    playerId: string;
    control: CouchControl;
    since: number;
    ticker?: ReturnType<typeof setInterval>;
  }
  const held = new Map<string, Held>();
  const heldKey = (playerId: string, control: string): string => `${playerId}:${control}`;

  /** Returns the new press, or undefined when the control is held or blocked. */
  function pressControl(playerId: string, control: CouchControl): Held | undefined {
    const key = heldKey(playerId, control.control);
    if (held.has(key)) return undefined;
    if (!emitInput(playerId, control.control, 'press')) return undefined;
    const entry: Held = { playerId, control, since: Date.now() };
    if (control.type === 'hold') {
      entry.ticker = setInterval(() => {
        const progress = Math.min(1, (Date.now() - entry.since) / HOLD_RAMP_MS);
        emitInput(playerId, control.control, 'change', { progress });
      }, HOLD_TICK_MS);
    }
    held.set(key, entry);
    return entry;
  }

  // Ends this press. A no-op once something else let go of it first (the
  // control got disabled, the window lost focus), so a pad or key coming up
  // late never releases a newer press of the same control.
  function releaseHeld(entry: Held): void {
    const key = heldKey(entry.playerId, entry.control.control);
    if (held.get(key) !== entry) return;
    held.delete(key);
    if (entry.ticker !== undefined) clearInterval(entry.ticker);
    emitInput(
      entry.playerId,
      entry.control.control,
      'release',
      entry.control.type === 'hold' ? { heldMs: Date.now() - entry.since } : undefined
    );
  }

  // A player who leaves takes their phone along: stop its hold ticks quietly.
  function dropHeld(playerId: string): void {
    for (const [key, entry] of held) {
      if (entry.playerId !== playerId) continue;
      if (entry.ticker !== undefined) clearInterval(entry.ticker);
      held.delete(key);
    }
  }

  // ---- style injection (single inline <style>) --------------------------
  injectStyles();

  // ---- roster: seed 2 fake players -------------------------------------
  const makePlayer = (idx: number): CouchPlayer => ({
    id: `sim-p${idx + 1}`,
    name: FAKE_NAMES[idx] ?? `P${idx + 1}`,
    colorIdx: idx,
    connected: true
  });
  core.seedPlayers([makePlayer(0), makePlayer(1)]);

  // ---- root overlay -----------------------------------------------------
  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'couch-sim';

  const bar = document.createElement('div');
  bar.className = 'couch-sim-bar';

  const brand = document.createElement('span');
  brand.className = 'couch-sim-brand';
  brand.textContent = 'couch.gg dev sim';
  bar.appendChild(brand);

  const modeTag = document.createElement('span');
  modeTag.className = 'couch-sim-tag';
  modeTag.textContent = manifest.title || manifest.id || 'game';
  bar.appendChild(modeTag);

  const spacer = document.createElement('span');
  spacer.className = 'couch-sim-spacer';
  bar.appendChild(spacer);

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'couch-sim-btn couch-sim-toggle';
  toggleBtn.type = 'button';
  toggleBtn.textContent = 'Hide panel';
  bar.appendChild(toggleBtn);

  root.appendChild(bar);

  const panel = document.createElement('div');
  panel.className = 'couch-sim-panel';
  root.appendChild(panel);

  toggleBtn.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('is-collapsed');
    toggleBtn.textContent = collapsed ? 'Show panel' : 'Hide panel';
  });

  // ---- controls row (roster + seed + pause/resume) ----------------------
  const controlsRow = document.createElement('div');
  controlsRow.className = 'couch-sim-controls';
  panel.appendChild(controlsRow);

  const addBtn = document.createElement('button');
  addBtn.className = 'couch-sim-btn';
  addBtn.type = 'button';
  addBtn.textContent = '+ Add player';
  controlsRow.appendChild(addBtn);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'couch-sim-btn';
  removeBtn.type = 'button';
  removeBtn.textContent = '- Remove player';
  controlsRow.appendChild(removeBtn);

  const pauseBtn = document.createElement('button');
  pauseBtn.className = 'couch-sim-btn';
  pauseBtn.type = 'button';
  pauseBtn.textContent = 'Pause';
  controlsRow.appendChild(pauseBtn);

  const resumeBtn = document.createElement('button');
  resumeBtn.className = 'couch-sim-btn';
  resumeBtn.type = 'button';
  resumeBtn.textContent = 'Resume';
  controlsRow.appendChild(resumeBtn);

  const seedWrap = document.createElement('label');
  seedWrap.className = 'couch-sim-seed';
  const seedLabel = document.createElement('span');
  seedLabel.textContent = 'seed';
  const seedInput = document.createElement('input');
  seedInput.className = 'couch-sim-seed-input';
  seedInput.type = 'text';
  seedInput.value = core.seed;
  seedInput.title = "Enter sets couch.seed for the game's next read of it. Reload for a new random seed.";
  seedWrap.appendChild(seedLabel);
  seedWrap.appendChild(seedInput);
  controlsRow.appendChild(seedWrap);

  const seedHint = document.createElement('span');
  seedHint.className = 'couch-sim-hint';
  controlsRow.appendChild(seedHint);

  // ---- phones container -------------------------------------------------
  const phones = document.createElement('div');
  phones.className = 'couch-sim-phones';
  panel.appendChild(phones);

  // ---- game-over toast --------------------------------------------------
  const toast = document.createElement('div');
  toast.className = 'couch-sim-toast is-hidden';
  root.appendChild(toast);

  document.body.appendChild(root);

  // ---- wiring: roster buttons ------------------------------------------
  addBtn.addEventListener('click', () => {
    if (core.players.length >= MAX_PLAYERS) return;
    const idx = core.players.length;
    core.addPlayer(makePlayer(idx));
    renderPhones();
    syncRosterButtons();
  });

  removeBtn.addEventListener('click', () => {
    if (core.players.length <= 1) return;
    const last = core.players[core.players.length - 1];
    dropHeld(last.id);
    core.removePlayer(last.id);
    renderPhones();
    syncRosterButtons();
  });

  pauseBtn.addEventListener('click', () => core.pause('dev'));
  resumeBtn.addEventListener('click', () => core.resume());

  // On commit (Enter / blur), not per keystroke. couch.seed changes right
  // away, but a game that already seeded its PRNG only sees it when it reads
  // the seed again (e.g. on its next round).
  seedInput.addEventListener('change', () => {
    const seed = seedInput.value.trim();
    if (!seed) {
      seedInput.value = core.seed;
      return;
    }
    core.setSeed(seed);
    seedHint.textContent = `couch.seed is now "${seed}" for its next read`;
  });

  function syncRosterButtons(): void {
    addBtn.disabled = core.players.length >= MAX_PLAYERS;
    removeBtn.disabled = core.players.length <= 1;
  }

  // ---- fake phone rendering --------------------------------------------
  function renderPhones(): void {
    phones.textContent = '';
    for (let i = 0; i < core.players.length; i += 1) {
      phones.appendChild(renderPhone(core.players[i], i === 0));
    }
    paintOverrides();
  }

  function renderPhone(player: CouchPlayer, isPrimary: boolean): HTMLElement {
    const phone = document.createElement('div');
    phone.className = 'couch-sim-phone';
    phone.dataset.playerId = player.id;

    const head = document.createElement('div');
    head.className = 'couch-sim-phone-head';
    head.style.setProperty('--sim-color', paletteColor(player.colorIdx));
    head.textContent = player.name + (isPrimary ? '  (keyboard)' : '');
    phone.appendChild(head);

    const body = document.createElement('div');
    body.className = 'couch-sim-phone-body';
    phone.appendChild(body);

    if (controls.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'couch-sim-empty';
      empty.textContent = 'manifest declares no controls';
      body.appendChild(empty);
    }

    for (const control of controls) {
      body.appendChild(renderControl(player, control));
    }
    return phone;
  }

  function renderControl(player: CouchPlayer, control: CouchControl): HTMLElement {
    switch (control.type) {
      case 'button':
      case 'hold':
        return renderPressable(player, control, control.type);
      case 'slider':
        return renderSlider(player, control);
      case 'select':
        return renderSelect(player, control);
      case 'stick':
      case 'dpad':
        return renderDirectional(player, control);
      default:
        return renderPressable(player, control, 'button');
    }
  }

  // Button and hold pads differ only in what pressControl/releaseHeld send.
  // A control of a type this SDK doesn't know renders as a button.
  function renderPressable(player: CouchPlayer, control: CouchControl, kind: 'button' | 'hold'): HTMLElement {
    const btn = document.createElement('button');
    btn.className = `couch-sim-pad couch-sim-pad-${kind}`;
    btn.type = 'button';
    btn.textContent = labelFor(player.id, control);
    btn.dataset.control = control.control;
    btn.dataset.kind = kind;
    // Only a press that started on this pad may release it: sliding the mouse
    // over it, or off it while the keyboard holds the control, sends nothing.
    let pressed: Held | undefined;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pressed = pressControl(player.id, control) ?? pressed;
    });
    const up = (): void => {
      if (!pressed) return;
      const entry = pressed;
      pressed = undefined;
      releaseHeld(entry);
    };
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('pointerleave', up);
    return btn;
  }

  function renderSlider(player: CouchPlayer, control: CouchControl): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'couch-sim-pad couch-sim-pad-slider';
    const label = document.createElement('span');
    label.className = 'couch-sim-pad-label';
    label.textContent = control.label || control.control;
    wrap.appendChild(label);

    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(control.min ?? 0);
    range.max = String(control.max ?? 100);
    range.step = String(control.step ?? 1);
    range.value = String(control.min ?? 0);
    range.dataset.control = control.control;
    range.dataset.kind = 'slider';
    wrap.appendChild(range);

    let lastEmit = 0;
    const coalesced = (): void => {
      const now = Date.now();
      if (now - lastEmit < SLIDER_COALESCE_MS) return;
      lastEmit = now;
      emitInput(player.id, control.control, 'change', { value: Number(range.value) });
    };
    const final = (): void => {
      lastEmit = Date.now();
      emitInput(player.id, control.control, 'change', { value: Number(range.value) });
    };
    range.addEventListener('input', coalesced);
    range.addEventListener('change', final);
    range.addEventListener('pointerup', final);
    return wrap;
  }

  function renderSelect(player: CouchPlayer, control: CouchControl): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'couch-sim-pad couch-sim-pad-select';
    const label = document.createElement('span');
    label.className = 'couch-sim-pad-label';
    label.textContent = control.label || control.control;
    wrap.appendChild(label);

    const seg = document.createElement('div');
    seg.className = 'couch-sim-seg';
    wrap.appendChild(seg);

    const options = control.options ?? [];
    for (const option of options) {
      const optBtn = document.createElement('button');
      optBtn.className = 'couch-sim-seg-btn';
      optBtn.type = 'button';
      optBtn.textContent = option;
      optBtn.dataset.control = control.control;
      optBtn.dataset.value = option;
      optBtn.addEventListener('click', () => {
        for (const child of Array.from(seg.children)) child.classList.remove('is-active');
        optBtn.classList.add('is-active');
        emitInput(player.id, control.control, 'change', { value: option });
      });
      seg.appendChild(optBtn);
    }
    return wrap;
  }

  // Stick and d-pad share one 3x3 grid in the sim: each cell is a direction.
  // A d-pad sends { dir }; a stick sends the matching full-tilt { x, y }.
  function emitDirection(pid: string, control: CouchControl, dir: string): void {
    if (dir === 'none') {
      emitInput(pid, control.control, 'release', control.type === 'stick' ? { x: 0, y: 0 } : { dir: 'none' });
      return;
    }
    if (control.type === 'dpad') {
      emitInput(pid, control.control, 'change', { dir });
      return;
    }
    const x = dir.includes('right') ? 1 : dir.includes('left') ? -1 : 0;
    const y = dir.includes('up') ? 1 : dir.includes('down') ? -1 : 0;
    const len = Math.hypot(x, y) || 1;
    emitInput(pid, control.control, 'change', {
      x: Math.round((x / len) * 100) / 100,
      y: Math.round((y / len) * 100) / 100
    });
  }

  function renderDirectional(player: CouchPlayer, control: CouchControl): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'couch-sim-pad couch-sim-pad-select';
    const label = document.createElement('span');
    label.className = 'couch-sim-pad-label';
    label.textContent = (control.label || control.control) + (control.type === 'stick' ? ' (stick)' : '');
    wrap.appendChild(label);
    const grid = document.createElement('div');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(3, 1fr)';
    grid.style.gap = '3px';
    const cells = ['up-left', 'up', 'up-right', 'left', '', 'right', 'down-left', 'down', 'down-right'];
    const arrows: Record<string, string> = {
      'up-left': '↖', up: '↑', 'up-right': '↗', left: '←', right: '→', 'down-left': '↙', down: '↓', 'down-right': '↘'
    };
    for (const dir of cells) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'couch-sim-seg-btn';
      cell.textContent = dir ? arrows[dir] : '·';
      cell.dataset.control = control.control;
      cell.dataset.dir = dir || 'none';
      if (dir) {
        let down = false;
        cell.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          down = true;
          emitDirection(player.id, control, dir);
        });
        const up = (): void => {
          if (!down) return;
          down = false;
          emitDirection(player.id, control, 'none');
        };
        cell.addEventListener('pointerup', up);
        cell.addEventListener('pointerleave', up);
      }
      grid.appendChild(cell);
    }
    wrap.appendChild(grid);
    return wrap;
  }

  // ---- keyboard bindings (player 1) ------------------------------------
  // The press each held key started (Digit1..9, Space).
  const keyState = new Map<string, Held>();
  const buttonControls = (): CouchControl[] =>
    controls.filter((c) => c.type === 'button' || c.type === 'hold');
  const firstSlider = (): CouchControl | undefined =>
    controls.find((c) => c.type === 'slider');
  const firstHold = (): CouchControl | undefined => controls.find((c) => c.type === 'hold');

  const primaryId = (): string | undefined => core.players[0]?.id;
  const firstDirectional = (): CouchControl | undefined =>
    controls.find((c) => c.type === 'stick' || c.type === 'dpad');
  const WASD: Record<string, string> = { KeyW: 'up', KeyA: 'left', KeyS: 'down', KeyD: 'right' };
  const heldDirs = new Set<string>();
  // Combine the held WASD keys into one of the 8 directions (or 'none').
  function wasdDirection(): string {
    const v = (heldDirs.has('up') ? 'up' : heldDirs.has('down') ? 'down' : '');
    const h = (heldDirs.has('left') ? 'left' : heldDirs.has('right') ? 'right' : '');
    return v && h ? `${v}-${h}` : v || h || 'none';
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    const pid = primaryId();
    if (!pid) return;
    const wasd = WASD[e.code];
    const directional = firstDirectional();
    if (wasd && directional) {
      if (e.repeat || heldDirs.has(wasd)) return;
      heldDirs.add(wasd);
      emitDirection(pid, directional, wasdDirection());
      return;
    }
    // Digit1..9 -> nth button/hold control, pressed like its pad. Auto-repeat
    // never presses: a key still down after a forced release (the control got
    // disabled, the window lost focus) must come up first, like a finger.
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) {
      const n = Number(digit[1]) - 1;
      const btns = buttonControls();
      const control = btns[n];
      if (!control || e.repeat || keyState.has(e.code)) return;
      const entry = pressControl(pid, control);
      if (entry) keyState.set(e.code, entry);
      return;
    }
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      const slider = firstSlider();
      if (slider) {
        e.preventDefault();
        adjustSlider(pid, slider, e.code === 'ArrowUp' ? 1 : -1);
      }
      return;
    }
    if (e.code === 'Space') {
      const hold = firstHold();
      if (hold && !e.repeat && !keyState.has('Space')) {
        e.preventDefault();
        const entry = pressControl(pid, hold);
        if (entry) keyState.set('Space', entry);
      }
    }
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    const pid = primaryId();
    if (!pid) return;
    const wasd = WASD[e.code];
    const directional = firstDirectional();
    if (wasd && directional && heldDirs.has(wasd)) {
      heldDirs.delete(wasd);
      emitDirection(pid, directional, wasdDirection());
      return;
    }
    const entry = keyState.get(e.code);
    if (entry) {
      keyState.delete(e.code);
      releaseHeld(entry);
    }
  };

  // Let go of a press the player did not end (see setController), and forget
  // the key that made it so its keyup sends nothing.
  function forceRelease(entry: Held): void {
    releaseHeld(entry);
    for (const [code, pressedBy] of keyState) if (pressedBy === entry) keyState.delete(code);
  }

  // The phone lets go of every held control when it is locked, backgrounded or
  // loses focus. Here a key let go while DevTools or another window has focus
  // never sends its keyup, so the hold would tick on and its pad stay dead.
  function releaseAll(): void {
    for (const entry of [...held.values()]) releaseHeld(entry);
    keyState.clear();
    if (heldDirs.size === 0) return;
    heldDirs.clear();
    const pid = primaryId();
    const directional = firstDirectional();
    if (pid && directional) emitDirection(pid, directional, 'none');
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') releaseAll();
  };

  // Track slider value per keyboard nudge.
  const sliderValues = new Map<string, number>();
  function adjustSlider(pid: string, slider: CouchControl, dir: number): void {
    const min = slider.min ?? 0;
    const max = slider.max ?? 100;
    const step = slider.step ?? 1;
    const current = sliderValues.get(slider.control) ?? min;
    const next = Math.max(min, Math.min(max, current + dir * step));
    sliderValues.set(slider.control, next);
    emitInput(pid, slider.control, 'change', { value: next });
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', onVisibility);

  // ---- initial paint ----------------------------------------------------
  renderPhones();
  syncRosterButtons();

  // ---- toast handling ---------------------------------------------------
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function showGameOver(scores: CouchScore[]): void {
    toast.textContent = '';
    const title = document.createElement('div');
    title.className = 'couch-sim-toast-title';
    title.textContent = 'Game over';
    toast.appendChild(title);

    const byId = new Map(core.players.map((p) => [p.id, p.name]));
    const list = document.createElement('div');
    list.className = 'couch-sim-toast-list';
    const sorted = [...scores].sort((a, b) => b.score - a.score);
    for (const s of sorted) {
      const row = document.createElement('div');
      row.className = 'couch-sim-toast-row';
      row.textContent = `${byId.get(s.playerId) ?? s.playerId}: ${s.score}`;
      list.appendChild(row);
    }
    toast.appendChild(list);
    toast.classList.remove('is-hidden');
    if (toastTimer !== undefined) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('is-hidden'), 6000);
  }

  // Checked like the platform checks it, so a patch a live couch would reject
  // fails here too, with the reason in the console, instead of only on a TV.
  function setController(playerId: string, raw: CouchControllerPatch): void {
    if (!core.players.some((p) => p.id === playerId)) {
      // eslint-disable-next-line no-console
      console.error(`[couch] setController rejected: no player "${playerId}". Use an id from couch.players.`);
      return;
    }
    const checked = checkControllerPatch(raw, controls.map((c) => c.control));
    if (!checked.ok) {
      // eslint-disable-next-line no-console
      console.error(`[couch] setController rejected: ${checked.error}. A live couch rejects the whole patch too.`);
      return;
    }
    const patch = checked.patch;
    const entry = overrideFor(playerId);
    if (patch.labels) entry.labels = { ...patch.labels };
    if (patch.disabled) entry.disabled = new Set(patch.disabled);
    for (const [control, ms] of Object.entries(patch.cooldowns ?? {})) {
      entry.coolUntil.set(control, Date.now() + ms);
      setTimeout(paintOverrides, ms + 10);
    }
    // A control greyed out or cooling down under the finger stops getting
    // pointer events on the phone, which releases it right away; so do we.
    for (const pressed of [...held.values()]) {
      if (pressed.playerId === playerId && isBlocked(playerId, pressed.control.control)) forceRelease(pressed);
    }
    if (patch.vibrate !== undefined) {
      try {
        navigator.vibrate?.(patch.vibrate);
      } catch {
        /* no haptics in this browser */
      }
      const phone = phones.querySelector<HTMLElement>(`[data-player-id="${CSS.escape(playerId)}"]`);
      phone?.animate?.([{ transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'none' }], 160);
    }
    paintOverrides();
  }

  // Re-label and grey out the fake phones' buttons from the override map.
  function paintOverrides(): void {
    for (const player of core.players) {
      const phone = phones.querySelector<HTMLElement>(`[data-player-id="${CSS.escape(player.id)}"]`);
      if (!phone) continue;
      for (const control of controls) {
        for (const el of Array.from(phone.querySelectorAll<HTMLElement>(`[data-control="${CSS.escape(control.control)}"]`))) {
          if (el instanceof HTMLButtonElement && (el.dataset.kind === 'button' || el.dataset.kind === 'hold')) {
            el.textContent = labelFor(player.id, control);
          }
          if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) {
            el.disabled = isBlocked(player.id, control.control);
          }
        }
      }
    }
  }

  function destroy(): void {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', releaseAll);
    document.removeEventListener('visibilitychange', onVisibility);
    for (const entry of held.values()) if (entry.ticker !== undefined) clearInterval(entry.ticker);
    held.clear();
    if (toastTimer !== undefined) clearTimeout(toastTimer);
    root.remove();
  }

  return { showGameOver, setController, destroy };
}

/** Retro palette for fake-player accents. */
function paletteColor(idx: number): string {
  const palette = [
    '#ff5d73',
    '#4dd6ff',
    '#ffd166',
    '#8affc1',
    '#c792ea',
    '#ff9f68',
    '#5ce1e6',
    '#f78fb3'
  ];
  return palette[idx % palette.length];
}

/** Inject the one-and-only <style> block (idempotent). */
function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = SIM_CSS;
  document.head.appendChild(style);
}

const SIM_CSS = `
#${ROOT_ID}.couch-sim {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2147483000;
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  color: #e6e6f0;
  pointer-events: none;
}
#${ROOT_ID} * { box-sizing: border-box; }
#${ROOT_ID} .couch-sim-bar,
#${ROOT_ID} .couch-sim-panel { pointer-events: auto; }
#${ROOT_ID} .couch-sim-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: #14141f;
  border-top: 1px solid #2a2a3a;
  font-size: 12px;
}
#${ROOT_ID} .couch-sim-brand { font-weight: 700; color: #4dd6ff; letter-spacing: .04em; }
#${ROOT_ID} .couch-sim-tag {
  padding: 1px 6px;
  background: #24243a;
  border-radius: 4px;
  color: #ffd166;
}
#${ROOT_ID} .couch-sim-spacer { flex: 1; }
#${ROOT_ID} .couch-sim-btn {
  font: inherit;
  font-size: 12px;
  padding: 4px 8px;
  background: #24243a;
  color: #e6e6f0;
  border: 1px solid #34344a;
  border-radius: 5px;
  cursor: pointer;
}
#${ROOT_ID} .couch-sim-btn:hover { background: #2f2f4a; }
#${ROOT_ID} .couch-sim-btn:disabled { opacity: .4; cursor: not-allowed; }
#${ROOT_ID} .couch-sim-btn:focus-visible,
#${ROOT_ID} .couch-sim-seg-btn:focus-visible,
#${ROOT_ID} .couch-sim-pad:focus-visible,
#${ROOT_ID} .couch-sim-seed-input:focus-visible {
  outline: 2px solid #4dd6ff;
  outline-offset: 1px;
}
#${ROOT_ID} .couch-sim-panel {
  max-height: 46vh;
  overflow: auto;
  padding: 10px;
  background: #0f0f18;
  border-top: 1px solid #2a2a3a;
}
#${ROOT_ID} .couch-sim-panel.is-collapsed { display: none; }
#${ROOT_ID} .couch-sim-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
#${ROOT_ID} .couch-sim-seed {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
#${ROOT_ID} .couch-sim-seed-input {
  font: inherit;
  font-size: 12px;
  padding: 3px 6px;
  width: 140px;
  background: #14141f;
  color: #e6e6f0;
  border: 1px solid #34344a;
  border-radius: 4px;
}
#${ROOT_ID} .couch-sim-hint { font-size: 11px; color: #ffd166; }
#${ROOT_ID} .couch-sim-phones {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
#${ROOT_ID} .couch-sim-phone {
  width: 168px;
  background: #16161f;
  border: 1px solid #2c2c40;
  border-radius: 10px;
  overflow: hidden;
}
#${ROOT_ID} .couch-sim-phone-head {
  padding: 6px 8px;
  font-size: 12px;
  font-weight: 700;
  color: #0f0f18;
  background: var(--sim-color, #4dd6ff);
}
#${ROOT_ID} .couch-sim-phone-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
}
#${ROOT_ID} .couch-sim-empty { font-size: 11px; color: #7a7a92; }
#${ROOT_ID} .couch-sim-pad-label {
  display: block;
  font-size: 11px;
  color: #a8a8c0;
  margin-bottom: 4px;
}
#${ROOT_ID} .couch-sim-pad-button,
#${ROOT_ID} .couch-sim-pad-hold {
  font: inherit;
  font-size: 12px;
  padding: 10px 8px;
  width: 100%;
  background: #262640;
  color: #e6e6f0;
  border: 1px solid #3a3a55;
  border-radius: 8px;
  cursor: pointer;
  touch-action: none;
  user-select: none;
}
#${ROOT_ID} .couch-sim-pad-hold { background: #2f2440; border-color: #4a3a55; }
#${ROOT_ID} .couch-sim-pad-button:active,
#${ROOT_ID} .couch-sim-pad-hold:active { transform: translateY(1px); filter: brightness(1.2); }
#${ROOT_ID} .couch-sim-pad-slider input[type="range"] { width: 100%; }
#${ROOT_ID} .couch-sim-seg { display: flex; flex-wrap: wrap; gap: 4px; }
#${ROOT_ID} .couch-sim-seg-btn {
  font: inherit;
  font-size: 11px;
  padding: 5px 8px;
  background: #24243a;
  color: #e6e6f0;
  border: 1px solid #34344a;
  border-radius: 6px;
  cursor: pointer;
}
#${ROOT_ID} .couch-sim-seg-btn.is-active { background: #4dd6ff; color: #0f0f18; }
#${ROOT_ID} .couch-sim-toast {
  pointer-events: auto;
  position: absolute;
  right: 16px;
  bottom: calc(100% + 12px);
  min-width: 180px;
  padding: 12px 14px;
  background: #14141f;
  border: 1px solid #4dd6ff;
  border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0,0,0,.5);
}
#${ROOT_ID} .couch-sim-toast.is-hidden { display: none; }
#${ROOT_ID} .couch-sim-toast-title {
  font-weight: 700;
  color: #4dd6ff;
  margin-bottom: 6px;
}
#${ROOT_ID} .couch-sim-toast-row { font-size: 12px; padding: 2px 0; }
@media (prefers-reduced-motion: reduce) {
  #${ROOT_ID} .couch-sim-pad-button:active,
  #${ROOT_ID} .couch-sim-pad-hold:active { transform: none; }
}
`;
