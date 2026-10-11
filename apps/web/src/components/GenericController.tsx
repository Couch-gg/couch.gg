import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactElement } from 'react';
import type { ControllerLayout, InputAction } from '@couch/types';

// Manifest-driven phone controller for external games. Renders whatever
// controls the game's manifest declares (button/hold/slider/select) with zero
// game-specific logic — this is the "controllers for free" piece described in
// the third-party publishing plan. Reuses the trebuchet retro-pad's visual
// vocabulary (dark shell, chunky buttons, LED accents) via new `.generic-*`
// variants in styles.css; the trebuchet classes themselves are untouched.

const HOLD_TICK_MS = 120;
const HOLD_RAMP_MS = 1500;
const SLIDER_COALESCE_MS = 100;
// Thumbstick: at most ~15 changes/s, inside the server's 20/s per-player budget.
const STICK_THROTTLE_MS = 66;
const STICK_DEADZONE = 0.12;
const STICK_MIN_DELTA = 0.04;
const DPAD_DEADZONE = 0.25;

type LayoutControl = ControllerLayout['controls'][number];

interface GenericControllerProps {
  layout: ControllerLayout;
  enabled: boolean;
  onEvent: (control: string, action: InputAction, data?: unknown) => void;
}

export function GenericController({ layout, enabled, onEvent }: GenericControllerProps) {
  const controls = layout.controls ?? [];

  const render = (control: LayoutControl) => {
    const key = control.control;
    const base = { control: control.control, label: control.label, enabled, onEvent };
    switch (control.type) {
      case 'stick':
        return <StickControl key={key} {...base} />;
      case 'dpad':
        return <DpadControl key={key} {...base} />;
      case 'hold':
        return <HoldControl key={key} {...base} />;
      case 'select':
        return <SelectControl key={key} {...base} options={control.options ?? []} />;
      case 'slider':
        return <SliderControl key={key} {...base} min={control.min ?? 0} max={control.max ?? 100} step={control.step ?? 1} />;
      default:
        return <ButtonControl key={key} {...base} />;
    }
  };

  return (
    <div
      className={`generic-controls retro-pad${enabled ? '' : ' generic-disabled'}${layout.orientation === 'landscape' ? ' generic-landscape' : ''}`}
      aria-disabled={!enabled}
    >
      <div className="retro-pad-shell generic-pad-shell">
        <div className="retro-pad-brand">
          <span className={enabled ? 'retro-led on' : 'retro-led'} aria-hidden="true" />
          <span className="retro-pad-name">COUCH.GG</span>
          <span className="retro-pad-model" aria-hidden="true">GEN-01</span>
        </div>
        {layout.orientation === 'landscape' ? (
          <LandscapeZones controls={controls} render={render} />
        ) : (
          <PortraitLayout controls={controls} render={render} />
        )}
      </div>
    </div>
  );
}

function isDirectional(control: LayoutControl): boolean {
  return control.type === 'stick' || control.type === 'dpad';
}

// Landscape: a left and a right thumb zone. Directional controls default left,
// everything else right; a control's own `zone` wins.
function LandscapeZones({ controls, render }: { controls: LayoutControl[]; render: (c: LayoutControl) => ReactElement }) {
  const zoneOf = (control: LayoutControl) => control.zone ?? (isDirectional(control) ? 'left' : 'right');
  const left = controls.filter((control) => zoneOf(control) === 'left');
  const right = controls.filter((control) => zoneOf(control) === 'right');
  return (
    <div className="generic-zones">
      <div className="generic-zone generic-zone-left">{left.map(render)}</div>
      <div className="generic-zone generic-zone-right">{right.map(render)}</div>
    </div>
  );
}

function PortraitLayout({ controls, render }: { controls: LayoutControl[]; render: (c: LayoutControl) => ReactElement }) {
  const sliders = controls.filter((c) => c.type === 'slider');
  const selects = controls.filter((c) => c.type === 'select');
  const directional = controls.filter(isDirectional);
  const actions = controls.filter((c) => c.type === 'button' || c.type === 'hold');
  const singleCluster = sliders.length + actions.length <= 2 && sliders.length === 0;

  return (
    <>
      {selects.length > 0 ? <div className="generic-select-row">{selects.map(render)}</div> : null}
      {directional.length > 0 ? <div className="generic-analog-row">{directional.map(render)}</div> : null}
      {sliders.length + actions.length > 0 ? (
        <div className={`generic-cluster${singleCluster || sliders.length === 0 || actions.length === 0 ? ' generic-cluster-single' : ''}`}>
          {sliders.length > 0 ? <div className="generic-slider-col">{sliders.map(render)}</div> : null}
          {actions.length > 0 ? <div className="generic-action-cluster">{actions.map(render)}</div> : null}
        </div>
      ) : null}
    </>
  );
}

// Calls `release` when the phone stops being usable mid-press: screen lock, app
// switch, tab hidden, window blur. Without this a pointer that never gets its
// pointerup leaves the control held on the TV.
function useReleaseOnHide(release: () => void): void {
  const releaseRef = useRef(release);
  releaseRef.current = release;
  useEffect(() => {
    const fire = () => releaseRef.current();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') fire();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', fire);
    window.addEventListener('blur', fire);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', fire);
      window.removeEventListener('blur', fire);
    };
  }, []);
}

// Guarded haptics: no-op when the device/browser does not support vibration
// (mirrors ControllerRoute's `haptic` helper, kept local since this component
// must carry no game-specific or cross-file dependencies).
function haptic(pattern: number | number[]): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern);
    }
  } catch {
    // Some browsers throw if called without a user gesture; ignore.
  }
}

interface ControlBaseProps {
  control: string;
  label: string;
  enabled: boolean;
  onEvent: (control: string, action: InputAction, data?: unknown) => void;
}

function ButtonControl({ control, label, enabled, onEvent }: ControlBaseProps) {
  const activeRef = useRef(false);

  const press = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (!enabled || activeRef.current) return;
    activeRef.current = true;
    haptic(15);
    onEvent(control, 'press');
  };

  const release = () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    onEvent(control, 'release');
  };
  useReleaseOnHide(release);

  return (
    <button
      type="button"
      className="generic-btn"
      disabled={!enabled}
      onPointerDown={press}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={label}
    >
      <span className="generic-btn-label">{label}</span>
    </button>
  );
}

function HoldControl({ control, label, enabled, onEvent }: ControlBaseProps) {
  const [charging, setCharging] = useState(false);
  const [progress, setProgress] = useState(0);
  const startRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const lastSendRef = useRef(0);

  const stopTimer = () => {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => stopTimer, []);

  const begin = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (!enabled || startRef.current != null) return;
    haptic(15);
    const now = performance.now();
    startRef.current = now;
    lastSendRef.current = now;
    setCharging(true);
    setProgress(0);
    onEvent(control, 'press');
    stopTimer();
    timerRef.current = window.setInterval(() => {
      const started = startRef.current;
      if (started == null) return;
      const nextProgress = Math.min(1, (performance.now() - started) / HOLD_RAMP_MS);
      setProgress(nextProgress);
      const tick = performance.now();
      if (tick - lastSendRef.current >= HOLD_TICK_MS) {
        lastSendRef.current = tick;
        onEvent(control, 'change', { progress: nextProgress });
      }
    }, HOLD_TICK_MS);
  };

  const end = () => {
    const started = startRef.current;
    if (started == null) return;
    stopTimer();
    const heldMs = performance.now() - started;
    startRef.current = null;
    setCharging(false);
    setProgress(0);
    haptic(30);
    onEvent(control, 'release', { heldMs });
  };
  useReleaseOnHide(end);

  return (
    <button
      type="button"
      className={`generic-btn generic-hold${charging ? ' charging' : ''}`}
      disabled={!enabled}
      onPointerDown={begin}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerLeave={end}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={label}
    >
      <span className="generic-hold-fill" style={{ width: `${progress * 100}%` }} aria-hidden="true" />
      <span className="generic-btn-label">{label}</span>
    </button>
  );
}

interface SliderControlProps extends ControlBaseProps {
  min: number;
  max: number;
  step: number;
}

function SliderControl({ control, label, min, max, step, enabled, onEvent }: SliderControlProps) {
  const [value, setValue] = useState(min);
  const gaugeRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const lastSendRef = useRef(0);
  const valueRef = useRef(value);
  valueRef.current = value;

  const snap = useCallback(
    (raw: number) => {
      const stepped = Math.round((raw - min) / step) * step + min;
      return Math.min(max, Math.max(min, stepped));
    },
    [min, max, step]
  );

  const setFromPointer = useCallback(
    (clientY: number, isFinal: boolean) => {
      const el = gaugeRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const t = clamp01(1 - (clientY - rect.top) / rect.height);
      const next = snap(min + t * (max - min));
      if (next === valueRef.current && !isFinal) return;
      setValue(next);
      const now = performance.now();
      if (isFinal || now - lastSendRef.current >= SLIDER_COALESCE_MS) {
        lastSendRef.current = now;
        onEvent(control, 'change', { value: next });
      }
    },
    [control, max, min, onEvent, snap]
  );

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!enabled) return;
    event.preventDefault();
    draggingRef.current = true;
    haptic(15);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // setPointerCapture can throw on stale ids; safe to ignore.
    }
    setFromPointer(event.clientY, false);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    event.preventDefault();
    setFromPointer(event.clientY, false);
  };

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    // Always send the final value on release, even if it was coalesced away.
    onEvent(control, 'change', { value: valueRef.current });
  };

  const fillPct = clamp01((value - min) / (max - min || 1)) * 100;

  return (
    <div className="generic-slider">
      <span className="generic-slider-label">{label}</span>
      <div
        ref={gaugeRef}
        className={`elev-gauge generic-gauge${enabled ? '' : ' disabled'}`}
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-orientation="vertical"
        tabIndex={enabled ? 0 : -1}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onKeyDown={(e) => {
          if (!enabled) return;
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
            e.preventDefault();
            const next = snap(valueRef.current + step);
            setValue(next);
            onEvent(control, 'change', { value: next });
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const next = snap(valueRef.current - step);
            setValue(next);
            onEvent(control, 'change', { value: next });
          }
        }}
      >
        <div className="elev-fill generic-fill" style={{ height: `${fillPct}%` }} />
        <span className="elev-tick top">{max}</span>
        <span className="elev-tick bottom">{min}</span>
        <span className="generic-slider-value">{value}</span>
      </div>
    </div>
  );
}

interface SelectControlProps {
  control: string;
  label: string;
  options: string[];
  enabled: boolean;
  onEvent: (control: string, action: InputAction, data?: unknown) => void;
}

function SelectControl({ control, label, options, enabled, onEvent }: SelectControlProps) {
  const [selected, setSelected] = useState<string | null>(null);

  const choose = (option: string) => {
    if (!enabled) return;
    haptic(15);
    setSelected(option);
    onEvent(control, 'change', { value: option });
  };

  return (
    <div className="generic-select" role="group" aria-label={label}>
      <span className="generic-select-label">{label}</span>
      <div className="generic-segmented">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className={`generic-segment${selected === option ? ' selected' : ''}`}
            disabled={!enabled}
            onPointerDown={(e) => {
              e.preventDefault();
              choose(option);
            }}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

// Pointer position relative to an element's centre, as a vector in the unit
// circle with y pointing up.
function vectorFrom(el: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  const radius = Math.min(rect.width, rect.height) / 2 || 1;
  let x = (clientX - (rect.left + rect.width / 2)) / radius;
  let y = -(clientY - (rect.top + rect.height / 2)) / radius;
  const length = Math.hypot(x, y);
  if (length > 1) {
    x /= length;
    y /= length;
  }
  return { x, y };
}

function StickControl({ control, label, enabled, onEvent }: ControlBaseProps) {
  const baseRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(false);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const sentRef = useRef({ x: 0, y: 0 });
  const lastSendRef = useRef(0);
  const trailingRef = useRef<number | null>(null);
  const latestRef = useRef({ x: 0, y: 0 });

  const clearTrailing = () => {
    if (trailingRef.current != null) {
      window.clearTimeout(trailingRef.current);
      trailingRef.current = null;
    }
  };
  useEffect(() => clearTrailing, []);

  const send = () => {
    clearTrailing();
    const next = latestRef.current;
    if (Math.abs(next.x - sentRef.current.x) < STICK_MIN_DELTA && Math.abs(next.y - sentRef.current.y) < STICK_MIN_DELTA) return;
    sentRef.current = next;
    lastSendRef.current = performance.now();
    onEvent(control, 'change', next);
  };

  const move = (clientX: number, clientY: number) => {
    const el = baseRef.current;
    if (!el) return;
    const raw = vectorFrom(el, clientX, clientY);
    setKnob(raw);
    const inDeadzone = Math.hypot(raw.x, raw.y) < STICK_DEADZONE;
    latestRef.current = inDeadzone ? { x: 0, y: 0 } : { x: round2(raw.x), y: round2(raw.y) };
    const wait = STICK_THROTTLE_MS - (performance.now() - lastSendRef.current);
    if (wait <= 0) send();
    else if (trailingRef.current == null) trailingRef.current = window.setTimeout(send, wait);
  };

  const release = () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    clearTrailing();
    setKnob({ x: 0, y: 0 });
    latestRef.current = { x: 0, y: 0 };
    sentRef.current = { x: 0, y: 0 };
    onEvent(control, 'release', { x: 0, y: 0 });
  };
  useReleaseOnHide(release);

  return (
    <div className="generic-stick-wrap">
      <div
        ref={baseRef}
        className={`generic-stick${enabled ? '' : ' disabled'}${activeRef.current ? ' active' : ''}`}
        role="application"
        aria-label={label}
        data-control={control}
        onPointerDown={(event) => {
          if (!enabled) return;
          event.preventDefault();
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // ignore stale pointer ids
          }
          activeRef.current = true;
          haptic(10);
          move(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => {
          if (!activeRef.current) return;
          event.preventDefault();
          move(event.clientX, event.clientY);
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span
          className="generic-stick-knob"
          style={{ transform: `translate(${knob.x * 50}%, ${-knob.y * 50}%)` }}
          aria-hidden="true"
        />
      </div>
      <span className="generic-slider-label">{label}</span>
    </div>
  );
}

const DPAD_DIRS = ['right', 'up-right', 'up', 'up-left', 'left', 'down-left', 'down', 'down-right'] as const;
type DpadDir = (typeof DPAD_DIRS)[number] | 'none';

function dpadDirection(v: { x: number; y: number }): DpadDir {
  if (Math.hypot(v.x, v.y) < DPAD_DEADZONE) return 'none';
  const angle = Math.atan2(v.y, v.x); // 0 = right, counter-clockwise
  const sector = Math.round(angle / (Math.PI / 4));
  return DPAD_DIRS[(sector + 8) % 8];
}

function DpadControl({ control, label, enabled, onEvent }: ControlBaseProps) {
  const padRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(false);
  const dirRef = useRef<DpadDir>('none');
  const [dir, setDir] = useState<DpadDir>('none');

  const apply = (next: DpadDir) => {
    if (next === dirRef.current) return;
    dirRef.current = next;
    setDir(next);
    if (next === 'none') {
      onEvent(control, 'release', { dir: 'none' });
    } else {
      haptic(8);
      onEvent(control, 'change', { dir: next });
    }
  };

  const track = (clientX: number, clientY: number) => {
    const el = padRef.current;
    if (el) apply(dpadDirection(vectorFrom(el, clientX, clientY)));
  };

  const release = () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    apply('none');
  };
  useReleaseOnHide(release);

  return (
    <div className="generic-stick-wrap">
      <div
        ref={padRef}
        className={`generic-dpad${enabled ? '' : ' disabled'}`}
        role="application"
        aria-label={label}
        data-control={control}
        data-dir={dir}
        onPointerDown={(event) => {
          if (!enabled) return;
          event.preventDefault();
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // ignore stale pointer ids
          }
          activeRef.current = true;
          track(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => {
          if (!activeRef.current) return;
          event.preventDefault();
          track(event.clientX, event.clientY);
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onContextMenu={(e) => e.preventDefault()}
      >
        {(['up', 'right', 'down', 'left'] as const).map((arm) => (
          <span key={arm} className={`generic-dpad-arm ${arm}${dir.includes(arm) ? ' lit' : ''}`} aria-hidden="true" />
        ))}
      </div>
      <span className="generic-slider-label">{label}</span>
    </div>
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
