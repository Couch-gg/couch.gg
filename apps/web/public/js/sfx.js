// public/js/sfx.js
// Agent AUDIO — retro sound effects + subtle music synthesized live with the WebAudio API.
// Zero asset files.
//
// Public surface (per CONTRACT.md section 8.1):
//   export const SFX = {
//     play(name),                                  // one-shot SFX
//     startCharge(), setChargeLevel(p01), stopCharge(),   // sustained "winding up" whine
//     musicScene('menu'|'game'|'none'), startMusic(), stopMusic(),  // background music bed
//     toggleMute(), setMuted(bool), isMuted(),     // persisted mute
//   } + default export.
//     play names: 'click' | 'fire' | 'explode' | 'death' | 'yourturn' | 'win' | 'lose' | 'tick'
//                 | 'aim' | 'charge_full' | 'whistle' | 'thud' | 'hit' | 'bighit' | 'crumble'
//
// Design notes:
//   - The AudioContext is created lazily and resumed on the first real user gesture. Browsers
//     (and especially iOS Safari) block audio until then; we install capture-phase listeners at
//     module load. Those listeners are NOT removed until ctx.state === 'running', so a resume()
//     that didn't "take" (the classic deploy bug) is retried on the next gesture. On a successful
//     unlock we also play one silent 1-frame buffer — iOS requires an actual buffer play to fully
//     unlock audio output.
//   - Safari support via window.webkitAudioContext fallback.
//   - EVERY public method must NEVER throw: every path is wrapped; if audio is unavailable, the
//     context is suspended/locked, or we are muted, it is a silent no-op.
//   - Master SFX gain kept modest (~0.25). Music uses a SEPARATE gain (~0.12) so it sits well
//     behind effects. When muted, an outer "muteGain" is pulled to 0 so ALL audio is silenced.

const MASTER_GAIN = 0.25;   // SFX bus
const MUSIC_GAIN = 0.12;    // music bus — well under SFX
const MUTE_KEY = 'treb.muted';

let ctx = null;        // the (single) AudioContext, created on demand
let muteGain = null;   // outer gain feeding destination; 0 when muted, 1 otherwise
let master = null;     // SFX master GainNode (feeds muteGain)
let musicGain = null;  // music master GainNode (feeds muteGain)
let unlocked = false;  // becomes true once a gesture has resumed the context to "running"
let muted = false;     // current mute state (seeded from localStorage on load)

const AC = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) || null;

// --- mute persistence -------------------------------------------------------------------------
// Read persisted mute flag. Default UNMUTED on first load. Never throws (storage can be blocked).
function readMuted() {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch (e) {
    return false;
  }
}
function writeMuted(m) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(MUTE_KEY, m ? '1' : '0');
  } catch (e) {
    // storage unavailable / quota / privacy mode — ignore.
  }
}
muted = readMuted();

// Apply the current mute state to the live audio graph (if any). Safe to call any time.
function applyMute() {
  try {
    if (!ctx || !muteGain) return;
    const t = ctx.currentTime;
    const target = muted ? 0.0001 : 1;
    muteGain.gain.cancelScheduledValues(t);
    muteGain.gain.setValueAtTime(Math.max(0.0001, muteGain.gain.value || 0.0001), t);
    muteGain.gain.exponentialRampToValueAtTime(Math.max(0.0001, target), t + 0.05);
    if (!muted) muteGain.gain.setValueAtTime(1, t + 0.06);
  } catch (e) {
    // never throw
  }
}

// Create the context + buses the first time we need them. Returns null if WebAudio is unavailable
// in this environment (e.g. very old browser, SSR).
function ensureContext() {
  if (ctx) return ctx;
  if (!AC) return null;
  try {
    ctx = new AC();
    // Outer mute gain → destination. master + music both feed it so mute silences everything.
    muteGain = ctx.createGain();
    muteGain.gain.value = muted ? 0.0001 : 1;
    muteGain.connect(ctx.destination);

    master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(muteGain);

    musicGain = ctx.createGain();
    musicGain.gain.value = 0.0001; // music fades in only when a scene asks for it
    musicGain.connect(muteGain);
  } catch (e) {
    ctx = null;
    muteGain = null;
    master = null;
    musicGain = null;
  }
  return ctx;
}

// Play one silent 1-frame buffer. iOS Safari needs an actual buffer play to fully unlock output.
function pokeSilentBuffer() {
  try {
    if (!ctx) return;
    const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  } catch (e) {
    // ignore
  }
}

// Resume the context if it is suspended (must be called from within a user-gesture handler the
// first time). Safe to call repeatedly. We only consider ourselves "unlocked" once the state is
// actually 'running'.
function resume() {
  const c = ensureContext();
  if (!c) return;
  try {
    if (c.state === 'suspended' && typeof c.resume === 'function') {
      const p = c.resume();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch (e) {
    // ignore
  }
  if (c.state === 'running' && !unlocked) {
    unlocked = true;
    pokeSilentBuffer();
    applyMute();
    onUnlocked();
  }
}

// Gesture unlock. Installed at module load. The listeners are NOT removed until the context is
// actually 'running' — every gesture re-attempts resume() so a first attempt that didn't take
// (common on iOS / strict autoplay policies) still unlocks on a later gesture.
const GESTURES = ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'keydown'];
function installUnlock() {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  const onGesture = () => {
    try {
      resume();
      const c = ctx;
      if (c && c.state === 'running') {
        for (const ev of GESTURES) {
          try { window.removeEventListener(ev, onGesture, true); } catch (e) {}
        }
      }
    } catch (e) {
      // never throw out of a DOM handler
    }
  };
  for (const ev of GESTURES) {
    try { window.addEventListener(ev, onGesture, true); } catch (e) {}
  }
}
installUnlock();

// Page visibility: suspend / pause when hidden; resume when visible IF unlocked and not muted.
function installVisibility() {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  document.addEventListener('visibilitychange', () => {
    try {
      if (!ctx) return;
      if (document.hidden) {
        if (typeof ctx.suspend === 'function' && ctx.state === 'running') {
          const p = ctx.suspend();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      } else if (unlocked && !muted) {
        if (typeof ctx.resume === 'function' && ctx.state === 'suspended') {
          const p = ctx.resume();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      }
    } catch (e) {
      // never throw
    }
  });
}
installVisibility();

// Hook fired exactly once when the context first reaches 'running'. Kicks off any music scene
// that was requested before unlock.
function onUnlocked() {
  try {
    if (pendingScene && pendingScene !== 'none') {
      applyMusicScene(pendingScene);
    }
  } catch (e) {}
}

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

  // --- new recipes (CONTRACT §8.1) ---

  // Aim: a tiny, very quiet tick when the elevation arc changes. Kept short + soft so a
  // hold-to-repeat sweep doesn't become annoying.
  aim(now) {
    tone(now, { type: 'square', freq: 1000, dur: 0.022, gain: 0.12 });
  },

  // Charge full: bright two-note ping when charge reaches max.
  charge_full(now) {
    tone(now, { type: 'square', freq: 988, dur: 0.07, gain: 0.4 });        // B5
    tone(now + 0.07, { type: 'square', freq: 1318.5, dur: 0.13, gain: 0.42 }); // E6
  },

  // Whistle: descending pitch as a projectile falls — a classic incoming-rock whistle.
  whistle(now) {
    tone(now, { type: 'sine', freq: 1600, freqEnd: 300, dur: 0.5, gain: 0.28, attack: 0.02 });
    tone(now, { type: 'triangle', freq: 1600, freqEnd: 300, dur: 0.5, gain: 0.1, attack: 0.02 });
  },

  // Thud: dull terrain hit, no damage — low, muffled, no sparkle.
  thud(now) {
    tone(now, { type: 'sine', freq: 150, freqEnd: 60, dur: 0.16, gain: 0.5 });
    noise(now, { dur: 0.14, gain: 0.22, lpStart: 800, lpEnd: 150, q: 0.5 });
  },

  // Hit: direct player hit accent — punchier than thud, with a short bright crack.
  hit(now) {
    tone(now, { type: 'square', freq: 220, freqEnd: 90, dur: 0.14, gain: 0.5 });
    noise(now, { dur: 0.18, gain: 0.4, lpStart: 4000, lpEnd: 500, q: 0.8 });
    tone(now + 0.01, { type: 'square', freq: 660, dur: 0.05, gain: 0.22 });
  },

  // Bighit: heavy plunging hit — deep sub boom + long noisy tail.
  bighit(now) {
    tone(now, { type: 'sine', freq: 120, freqEnd: 38, dur: 0.55, gain: 0.65 });
    tone(now + 0.01, { type: 'triangle', freq: 95, freqEnd: 30, dur: 0.4, gain: 0.3 });
    noise(now, { dur: 0.5, gain: 0.5, lpStart: 5000, lpEnd: 150, q: 0.9 });
  },

  // Crumble: castle stone shatter — noisy, gravelly. Layered noise bursts at slight offsets
  // give a "rubble cascading" texture, with a low thump underneath.
  crumble(now) {
    tone(now, { type: 'sine', freq: 100, freqEnd: 45, dur: 0.3, gain: 0.35 });
    noise(now, { dur: 0.35, gain: 0.42, lpStart: 3500, lpEnd: 600, q: 1.2 });
    noise(now + 0.04, { dur: 0.22, gain: 0.3, lpStart: 5000, lpEnd: 900, q: 1.4 });
    noise(now + 0.1, { dur: 0.2, gain: 0.24, lpStart: 4200, lpEnd: 700, q: 1.6 });
    noise(now + 0.16, { dur: 0.16, gain: 0.18, lpStart: 3800, lpEnd: 800, q: 1.6 });
  },
};

// ---------------------------------------------------------------------------------------------
// Sustained charge tone — a quiet rising "winding up" whine.
// ---------------------------------------------------------------------------------------------
let chargeOsc = null;
let chargeOsc2 = null;
let chargeGain = null;
const CHARGE_F0 = 160;   // base pitch at level 0
const CHARGE_F1 = 720;   // pitch at level 1
const CHARGE_PEAK = 0.07; // quiet — well under one-shot SFX

function chargeFreqFor(p01) {
  const p = Math.max(0, Math.min(1, p01));
  return CHARGE_F0 + (CHARGE_F1 - CHARGE_F0) * p;
}

function startChargeInternal() {
  if (chargeOsc) return; // idempotent
  const c = ctx;
  chargeGain = c.createGain();
  chargeGain.gain.setValueAtTime(0.0001, c.currentTime);
  chargeGain.gain.exponentialRampToValueAtTime(CHARGE_PEAK, c.currentTime + 0.08);
  chargeGain.connect(master);

  chargeOsc = c.createOscillator();
  chargeOsc.type = 'sawtooth';
  chargeOsc.frequency.setValueAtTime(CHARGE_F0, c.currentTime);

  // A second detuned square an octave-ish above adds a mechanical "winding" shimmer, quietly.
  chargeOsc2 = c.createOscillator();
  chargeOsc2.type = 'square';
  chargeOsc2.frequency.setValueAtTime(CHARGE_F0 * 2.01, c.currentTime);
  const g2 = c.createGain();
  g2.gain.value = 0.3;

  chargeOsc.connect(chargeGain);
  chargeOsc2.connect(g2);
  g2.connect(chargeGain);

  chargeOsc.start();
  chargeOsc2.start();
}

function stopChargeInternal() {
  if (!chargeOsc) return;
  const c = ctx;
  const t = c ? c.currentTime : 0;
  try {
    if (chargeGain) {
      chargeGain.gain.cancelScheduledValues(t);
      chargeGain.gain.setValueAtTime(Math.max(0.0001, chargeGain.gain.value || 0.0001), t);
      chargeGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    }
    if (chargeOsc) chargeOsc.stop(t + 0.12);
    if (chargeOsc2) chargeOsc2.stop(t + 0.12);
  } catch (e) {
    // ignore
  }
  chargeOsc = null;
  chargeOsc2 = null;
  chargeGain = null;
}

// ---------------------------------------------------------------------------------------------
// Background music — subtle synthesized bed. Slow minor-key pad + sparse arpeggio, 8-bit timbres.
// Driven by a self-rescheduling step loop so the loop is seamless and survives indefinitely.
// ---------------------------------------------------------------------------------------------
let musicOn = false;
let musicScene = 'none';
let pendingScene = 'none';   // scene requested before unlock; applied on unlock
let musicTimer = null;
let musicStep = 0;
let padOsc = null;
let padOsc2 = null;
let padGain = null;

// A minor (A2 root). Pad holds a slow triad; arpeggio sprinkles notes from the scale.
// Frequencies in Hz.
const A_MINOR_PAD = [110.0, 130.81, 164.81];          // A2 C3 E3 (low pad triad)
const ARP_MENU = [440.0, 523.25, 659.25, 523.25];      // A4 C5 E5 C5 — calm
const ARP_GAME = [440.0, 523.25, 659.25, 783.99, 659.25, 523.25]; // adds G5 — more motion

// Scene parameters. Step interval (ms), how often the arpeggio plays, arp note set, pad level.
const SCENE_CFG = {
  menu: { stepMs: 420, arpEvery: 2, arp: ARP_MENU, padLevel: 0.5, arpGain: 0.16 },
  game: { stepMs: 300, arpEvery: 1, arp: ARP_GAME, padLevel: 0.42, arpGain: 0.14 },
};

// One arpeggio voice routed through musicGain (NOT master) so the music bus controls it.
function musicTone(t0, { type = 'square', freq = 440, dur = 0.18, gain = 0.15 } = {}) {
  const c = ctx;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(1, freq), t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(musicGain);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

// Start the slow sustained pad (two detuned oscillators) feeding musicGain.
function startPad() {
  if (padOsc) return;
  const c = ctx;
  padGain = c.createGain();
  padGain.gain.value = 0.0001;
  padGain.connect(musicGain);

  padOsc = c.createOscillator();
  padOsc.type = 'triangle';
  padOsc.frequency.value = A_MINOR_PAD[0];
  padOsc2 = c.createOscillator();
  padOsc2.type = 'triangle';
  padOsc2.frequency.value = A_MINOR_PAD[2]; // a fifth-ish above for a soft drone

  padOsc.connect(padGain);
  padOsc2.connect(padGain);
  padOsc.start();
  padOsc2.start();
}

function stopPad() {
  if (!padOsc) return;
  const c = ctx;
  const t = c ? c.currentTime : 0;
  try {
    if (padGain) {
      padGain.gain.cancelScheduledValues(t);
      padGain.gain.setValueAtTime(Math.max(0.0001, padGain.gain.value || 0.0001), t);
      padGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    }
    if (padOsc) padOsc.stop(t + 0.5);
    if (padOsc2) padOsc2.stop(t + 0.5);
  } catch (e) {}
  padOsc = null;
  padOsc2 = null;
  padGain = null;
}

// One music step: hold the pad and occasionally drop an arpeggio note. Self-reschedules.
function musicStepTick() {
  try {
    if (!musicOn || !ctx) return;
    const cfg = SCENE_CFG[musicScene] || SCENE_CFG.menu;
    const c = ctx;
    const now = c.currentTime + 0.02;

    // Keep the pad gently breathing toward its scene level.
    if (padGain) {
      padGain.gain.cancelScheduledValues(now);
      padGain.gain.setValueAtTime(Math.max(0.0001, padGain.gain.value || 0.0001), now);
      padGain.gain.linearRampToValueAtTime(cfg.padLevel, now + cfg.stepMs / 1000);
    }

    if (musicStep % cfg.arpEvery === 0) {
      const arp = cfg.arp;
      const f = arp[(musicStep / cfg.arpEvery) % arp.length | 0] || arp[0];
      musicTone(now, { type: 'square', freq: f, dur: cfg.stepMs / 1000 * 0.7, gain: cfg.arpGain });
      // sparse low octave echo every few steps for body
      if (musicStep % (cfg.arpEvery * 4) === 0) {
        musicTone(now, { type: 'triangle', freq: f / 2, dur: cfg.stepMs / 1000 * 1.2, gain: cfg.arpGain * 0.6 });
      }
    }

    musicStep++;
    musicTimer = setTimeout(musicStepTick, cfg.stepMs);
  } catch (e) {
    // never throw; let the loop die gracefully on error
  }
}

function startMusicInternal() {
  if (musicOn) return;
  if (!ctx || !unlocked) return; // music starts only after unlock
  musicOn = true;
  musicStep = 0;
  startPad();
  // fade the music bus in
  try {
    const t = ctx.currentTime;
    musicGain.gain.cancelScheduledValues(t);
    musicGain.gain.setValueAtTime(Math.max(0.0001, musicGain.gain.value || 0.0001), t);
    musicGain.gain.exponentialRampToValueAtTime(MUSIC_GAIN, t + 1.2);
  } catch (e) {}
  if (musicTimer) { clearTimeout(musicTimer); musicTimer = null; }
  musicStepTick();
}

function stopMusicInternal() {
  if (!musicOn && !musicTimer && !padOsc) return;
  musicOn = false;
  if (musicTimer) { clearTimeout(musicTimer); musicTimer = null; }
  try {
    if (ctx && musicGain) {
      const t = ctx.currentTime;
      musicGain.gain.cancelScheduledValues(t);
      musicGain.gain.setValueAtTime(Math.max(0.0001, musicGain.gain.value || 0.0001), t);
      musicGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    }
  } catch (e) {}
  stopPad();
}

// Apply a requested music scene. If not unlocked yet, remember it and start on unlock.
function applyMusicScene(scene) {
  if (scene !== 'menu' && scene !== 'game' && scene !== 'none') return;
  pendingScene = scene;
  if (!ctx || !unlocked) return; // deferred until unlock (onUnlocked re-applies)
  if (scene === 'none') {
    musicScene = 'none';
    stopMusicInternal();
    return;
  }
  musicScene = scene;
  if (!musicOn) {
    startMusicInternal();
  } else {
    // cross-change: the step loop will pick up the new scene config on its next tick. Nudge the
    // music bus back to full in case it was mid-fade.
    try {
      const t = ctx.currentTime;
      musicGain.gain.cancelScheduledValues(t);
      musicGain.gain.setValueAtTime(Math.max(0.0001, musicGain.gain.value || 0.0001), t);
      musicGain.gain.exponentialRampToValueAtTime(MUSIC_GAIN, t + 0.6);
    } catch (e) {}
  }
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------
export const SFX = {
  // Play a named sound. Never throws; no-ops if audio is unavailable, still suspended, or muted.
  play(name) {
    try {
      if (muted) return;
      const recipe = RECIPES[name];
      if (!recipe) return; // unknown name → silent no-op
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

  // --- sustained charge tone ---
  startCharge() {
    try {
      if (muted) return;
      const c = ensureContext();
      if (!c) return;
      if (c.state === 'suspended') {
        resume();
        if (c.state === 'suspended') return;
      }
      startChargeInternal();
    } catch (e) {}
  },
  setChargeLevel(p01) {
    try {
      if (!chargeOsc || !ctx) return;
      const t = ctx.currentTime;
      const f = chargeFreqFor(p01);
      chargeOsc.frequency.cancelScheduledValues(t);
      chargeOsc.frequency.setValueAtTime(Math.max(1, chargeOsc.frequency.value || CHARGE_F0), t);
      chargeOsc.frequency.linearRampToValueAtTime(Math.max(1, f), t + 0.05);
      if (chargeOsc2) {
        chargeOsc2.frequency.cancelScheduledValues(t);
        chargeOsc2.frequency.setValueAtTime(Math.max(1, chargeOsc2.frequency.value || CHARGE_F0 * 2), t);
        chargeOsc2.frequency.linearRampToValueAtTime(Math.max(1, f * 2.01), t + 0.05);
      }
    } catch (e) {}
  },
  stopCharge() {
    try {
      stopChargeInternal();
    } catch (e) {}
  },

  // --- background music ---
  musicScene(scene) {
    try {
      applyMusicScene(scene);
    } catch (e) {}
  },
  startMusic() {
    try {
      ensureContext();
      // default to menu bed if no scene chosen yet
      applyMusicScene(pendingScene === 'none' ? 'menu' : pendingScene);
    } catch (e) {}
  },
  stopMusic() {
    try {
      pendingScene = 'none';
      musicScene = 'none';
      stopMusicInternal();
    } catch (e) {}
  },

  // --- mute (persisted) ---
  setMuted(m) {
    try {
      muted = !!m;
      writeMuted(muted);
      ensureContext();
      applyMute();
      if (muted) {
        // hard-silence sustained voices too
        stopChargeInternal();
      } else if (unlocked) {
        // restore music if a scene was active and we have a context
        if (pendingScene && pendingScene !== 'none') applyMusicScene(pendingScene);
      }
    } catch (e) {}
  },
  toggleMute() {
    try {
      this.setMuted(!muted);
    } catch (e) {}
    return muted;
  },
  isMuted() {
    return !!muted;
  },
};

export default SFX;
