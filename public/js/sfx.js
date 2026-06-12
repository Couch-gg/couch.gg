// public/js/sfx.js
// Agent ART — retro sound effects synthesized live with the WebAudio API. Zero asset files.
//
// Public surface (per CONTRACT.md section 5):
//   export const SFX = { play(name) }
//     name in: 'click' | 'fire' | 'explode' | 'death' | 'yourturn' | 'win' | 'lose' | 'tick'
//
// Design notes:
//   - The AudioContext is created lazily and resumed on the first real user gesture
//     (pointerdown / keydown / touchstart). Browsers block audio until then; we install a
//     one-time listener at module load so the very first SFX after a click works.
//   - Safari support via window.webkitAudioContext fallback.
//   - play() must NEVER throw: every path is wrapped; if audio is unavailable it is a silent no-op.
//   - Master gain kept modest (~0.25) so the game never blasts the player.

const MASTER_GAIN = 0.25;

let ctx = null;        // the (single) AudioContext, created on demand
let master = null;     // master GainNode feeding the destination
let unlocked = false;  // becomes true once a gesture has resumed the context

const AC = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) || null;

// Create the context + master bus the first time we need them. Returns null if WebAudio is
// unavailable in this environment (e.g. very old browser, SSR).
function ensureContext() {
  if (ctx) return ctx;
  if (!AC) return null;
  try {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(ctx.destination);
  } catch (e) {
    ctx = null;
    master = null;
  }
  return ctx;
}

// Resume the context if it is suspended (must be called from within a user-gesture handler the
// first time). Safe to call repeatedly.
function resume() {
  const c = ensureContext();
  if (!c) return;
  if (c.state === 'suspended' && typeof c.resume === 'function') {
    // resume() returns a promise that can reject; swallow it.
    const p = c.resume();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }
  unlocked = true;
}

// One-time gesture unlock. Installed at module load. After the first gesture we remove the
// listeners so we don't keep firing.
function installUnlock() {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  const onGesture = () => {
    resume();
    window.removeEventListener('pointerdown', onGesture, true);
    window.removeEventListener('keydown', onGesture, true);
    window.removeEventListener('touchstart', onGesture, true);
    window.removeEventListener('mousedown', onGesture, true);
  };
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);
  window.addEventListener('touchstart', onGesture, true);
  window.addEventListener('mousedown', onGesture, true);
}
installUnlock();

// ---------------------------------------------------------------------------------------------
// Low-level voice helpers. All take an absolute start time `t0` (ctx.currentTime + offset).
// ---------------------------------------------------------------------------------------------

// A single oscillator note with an attack/decay envelope. Optional pitch sweep to `freqEnd`.
function tone(t0, { type = 'square', freq = 440, freqEnd = null, dur = 0.12, gain = 0.5, attack = 0.005 } = {}) {
  const c = ctx;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(1, freq), t0);
  if (freqEnd != null) {
    // exponential ramps need strictly positive values
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + dur);
  }
  // Envelope: quick attack to `gain`, then exponential decay toward silence.
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

// A burst of white noise routed through a (optionally swept) lowpass filter, with an envelope.
// Used for whooshes, explosions, etc.
function noise(t0, { dur = 0.3, gain = 0.5, attack = 0.005, lpStart = 4000, lpEnd = 400, q = 0.7 } = {}) {
  const c = ctx;
  const frames = Math.max(1, Math.floor(c.sampleRate * dur));
  const buffer = c.createBuffer(1, frames, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

  const src = c.createBufferSource();
  src.buffer = buffer;

  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = q;
  lp.frequency.setValueAtTime(Math.max(20, lpStart), t0);
  lp.frequency.exponentialRampToValueAtTime(Math.max(20, lpEnd), t0 + dur);

  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  src.connect(lp);
  lp.connect(g);
  g.connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

// ---------------------------------------------------------------------------------------------
// Sound recipes. Each returns nothing; they schedule voices starting "now".
// ---------------------------------------------------------------------------------------------
const RECIPES = {
  // Short square blip — UI clicks.
  click(now) {
    tone(now, { type: 'square', freq: 660, dur: 0.06, gain: 0.45 });
  },

  // Low thunk (counterweight drop) + a noise whoosh sweeping down (the arm cutting air).
  fire(now) {
    tone(now, { type: 'triangle', freq: 180, freqEnd: 80, dur: 0.16, gain: 0.6 });
    tone(now + 0.02, { type: 'square', freq: 120, freqEnd: 60, dur: 0.1, gain: 0.3 });
    noise(now + 0.04, { dur: 0.28, gain: 0.35, lpStart: 5000, lpEnd: 900, q: 0.6 });
  },

  // Explosion: a punchy noise burst with a long lowpass decay, plus a sub thump underneath.
  explode(now) {
    noise(now, { dur: 0.45, gain: 0.6, lpStart: 6000, lpEnd: 200, q: 0.8 });
    tone(now, { type: 'sine', freq: 110, freqEnd: 45, dur: 0.4, gain: 0.55 });
    tone(now + 0.01, { type: 'square', freq: 90, freqEnd: 40, dur: 0.18, gain: 0.25 });
  },

  // Death: a deeper, longer boom than explode — a player got knocked out.
  death(now) {
    tone(now, { type: 'sine', freq: 90, freqEnd: 30, dur: 0.7, gain: 0.6 });
    noise(now, { dur: 0.7, gain: 0.4, lpStart: 2200, lpEnd: 120, q: 1.0 });
    tone(now + 0.06, { type: 'triangle', freq: 70, freqEnd: 28, dur: 0.5, gain: 0.3 });
  },

  // Your turn: two ascending square notes — a friendly "ping-pong".
  yourturn(now) {
    tone(now, { type: 'square', freq: 587, dur: 0.11, gain: 0.4 });        // D5
    tone(now + 0.12, { type: 'square', freq: 880, dur: 0.16, gain: 0.45 }); // A5
  },

  // Win: a little ascending arpeggio.
  win(now) {
    const seq = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    for (let i = 0; i < seq.length; i++) {
      tone(now + i * 0.1, { type: 'square', freq: seq[i], dur: 0.14, gain: 0.42 });
    }
  },

  // Lose: a descending arpeggio (sadder triangle timbre).
  lose(now) {
    const seq = [523.25, 415.3, 349.23, 261.63]; // C5 G#4 F4 C4
    for (let i = 0; i < seq.length; i++) {
      tone(now + i * 0.12, { type: 'triangle', freq: seq[i], dur: 0.18, gain: 0.4 });
    }
  },

  // Tick: tiny high blip — countdown in the last few seconds.
  tick(now) {
    tone(now, { type: 'square', freq: 1320, dur: 0.04, gain: 0.3 });
  },
};

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------
export const SFX = {
  // Play a named sound. Never throws; no-ops if audio is unavailable or still suspended.
  play(name) {
    try {
      const recipe = RECIPES[name];
      if (!recipe) return;
      const c = ensureContext();
      if (!c) return;
      // If a gesture hasn't unlocked us yet, try to resume opportunistically (this call might
      // itself be inside a gesture). If still suspended, bail quietly rather than queueing.
      if (c.state === 'suspended') {
        resume();
        if (c.state === 'suspended') return;
      }
      const now = c.currentTime + 0.001;
      recipe(now);
    } catch (e) {
      // Swallow everything — audio must never break gameplay.
    }
  },
};

export default SFX;
