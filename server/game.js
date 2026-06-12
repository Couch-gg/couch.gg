// server/game.js — turn engine. One Game instance per room.
//
// Server-authoritative: owns the canonical terrain heightmap, player physical
// state (x/y/hp/alive), whose turn it is, the wind, and the turn timer. Runs
// the shared deterministic sim for every shot and broadcasts the full result.

import {
  generateTerrain,
  placePlayers,
  simulateShot,
  applyCrater,
  settlePlayers,
} from '../shared/sim.js';

import {
  WIND_MAX,
  ANGLE_MIN,
  ANGLE_MAX,
  POWER_MIN,
  POWER_MAX,
  PLAYER_HP,
  TURN_MS,
  MIN_PLAYERS,
} from '../shared/constants.js';

// Clamp helper. Returns `lo` for NaN/non-finite input so malformed messages
// can never inject garbage into the sim.
function clamp(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

// Wind: uniform in [-WIND_MAX, WIND_MAX] rounded to 1 decimal.
function rollWind() {
  const w = (Math.random() * 2 - 1) * WIND_MAX;
  return Math.round(w * 10) / 10;
}

export class Game {
  // `room` is the owning Room (provides players Map + broadcast). We keep a
  // reference rather than copying so host/membership stays in sync.
  constructor(room) {
    this.room = room;

    // Canonical mutable world state, rebuilt on every start/rematch.
    this.seed = 0;
    this.heights = null;

    // Authoritative per-player physics state, keyed by player id.
    //   { id, x, y, hp, alive }
    // Built from the room's join order at start time.
    this.units = new Map();

    // Turn order = array of player ids in join order (stable for a game).
    this.order = [];

    this.turn = null;        // id of the player whose turn it is
    this.wind = 0;
    this.turnEndsAt = 0;     // epoch ms
    this.turnTimer = null;   // setTimeout handle

    // Guards against firing while a shot is being processed and re-entrancy.
    this.resolving = false;
  }

  get state() {
    return this.room.state;
  }

  // --- timer management -----------------------------------------------------

  clearTimer() {
    if (this.turnTimer !== null) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
  }

  // Arm the turn timer for the current `this.turn`. Sets turnEndsAt.
  armTimer() {
    this.clearTimer();
    this.turnEndsAt = Date.now() + TURN_MS;
    const forId = this.turn;
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      this.onTimeout(forId);
    }, TURN_MS);
  }

  // Fully tear down — called on room destruction / game disposal.
  destroy() {
    this.clearTimer();
    this.units.clear();
    this.order = [];
    this.heights = null;
    this.turn = null;
  }

  // --- helpers --------------------------------------------------------------

  aliveIds() {
    const out = [];
    for (const id of this.order) {
      const u = this.units.get(id);
      if (u && u.alive) out.push(id);
    }
    return out;
  }

  aliveCount() {
    let n = 0;
    for (const u of this.units.values()) if (u.alive) n++;
    return n;
  }

  // Next alive player after `fromId` in turn order (wrapping). Returns null if
  // none alive. If `fromId` is null, returns the first alive in order.
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

  // Snapshot of players for the `start` message (authoritative spawn state).
  startPlayersPayload() {
    const players = [];
    for (const id of this.order) {
      const p = this.room.players.get(id);
      const u = this.units.get(id);
      if (!p || !u) continue;
      players.push({
        id,
        name: p.name,
        colorIdx: p.colorIdx,
        x: u.x,
        y: u.y,
        hp: u.hp,
      });
    }
    return players;
  }

  // The `players` array passed into the sim (only physical fields).
  simPlayers() {
    const arr = [];
    for (const id of this.order) {
      const u = this.units.get(id);
      if (!u) continue;
      arr.push({ id: u.id, x: u.x, y: u.y, hp: u.hp, alive: u.alive });
    }
    return arr;
  }

  // --- lifecycle ------------------------------------------------------------

  // Build a fresh world from the current room roster and begin play.
  start() {
    this.clearTimer();
    this.resolving = false;

    this.seed = (Math.random() * 2 ** 31) | 0;
    this.heights = generateTerrain(this.seed);

    // Turn / placement order = room join order (insertion order of the Map).
    this.order = Array.from(this.room.players.keys());
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

    // Random first turn among players.
    this.turn = this.order[(Math.random() * n) | 0] || this.order[0] || null;
    this.wind = rollWind();

    this.room.state = 'playing';
    this.armTimer();

    this.room.broadcast({
      t: 'start',
      seed: this.seed,
      players: this.startPlayersPayload(),
      turn: this.turn,
      wind: this.wind,
      turnEndsAt: this.turnEndsAt,
    });
  }

  // Host-triggered rematch: fresh everything, same roster.
  rematch() {
    if (this.state !== 'over') return false;
    if (this.room.players.size < MIN_PLAYERS) return false;
    this.start();
    return true;
  }

  // --- firing ---------------------------------------------------------------

  // Handle a `fire` from a player. Only the current player, only while
  // 'playing', only when not mid-resolution. Inputs clamped. Never throws.
  fire(shooterId, rawAngle, rawPower) {
    if (this.state !== 'playing') return;
    if (this.resolving) return;
    if (shooterId !== this.turn) return;

    const shooter = this.units.get(shooterId);
    if (!shooter || !shooter.alive) return;

    const angle = clamp(rawAngle, ANGLE_MIN, ANGLE_MAX);
    const power = clamp(rawPower, POWER_MIN, POWER_MAX);

    // The wind this shot is fired with — captured before we roll a new one for
    // the next turn. This is what goes into the `shot` message.
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
      // Sim blew up on some edge case — treat as a harmless miss so the game
      // can continue rather than wedging the room.
      result = { trajectory: [], impact: null, crater: null, hits: [] };
    }

    const trajectory = Array.isArray(result.trajectory) ? result.trajectory : [];
    const impact = result.impact || null;
    const crater = result.crater || null;
    const rawHits = Array.isArray(result.hits) ? result.hits : [];

    // Apply crater to the authoritative heightmap.
    if (crater) {
      try {
        applyCrater(this.heights, crater);
      } catch (err) {
        /* defensive: bad crater shape never breaks the turn */
      }
    }

    // Apply damage. Build the broadcast `hits` (with post-damage hp) and the
    // list of deaths caused by this shot.
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

    // Settle any players left floating after terrain destruction.
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

    // Determine game-over: 0 alive ⇒ draw, 1 alive ⇒ winner.
    const aliveAfter = this.aliveIds();
    let winner = null;
    let draw = false;
    let next = null;

    if (aliveAfter.length <= 1) {
      // Game over.
      this.room.state = 'over';
      this.resolving = false;
      this.clearTimer();
      this.turn = null;
      if (aliveAfter.length === 1) {
        winner = aliveAfter[0];
      } else {
        draw = true;
      }
    } else {
      // Advance to next alive player (skipping the shooter and the dead).
      this.turn = this.nextAliveAfter(shooterId);
      this.wind = rollWind();
      this.armTimer();
      next = { turn: this.turn, wind: this.wind, turnEndsAt: this.turnEndsAt };
      this.resolving = false;
    }

    this.room.broadcast({
      t: 'shot',
      shooterId,
      angle,
      power,
      wind: firedWind, // the wind this shot was fired with
      trajectory,
      result: { impact, crater, hits, deaths, settled },
      next, // null when game over
      winner, // id of last alive, or null
      draw, // true if all dead
    });
  }

  // --- timeout --------------------------------------------------------------

  // Turn ran out of time. Skip to the next alive player. `forId` guards
  // against a stale timer firing after the turn already changed.
  onTimeout(forId) {
    if (this.state !== 'playing') return;
    if (this.resolving) return;
    if (forId !== this.turn) return;

    const skipped = this.turn;
    const fresh = this.nextAliveAfter(skipped);

    // If somehow nobody (else) is alive, end the game.
    const aliveNow = this.aliveIds();
    if (aliveNow.length <= 1) {
      this.room.state = 'over';
      this.clearTimer();
      this.turn = null;
      // Broadcast a terminal message so clients trigger their game-over path
      // rather than wedging. Reuse the `left` shape (which carries winner +
      // next:null and the clients' handlers accept): nobody actually "left",
      // but `id` of null + the winner field cleanly ends the game everywhere.
      const winner = aliveNow.length === 1 ? aliveNow[0] : null;
      this.room.broadcast({
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

    this.room.broadcast({
      t: 'turn',
      turn: this.turn,
      wind: this.wind,
      turnEndsAt: this.turnEndsAt,
      skipped,
    });
  }

  // --- disconnect handling --------------------------------------------------

  // A player left while a game is active ('playing' or 'over'). Mark their
  // unit dead and removed. Returns a payload describing the consequence so the
  // room can broadcast a `left`. The room is responsible for removing the
  // player from its roster BEFORE or AFTER calling this — we only touch game
  // state here.
  //
  // Returns: { next: {turn,wind,turnEndsAt}|null, winner: id|null }
  handleLeave(leftId) {
    const out = { next: null, winner: null };

    const u = this.units.get(leftId);
    if (u) {
      u.alive = false;
      u.hp = 0;
    }

    if (this.state !== 'playing') {
      // In 'over' state nothing turn-related to do.
      return out;
    }

    const wasTheirTurn = leftId === this.turn;
    const aliveNow = this.aliveIds();

    if (aliveNow.length <= 1) {
      // Game over by attrition.
      this.room.state = 'over';
      this.clearTimer();
      this.turn = null;
      out.winner = aliveNow.length === 1 ? aliveNow[0] : null;
      return out;
    }

    // If the leaver was the current player, advance the turn and roll new wind.
    if (wasTheirTurn && !this.resolving) {
      this.turn = this.nextAliveAfter(leftId);
      this.wind = rollWind();
      this.armTimer();
      out.next = {
        turn: this.turn,
        wind: this.wind,
        turnEndsAt: this.turnEndsAt,
      };
    }

    return out;
  }
}
