// local.js — LOCAL HOTSEAT driver.
//
// Impersonates the server entirely client-side so 2-4 players can share one
// keyboard and take turns. It mirrors server/game.js's turn engine faithfully
// using the shared deterministic sim, and emits THE EXACT SAME message shapes
// the server sends ('start', 'shot', 'turn') through the net event emitter so
// the existing Game scene and UI run unchanged.
//
//   import { startLocalGame } from '/js/local.js';
//   startLocalGame(net, ['ALICE', 'BOB']);
//
// Interception: while a local game is active, `net.local` points at this driver
// (via net.local = { handle }). net.send() routes outgoing 'fire'/'rematch'
// here instead of the WebSocket (see net.js). The driver emits results back
// with net.emit(type, payload).
//
// KEY TRICK: before emitting any message that establishes whose turn it is
// ('start', 'shot' with `next`, 'turn'), we set net.you = <current turn id>.
// The existing Game scene treats the active hotseat player as "you" and unlocks
// input. Because everyone shares the screen, this is exactly what we want.

import {
  generateTerrain,
  placePlayers,
  simulateShot,
  applyCrater,
  settlePlayers,
} from '/shared/sim.js';

import {
  WIND_MAX,
  ANGLE_MIN,
  ANGLE_MAX,
  POWER_MIN,
  POWER_MAX,
  PLAYER_HP,
  TURN_MS,
  NAME_MAX_LEN,
} from '/shared/constants.js';

// Clamp helper (mirrors server/game.js): non-finite ⇒ lo.
function clamp(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

// Wind: uniform in [-WIND_MAX, WIND_MAX] rounded to 1 decimal (mirrors server).
function rollWind() {
  const w = (Math.random() * 2 - 1) * WIND_MAX;
  return Math.round(w * 10) / 10;
}

// Sanitize a single name candidate: trim, strip control chars, cap length,
// uppercase. Empty ⇒ caller supplies a 'PLAYER N' default.
function cleanName(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .toUpperCase()
    .slice(0, NAME_MAX_LEN);
}

// Normalize the names array to 2-4 sanitized names with PLAYER N defaults.
function normalizeNames(names) {
  const arr = Array.isArray(names) ? names.slice(0, 4) : [];
  while (arr.length < 2) arr.push('');
  return arr.map((n, i) => cleanName(n) || 'PLAYER ' + (i + 1));
}

class LocalGame {
  constructor(net, names) {
    this.net = net;
    this.names = normalizeNames(names);

    // Canonical mutable world state, rebuilt on every start/rematch.
    this.seed = 0;
    this.heights = null;

    // Per-player physical state keyed by id ('local_0'..'local_3').
    //   { id, x, y, hp, alive }
    this.units = new Map();
    // Static roster for the start payload: { id, name, colorIdx }.
    this.roster = [];
    // Turn order = player ids in roster order.
    this.order = [];

    this.turn = null;
    this.wind = 0;
    this.turnEndsAt = 0;
    this.turnTimer = null;

    this.state = 'idle';     // 'idle' | 'playing' | 'over'
    this.resolving = false;
  }

  // --- timer management (mirrors server/game.js) ---------------------------

  clearTimer() {
    if (this.turnTimer !== null) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
  }

  armTimer() {
    this.clearTimer();
    this.turnEndsAt = Date.now() + TURN_MS;
    const forId = this.turn;
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      this.onTimeout(forId);
    }, TURN_MS);
  }

  // --- helpers -------------------------------------------------------------

  aliveIds() {
    const out = [];
    for (const id of this.order) {
      const u = this.units.get(id);
      if (u && u.alive) out.push(id);
    }
    return out;
  }

  nextAliveAfter(fromId) {
    const n = this.order.length;
    if (n === 0) return null;
    let startIdx = 0;
    if (fromId != null) {
      const i = this.order.indexOf(fromId);
      startIdx = i === -1 ? 0 : i + 1;
    }
    for (let step = 0; step < n; step++) {
      const idx = (startIdx + step) % n;
      const id = this.order[idx];
      const u = this.units.get(id);
      if (u && u.alive) return id;
    }
    return null;
  }

  startPlayersPayload() {
    const players = [];
    for (const r of this.roster) {
      const u = this.units.get(r.id);
      if (!u) continue;
      players.push({
        id: r.id,
        name: r.name,
        colorIdx: r.colorIdx,
        x: u.x,
        y: u.y,
        hp: u.hp,
      });
    }
    return players;
  }

  simPlayers() {
    const arr = [];
    for (const id of this.order) {
      const u = this.units.get(id);
      if (!u) continue;
      arr.push({ id: u.id, x: u.x, y: u.y, hp: u.hp, alive: u.alive });
    }
    return arr;
  }

  // --- lifecycle -----------------------------------------------------------

  // Build a fresh world from the roster and begin play (also used by rematch).
  start() {
    this.clearTimer();
    this.resolving = false;

    // Build the static roster once (ids/colors are stable across rematches).
    if (this.roster.length === 0) {
      this.roster = this.names.map((name, i) => ({
        id: 'local_' + i,
        name,
        colorIdx: i,
      }));
      this.order = this.roster.map((r) => r.id);
    }

    this.seed = (Math.random() * 2 ** 31) | 0;
    this.heights = generateTerrain(this.seed);

    const n = this.order.length;
    const positions = placePlayers(this.heights, n, this.seed);

    this.units.clear();
    for (let i = 0; i < n; i++) {
      const id = this.order[i];
      const pos = positions[i] || { x: 0, y: 0 };
      this.units.set(id, {
        id,
        x: pos.x,
        y: pos.y,
        hp: PLAYER_HP,
        alive: true,
      });
    }

    // Random first turn among players (mirrors server).
    this.turn = this.order[(Math.random() * n) | 0] || this.order[0] || null;
    this.wind = rollWind();

    this.state = 'playing';
    this.armTimer();

    // KEY TRICK: active hotseat player becomes "you" so the scene unlocks input.
    this.net.you = this.turn;

    this.net.emit('start', {
      t: 'start',
      seed: this.seed,
      players: this.startPlayersPayload(),
      turn: this.turn,
      wind: this.wind,
      turnEndsAt: this.turnEndsAt,
      // Tells the Game scene + UI this is a hotseat game (does not affect the
      // online payload shape — online never sets it).
      local: true,
    });
  }

  // Host-equivalent rematch (only meaningful in 'over' state): fresh
  // seed/terrain/positions/hp, same roster + names.
  rematch() {
    if (this.state !== 'over') return false;
    this.start();
    return true;
  }

  // --- intent routing (called from net.send via net.local.handle) ----------

  handle(obj) {
    if (!obj || typeof obj.t !== 'string') return;
    if (obj.t === 'fire') {
      this.fire(this.turn, obj.angle, obj.power);
    } else if (obj.t === 'rematch') {
      this.rematch();
    }
  }

  // --- firing (mirrors server/game.js) -------------------------------------

  fire(shooterId, rawAngle, rawPower) {
    if (this.state !== 'playing') return;
    if (this.resolving) return;
    if (shooterId !== this.turn) return;

    const shooter = this.units.get(shooterId);
    if (!shooter || !shooter.alive) return;

    const angle = clamp(rawAngle, ANGLE_MIN, ANGLE_MAX);
    const power = clamp(rawPower, POWER_MIN, POWER_MAX);

    const firedWind = this.wind;

    this.resolving = true;
    this.clearTimer();

    let result;
    try {
      result = simulateShot({
        shooterId,
        x: shooter.x,
        y: shooter.y,
        angle,
        power,
        wind: firedWind,
        heights: this.heights,
        players: this.simPlayers(),
      });
    } catch (err) {
      result = { trajectory: [], impact: null, crater: null, hits: [] };
    }

    const trajectory = Array.isArray(result.trajectory) ? result.trajectory : [];
    const impact = result.impact || null;
    const crater = result.crater || null;
    const rawHits = Array.isArray(result.hits) ? result.hits : [];

    if (crater) {
      try {
        applyCrater(this.heights, crater);
      } catch (err) {
        /* defensive: bad crater shape never breaks the turn */
      }
    }

    const hits = [];
    const deaths = [];
    for (const h of rawHits) {
      if (!h || h.id == null) continue;
      const u = this.units.get(h.id);
      if (!u || !u.alive) continue;
      const dmg = Math.max(0, Math.round(Number(h.dmg) || 0));
      const wasAlive = u.alive;
      u.hp = Math.max(0, u.hp - dmg);
      u.alive = u.hp > 0;
      hits.push({ id: u.id, dmg, hp: u.hp });
      if (wasAlive && !u.alive) deaths.push(u.id);
    }

    let settled = [];
    try {
      const moved = settlePlayers(this.heights, this.simPlayers());
      if (Array.isArray(moved)) {
        for (const m of moved) {
          if (!m || m.id == null) continue;
          const u = this.units.get(m.id);
          if (!u) continue;
          u.y = m.y;
          settled.push({ id: m.id, y: m.y });
        }
      }
    } catch (err) {
      settled = [];
    }

    const aliveAfter = this.aliveIds();
    let winner = null;
    let draw = false;
    let next = null;

    if (aliveAfter.length <= 1) {
      this.state = 'over';
      this.resolving = false;
      this.clearTimer();
      this.turn = null;
      if (aliveAfter.length === 1) {
        winner = aliveAfter[0];
      } else {
        draw = true;
      }
    } else {
      this.turn = this.nextAliveAfter(shooterId);
      this.wind = rollWind();
      this.armTimer();
      next = { turn: this.turn, wind: this.wind, turnEndsAt: this.turnEndsAt };
      this.resolving = false;
      // KEY TRICK: hand control to the next hotseat player.
      this.net.you = this.turn;
    }

    this.net.emit('shot', {
      t: 'shot',
      shooterId,
      angle,
      power,
      wind: firedWind,
      trajectory,
      result: { impact, crater, hits, deaths, settled },
      next,
      winner,
      draw,
    });
  }

  // --- timeout (mirrors server/game.js) ------------------------------------

  onTimeout(forId) {
    if (this.state !== 'playing') return;
    if (this.resolving) return;
    if (forId !== this.turn) return;

    const skipped = this.turn;
    const fresh = this.nextAliveAfter(skipped);

    const aliveNow = this.aliveIds();
    if (aliveNow.length <= 1) {
      this.state = 'over';
      this.clearTimer();
      this.turn = null;
      const winner = aliveNow.length === 1 ? aliveNow[0] : null;
      // Mirror the server: reuse the 'left' terminal shape to end the game.
      this.net.emit('left', {
        t: 'left',
        id: null,
        name: '',
        next: null,
        winner,
        draw: winner === null,
      });
      return;
    }

    this.turn = fresh;
    this.wind = rollWind();
    this.armTimer();
    // KEY TRICK: skipped turn hands control to the next hotseat player.
    this.net.you = this.turn;

    this.net.emit('turn', {
      t: 'turn',
      turn: this.turn,
      wind: this.wind,
      turnEndsAt: this.turnEndsAt,
      skipped,
    });
  }

  // --- teardown ------------------------------------------------------------

  destroy() {
    this.clearTimer();
    this.units.clear();
    this.order = [];
    this.heights = null;
    this.turn = null;
    this.state = 'idle';
    if (this.net.local === this) this.net.local = null;
  }
}

// The single active local game (if any). Exposed so callers can tear it down.
let activeLocal = null;

/**
 * startLocalGame(net, names) — begin a local hotseat game.
 *
 * @param {object} net   the net singleton (from /js/net.js)
 * @param {string[]} names  2-4 player names (sanitized internally; defaults
 *                          PLAYER 1..PLAYER 4)
 * @returns {LocalGame}  the active driver (its rematch()/destroy() are usable)
 */
export function startLocalGame(net, names) {
  // Tear down any prior local game first.
  if (activeLocal) {
    try { activeLocal.destroy(); } catch (err) { /* ignore */ }
    activeLocal = null;
  }

  const game = new LocalGame(net, names);
  activeLocal = game;

  // Install the interception hook: net.send routes 'fire'/'rematch' here.
  net.local = { handle: (obj) => game.handle(obj) };

  game.start();
  return game;
}

/** True while a local hotseat game is the active net handler. */
export function isLocalActive() {
  return activeLocal != null && activeLocal.net && activeLocal.net.local != null;
}

/** The active LocalGame driver, or null. */
export function getLocalGame() {
  return activeLocal;
}
