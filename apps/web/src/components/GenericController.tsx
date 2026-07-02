import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
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

interface GenericControllerProps {
  layout: ControllerLayout;
  enabled: boolean;
  onEvent: (control: string, action: InputAction, data?: unknown) => void;
}

export function GenericController({ layout, enabled, onEvent }: GenericControllerProps) {
  const controls = layout.controls ?? [];
  const sliders = controls.filter((c) => c.type === 'slider');
  const selects = controls.filter((c) => c.type === 'select');
  const actions = controls.filter((c) => c.type === 'button' || c.type === 'hold');
  const singleCluster = controls.length <= 2;

  return (
    <div className={`generic-controls retro-pad${enabled ? '' : ' generic-disabled'}`} aria-disabled={!enabled}>
      <div className="retro-pad-shell generic-pad-shell">
        <div className="retro-pad-brand">
          <span className={enabled ? 'retro-led on' : 'retro-led'} aria-hidden="true" />
          <span className="retro-pad-name">COUCH.GG</span>
          <span className="retro-pad-model" aria-hidden="true">GEN-01</span>
        </div>

        {selects.length > 0 ? (
          <div className="generic-select-row">
            {selects.map((control) => (
              <SelectControl key={control.control} control={control.control} label={control.label} options={control.options ?? []} enabled={enabled} onEvent={onEvent} />
            ))}
          </div>
        ) : null}

        <div className={`generic-cluster${singleCluster ? ' generic-cluster-single' : ''}`}>
          {sliders.length > 0 ? (
            <div className="generic-slider-col">
              {sliders.map((control) => (
                <SliderControl
                  key={control.control}
                  control={control.control}
                  label={control.label}
                  min={control.min ?? 0}
                  max={control.max ?? 100}
                  step={control.step ?? 1}
                  enabled={enabled}
                  onEvent={onEvent}
                />
              ))}
            </div>
          ) : null}

          {actions.length > 0 ? (
            <div className="generic-action-cluster">
              {actions.map((control) =>
                control.type === 'hold' ? (
                  <HoldControl key={control.control} control={control.control} label={control.label} enabled={enabled} onEvent={onEvent} />
                ) : (
                  <ButtonControl key={control.control} control={control.control} label={control.label} enabled={enabled} onEvent={onEvent} />
                )
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
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

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
