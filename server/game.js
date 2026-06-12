// server/game.js — turn engine. One Game instance per room.
//
// Server-authoritative: owns the canonical terrain heightmap, player physical
// state (x/y/hp/alive), the destructible castle blocks, whose turn it is, the
// wind, and the turn timer. Runs the shared deterministic sim for every shot
// and broadcasts the full result.
//
// V2 SIEGE UPDATE (CONTRACT §7):
//  - Launch angles are clamped to the trebuchet ELEVATION band (the sim's
//    clampElevation), not the dead ANGLE_MIN/ANGLE_MAX. Right side =
//    [ELEV_MIN..ELEV_MAX]; left side = [180-ELEV_MAX..180-ELEV_MIN]. Invalid /
//    NaN angles snap to the nearest valid bound (NaN -> ELEV_MIN rightward).
//  - Castles: two flanking stone towers per player, built right after
//    placePlayers (deterministic, via the sim's buildCastles). Projectiles can
//    strike them; struck/blasted/collapsed blocks bleed their OWNER hp
//    (CASTLE_DMG_PER_BLOCK, capped) — resolved by the sim's resolveCastleDamage.
//  - Plunging fire: the sim returns a `plunge` multiplier; it rides through in
//    the shot message so clients can show it.

import {
  generateTerrain,
  placePlayers,
  buildCastles,
  simulateShot,
  applyCrater,
  settlePlayers,
  resolveCastleDamage,
  clampElevation,
} from '../shared/sim.js';

import {
  WIND_MAX,
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

    // Authoritative castle state: ordered array aligned to `this.order`.
    //   castles[i] = { id, blocks: [{ x, y, w:1, h:1 }, ...] }
    // The sim marks destroyed cells with block.destroyed = true; the block
    // index identifies a cell forever, so clients mirror destroyed indices.
    this.castles = [];

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
    this.castles = [];
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

    // Castles: built immediately after placePlayers from the same positions, in
    // the same order, so server/clients/local driver stay identical. We pass the
    // owner id on each position so the sim stamps castles[i].id for us.
    this.buildCastlesState(positions);

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

  // Build authoritative castle state from spawn positions, tagging each position
  // with its owner id so the sim stamps castles[i].id. Clients rebuild the same
  // castles from the seed-derived positions, so we do NOT send block geometry in
  // `start`; only destroyed indices flow later via shot.result.castleHits.
  buildCastlesState(positions) {
    this.castles = [];
    let built = [];
    try {
      const posList = positions.map((p, i) => ({
        x: p.x,
        y: p.y,
        id: this.order[i],
      }));
      built = buildCastles(this.heights, posList) || [];
    } catch (err) {
      built = [];
    }
    // Normalize and guarantee every order slot has a castle with the right id,
    // even if the sim returned fewer entries for some reason.
    for (let i = 0; i < this.order.length; i++) {
      const id = this.order[i];
      const c = built[i] || { blocks: [] };
      const blocks = Array.isArray(c.blocks) ? c.blocks : [];
      this.castles.push({ id, blocks });
    }
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

    // Angle clamps to the trebuchet elevation band (V2) — use the sim's exact
    // clamp so the angle we broadcast matches the one the sim simulated. Power
    // clamps to [MIN, MAX].
    const angle = clampElevation(rawAngle);
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
        castles: this.castles,
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
    // `plunge` rides through to clients (CONTRACT §7.2) when the sim provides it.
    const plunge = typeof result.plunge === 'number' ? result.plunge : undefined;

    // Apply crater to the authoritative heightmap FIRST so castle collapse and
    // player settling both see the post-crater terrain.
    if (crater) {
      try {
        applyCrater(this.heights, crater);
      } catch (err) {
        /* defensive: bad crater shape never breaks the turn */
      }
    }

    // Resolve castle block destruction (CONTRACT §7.5) — blast radius + post-
    // crater floating collapse + per-owner scoring, all in the sim's helper.
    // Must run AFTER applyCrater. Returns castleHits WITHOUT hp (we add hp once
    // all damage is committed so blast + castle damage share one final value).
    let rawCastleHits = [];
    try {
      const cres = resolveCastleDamage(this.castles, impact, this.heights);
      if (cres && Array.isArray(cres.castleHits)) rawCastleHits = cres.castleHits;
    } catch (err) {
      rawCastleHits = [];
    }

    // Tally blast damage per id (do NOT commit yet — hp must reflect ALL of this
    // shot's damage, blast + castle).
    const blastDmg = new Map(); // id -> total blast dmg
    for (const h of rawHits) {
      if (!h || h.id == null) continue;
      const u = this.units.get(h.id);
      if (!u || !u.alive) continue;
      const dmg = Math.max(0, Math.round(Number(h.dmg) || 0));
      blastDmg.set(h.id, (blastDmg.get(h.id) || 0) + dmg);
    }

    // Tally castle damage per owner (the sim already applied the cap + ceil).
    const castleDmg = new Map(); // id -> castle dmg
    for (const ch of rawCastleHits) {
      if (!ch || ch.id == null) continue;
      const dmg = Math.max(0, Math.round(Number(ch.dmg) || 0));
      castleDmg.set(ch.id, (castleDmg.get(ch.id) || 0) + dmg);
    }

    // Commit all damage to hp atomically, then derive each affected player's
    // final hp. A player may die from castle damage alone (deaths covers both).
    const deaths = [];
    const finalHp = new Map(); // id -> hp after ALL of this shot's damage
    const affected = new Set([...blastDmg.keys(), ...castleDmg.keys()]);
    for (const id of affected) {
      const u = this.units.get(id);
      if (!u || !u.alive) continue;
      const total = (blastDmg.get(id) || 0) + (castleDmg.get(id) || 0);
      const wasAlive = u.alive;
      u.hp = Math.max(0, u.hp - total);
      u.alive = u.hp > 0;
      finalHp.set(id, u.hp);
      if (wasAlive && !u.alive) deaths.push(id);
    }

    // Final hp for any id (post-ALL-damage); affected ids resolve from finalHp,
    // others fall back to current authoritative hp.
    const hpFor = (id) => {
      if (finalHp.has(id)) return finalHp.get(id);
      const u = this.units.get(id);
      return u ? u.hp : 0;
    };

    // Build the broadcast `hits` (blast-only) with post-ALL-damage hp.
    const hits = [];
    for (const h of rawHits) {
      if (!h || h.id == null) continue;
      if (!blastDmg.has(h.id)) continue; // skip non-alive / zero-dmg entries
      const dmg = Math.max(0, Math.round(Number(h.dmg) || 0));
      hits.push({ id: h.id, dmg, hp: hpFor(h.id) });
    }

    // Build `castleHits` (with post-ALL-damage hp). When a player takes both
    // blast and castle damage, hits[].hp and castleHits[].hp are the same value.
    const castleHits = [];
    for (const ch of rawCastleHits) {
      if (!ch || ch.id == null) continue;
      const dmg = Math.max(0, Math.round(Number(ch.dmg) || 0));
      const blocks = Array.isArray(ch.blocks) ? ch.blocks.slice() : [];
      castleHits.push({ id: ch.id, dmg, hp: hpFor(ch.id), blocks });
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

    const resultOut = { impact, crater, hits, castleHits, deaths, settled };
    if (plunge !== undefined) resultOut.plunge = plunge;

    this.room.broadcast({
      t: 'shot',
      shooterId,
      angle,
      power,
      wind: firedWind, // the wind this shot was fired with
      trajectory,
      result: resultOut,
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
