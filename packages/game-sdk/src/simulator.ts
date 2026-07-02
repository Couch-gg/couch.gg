/**
 * Dev simulator — the built-in overlay shown when a game runs standalone
 * (top-level, `mode: 'dev'`). Vanilla DOM only; styles are injected via one
 * inline <style> (no CSS imports, so it works from file:// and inside LLM
 * sandboxes). Every fake input is stamped with an incrementing `seq` and
 * dispatched through the SAME core funnel as live `couch:input` messages.
 */

import type {
  CouchControl,
  CouchInputEnvelope,
  CouchManifest,
  CouchPlayer,
  CouchScore
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
  setPlayers(players: CouchPlayer[]): void;
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
/** Minimum gap between coalesced slider `change` emits (ms). */
const SLIDER_COALESCE_MS = 100;

/** Guard: are we in a DOM environment we can render into? */
function hasDom(): boolean {
  return typeof document !== 'undefined' && !!document.body;
}

export function createSimulator(opts: SimulatorOptions): Simulator {
  if (!hasDom()) {
    // No DOM (e.g. SSR / worker) — return an inert handle.
    return { showGameOver: () => {}, destroy: () => {} };
  }

  const { manifest, core } = opts;
  const controls: CouchControl[] = manifest.controllerLayout?.controls ?? [];

  let seq = 0;
  const nextSeq = (): number => (seq += 1);

  /** Emit an input through the shared core funnel, stamped with seq + timestamp. */
  const emitInput = (
    playerId: string,
    control: string,
    action: CouchInputEnvelope['action'],
    value?: unknown
  ): void => {
    core.dispatchInput({
      seq: nextSeq(),
      at: Date.now(),
      playerId,
      control,
      action,
      value
    });
  };

  // ---- style injection (single inline <style>) --------------------------
  injectStyles();

  // ---- roster: seed 2 fake players -------------------------------------
  const makePlayer = (idx: number): CouchPlayer => ({
    id: `sim-p${idx + 1}`,
    name: FAKE_NAMES[idx] ?? `P${idx + 1}`,
    colorIdx: idx,
    connected: true
  });
  core.setPlayers([makePlayer(0), makePlayer(1)]);

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
    core.removePlayer(last.id);
    renderPhones();
    syncRosterButtons();
  });

  pauseBtn.addEventListener('click', () => core.pause('dev'));
  resumeBtn.addEventListener('click', () => core.resume());

  seedInput.addEventListener('input', () => {
    core.setSeed(seedInput.value);
    seedHint.textContent = 'reload to apply';
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
        return renderButton(player, control);
      case 'hold':
        return renderHold(player, control);
      case 'slider':
        return renderSlider(player, control);
      case 'select':
        return renderSelect(player, control);
      default:
        return renderButton(player, control);
    }
  }

  function renderButton(player: CouchPlayer, control: CouchControl): HTMLElement {
    const btn = document.createElement('button');
    btn.className = 'couch-sim-pad couch-sim-pad-button';
    btn.type = 'button';
    btn.textContent = control.label || control.control;
    btn.dataset.control = control.control;
    btn.dataset.kind = 'button';
    const press = (e: Event): void => {
      e.preventDefault();
      emitInput(player.id, control.control, 'press');
    };
    const release = (): void => {
      emitInput(player.id, control.control, 'release');
    };
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointerleave', release);
    return btn;
  }

  function renderHold(player: CouchPlayer, control: CouchControl): HTMLElement {
    const btn = document.createElement('button');
    btn.className = 'couch-sim-pad couch-sim-pad-hold';
    btn.type = 'button';
    btn.textContent = control.label || control.control;
    btn.dataset.control = control.control;
    btn.dataset.kind = 'hold';

    let holdStart = 0;
    let ticker: ReturnType<typeof setInterval> | undefined;
    let held = false;

    const start = (e: Event): void => {
      e.preventDefault();
      if (held) return;
      held = true;
      holdStart = Date.now();
      emitInput(player.id, control.control, 'press');
      ticker = setInterval(() => {
        const elapsed = Date.now() - holdStart;
        // Progress ramps to 1 over ~2s; clamped. Purely illustrative in the sim.
        const progress = Math.min(1, elapsed / 2000);
        emitInput(player.id, control.control, 'change', { progress });
      }, HOLD_TICK_MS);
    };

    const end = (): void => {
      if (!held) return;
      held = false;
      if (ticker !== undefined) {
        clearInterval(ticker);
        ticker = undefined;
      }
      const heldMs = Date.now() - holdStart;
      emitInput(player.id, control.control, 'release', { heldMs });
    };

    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointerleave', end);
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

  // ---- keyboard bindings (player 1) ------------------------------------
  const keyState = new Set<string>();
  const buttonControls = (): CouchControl[] =>
    controls.filter((c) => c.type === 'button' || c.type === 'hold');
  const firstSlider = (): CouchControl | undefined =>
    controls.find((c) => c.type === 'slider');
  const firstHold = (): CouchControl | undefined => controls.find((c) => c.type === 'hold');

  const primaryId = (): string | undefined => core.players[0]?.id;

  const onKeyDown = (e: KeyboardEvent): void => {
    const pid = primaryId();
    if (!pid) return;
    // Digit1..9 -> nth button press.
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) {
      const n = Number(digit[1]) - 1;
      const btns = buttonControls();
      const control = btns[n];
      if (control && !keyState.has(e.code)) {
        keyState.add(e.code);
        emitInput(pid, control.control, 'press');
      }
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
      if (hold && !keyState.has('Space')) {
        keyState.add('Space');
        e.preventDefault();
        emitInput(pid, hold.control, 'press');
      }
    }
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    const pid = primaryId();
    if (!pid) return;
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit && keyState.has(e.code)) {
      keyState.delete(e.code);
      const n = Number(digit[1]) - 1;
      const control = buttonControls()[n];
      if (control) emitInput(pid, control.control, 'release');
      return;
    }
    if (e.code === 'Space' && keyState.has('Space')) {
      keyState.delete('Space');
      const hold = firstHold();
      if (hold) emitInput(pid, hold.control, 'release');
    }
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

  function destroy(): void {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    if (toastTimer !== undefined) clearTimeout(toastTimer);
    root.remove();
  }

  return { showGameOver, destroy };
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
