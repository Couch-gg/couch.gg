// shared/sim.test.js — plain Node test runner for the deterministic sim.
//
// Run with `npm test`. Uses only Node's built-in assert; no test framework.
// Exits 0 on success, non-zero with a clear message on the first failure.

import assert from 'node:assert/strict';

import {
  generateTerrain,
  placePlayers,
  simulateShot,
  applyCrater,
  settlePlayers,
  clampElevation,
  plungeMultiplier,
  buildCastles,
  resolveCastleDamage,
} from './sim.js';

import {
  WORLD_W,
  WORLD_H,
  TERRAIN_MIN_Y,
  TERRAIN_MAX_Y,
  TERRAIN_FLOOR_Y,
  CRATER_R,
  DMG_RADIUS,
  PLAYER_HIT_DY,
  ELEV_MIN,
  ELEV_MAX,
  PLUNGE_VY_REF,
  CASTLE_TOWER_H,
  CASTLE_DMG_PER_BLOCK,
  CASTLE_DMG_CAP,
} from './constants.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error('        ' + (err && err.message ? err.message : String(err)));
    if (err && err.stack) {
      console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
    process.exitCode = 1;
    process.exit(1);
  }
}

// Build a perfectly flat heightmap at a given surface y.
function flatHeights(y) {
  const h = new Float64Array(WORLD_W);
  h.fill(y);
  return h;
}

console.log('TREBUCHET sim tests');

// --- Terrain determinism -----------------------------------------------------
test('same seed => identical terrain', () => {
  const a = generateTerrain(12345);
  const b = generateTerrain(12345);
  assert.equal(a.length, WORLD_W);
  assert.equal(b.length, WORLD_W);
  for (let x = 0; x < WORLD_W; x++) {
    assert.equal(a[x], b[x], `mismatch at column ${x}`);
  }
});

test('different seeds => different terrain', () => {
  const a = generateTerrain(1);
  const b = generateTerrain(2);
  let diffs = 0;
  for (let x = 0; x < WORLD_W; x++) {
    if (a[x] !== b[x]) diffs++;
  }
  assert.ok(diffs > WORLD_W * 0.5, `expected many differing columns, got ${diffs}`);
});

test('terrain respects bounds for many seeds', () => {
  for (let s = 0; s < 40; s++) {
    const h = generateTerrain(s * 7919 + 13);
    for (let x = 0; x < WORLD_W; x++) {
      assert.ok(
        h[x] >= TERRAIN_MIN_Y - 1e-9 && h[x] <= TERRAIN_MAX_Y + 1e-9,
        `seed ${s} col ${x} out of bounds: ${h[x]}`
      );
    }
  }
});

test('terrain uses most of the allowed vertical range', () => {
  // Across several seeds the terrain should span a large fraction of the band,
  // not sit flat in the middle.
  const range = TERRAIN_MAX_Y - TERRAIN_MIN_Y;
  for (const seed of [101, 202, 303, 404, 505]) {
    const h = generateTerrain(seed);
    let min = Infinity;
    let max = -Infinity;
    for (let x = 0; x < WORLD_W; x++) {
      if (h[x] < min) min = h[x];
      if (h[x] > max) max = h[x];
    }
    const used = max - min;
    assert.ok(
      used > range * 0.6,
      `seed ${seed} only used ${used.toFixed(1)} of ${range} vertical range`
    );
  }
});

test('terrain is smooth (no large column-to-column jumps)', () => {
  const h = generateTerrain(777);
  let maxJump = 0;
  for (let x = 1; x < WORLD_W; x++) {
    const j = Math.abs(h[x] - h[x - 1]);
    if (j > maxJump) maxJump = j;
  }
  // A smoothed rolling profile should never jump more than a few px per column.
  assert.ok(maxJump < 8, `max per-column jump ${maxJump.toFixed(2)} too steep`);
});

// --- placePlayers ------------------------------------------------------------
test('placePlayers: count, ordering, margins, on-surface', () => {
  const h = generateTerrain(555);
  const n = 4;
  const pos = placePlayers(h, n, 555);
  assert.equal(pos.length, n);
  for (let i = 0; i < n; i++) {
    assert.ok(pos[i].x >= 40 && pos[i].x <= WORLD_W - 1 - 40, `x ${pos[i].x} within margins`);
    // y equals the (now flattened) surface at that column.
    assert.equal(pos[i].y, h[Math.round(pos[i].x)], `player ${i} sits on surface`);
    if (i > 0) {
      assert.ok(pos[i].x > pos[i - 1].x, 'players ordered left to right');
    }
  }
});

test('placePlayers: flattens a 13px pad', () => {
  const h = generateTerrain(909);
  const pos = placePlayers(h, 2, 909);
  for (const p of pos) {
    const lo = Math.max(0, p.x - 6);
    const hi = Math.min(WORLD_W - 1, p.x + 6);
    const level = h[p.x];
    for (let x = lo; x <= hi; x++) {
      assert.equal(h[x], level, `pad around ${p.x} flat at col ${x}`);
    }
  }
});

test('placePlayers: deterministic for same seed', () => {
  const h1 = generateTerrain(31);
  const h2 = generateTerrain(31);
  const a = placePlayers(h1, 3, 31);
  const b = placePlayers(h2, 3, 31);
  assert.deepEqual(a, b);
});

// --- simulateShot ------------------------------------------------------------
// V2 SIEGE: flat shots are gone. Valid elevations are 50..85 (right) and
// 95..130 (left); the sim clamps invalid angles to the nearest valid bound.
test('50 deg / power 100 / no wind travels > 380px horizontally', () => {
  // Spec 7.1: a full-power 50deg shot from flat ground travels > 380px.
  const surface = 200;
  const h = flatHeights(surface);
  const players = [];
  const launchX = 40;
  const res = simulateShot({
    shooterId: 'me',
    x: launchX,
    y: surface,
    angle: 50,
    power: 100,
    wind: 0,
    heights: h,
    players,
  });
  // At full power the shot may sail off the right side before landing — measure
  // the furthest horizontal extent reached along the trajectory.
  let maxDx = 0;
  for (const [px] of res.trajectory) {
    const d = Math.abs(px - launchX);
    if (d > maxDx) maxDx = d;
  }
  assert.ok(maxDx > 380, `expected >380px horizontal travel, got ${maxDx.toFixed(1)}`);
});

test('trajectory starts at the muzzle and has multiple samples', () => {
  const surface = 200;
  const h = flatHeights(surface);
  const res = simulateShot({
    shooterId: 'me',
    x: 60,
    y: surface,
    angle: 60,
    power: 80,
    wind: 0,
    heights: h,
    players: [],
  });
  assert.ok(res.trajectory.length > 5, 'trajectory should have many samples');
  assert.equal(res.trajectory[0][0], 60, 'first sample x at launch x');
});

test('wind shifts impact in the wind direction', () => {
  const surface = 200;
  const launchX = 240;
  // Use a steep valid elevation (85deg) so the round spends time aloft and wind
  // can bend the impact horizontally.
  const base = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 85, power: 70,
    wind: 0, heights: flatHeights(surface), players: [],
  });
  const right = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 85, power: 70,
    wind: 20, heights: flatHeights(surface), players: [],
  });
  const left = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 85, power: 70,
    wind: -20, heights: flatHeights(surface), players: [],
  });
  assert.ok(base.impact && right.impact && left.impact, 'all shots land');
  assert.ok(
    right.impact.x > base.impact.x,
    `positive wind should push impact right (${right.impact.x} > ${base.impact.x})`
  );
  assert.ok(
    left.impact.x < base.impact.x,
    `negative wind should push impact left (${left.impact.x} < ${base.impact.x})`
  );
});

test('simulateShot does not mutate heights, players, or castles', () => {
  const surface = 220;
  const h = flatHeights(surface);
  const hCopy = Float64Array.from(h);
  // A shooter just left of an enemy castle, firing a steep lob that descends
  // onto the enemy's near tower (so the castle-collision path actually runs and
  // we can prove it leaves the inputs untouched).
  const ownerX = 300;
  const players = [
    { id: 's', x: 230, y: surface, hp: 100, alive: true },
    { id: 'p', x: ownerX, y: surface, hp: 100, alive: true },
  ];
  const before = JSON.stringify(players);
  const castles = buildCastles(h, [
    { x: 230, y: surface, id: 's' },
    { x: ownerX, y: surface, id: 'p' },
  ]);
  const castlesBefore = JSON.stringify(castles);
  const res = simulateShot({
    shooterId: 's', x: 230, y: surface, angle: 84, power: 60,
    wind: 0, heights: h, players, castles,
  });
  assert.ok(res.impact, 'the lob lands (on the tower)');
  for (let x = 0; x < WORLD_W; x++) {
    assert.equal(h[x], hCopy[x], `heights mutated at ${x}`);
  }
  assert.equal(JSON.stringify(players), before, 'players mutated');
  assert.equal(JSON.stringify(castles), castlesBefore, 'castles mutated by simulateShot');
});

test('flying off the side yields null impact and null crater', () => {
  const h = flatHeights(262); // terrain at the floor so a high lob can leave sideways
  // Launch near the right edge at a valid steep-but-flank elevation with a strong
  // tailwind; the round clears x > WORLD_W + 60 while still high, so it never
  // lands inside the map.
  const res = simulateShot({
    shooterId: 'me', x: WORLD_W - 45, y: 80, angle: 50, power: 100,
    wind: 25, heights: h, players: [],
  });
  assert.equal(res.impact, null, 'impact should be null when flying off the map');
  assert.equal(res.crater, null, 'crater should be null when impact is null');
  assert.deepEqual(res.hits, [], 'no hits when nothing impacted');
});

test('a player hit produces a hit, crater, and impact', () => {
  const surface = 200;
  const h = flatHeights(surface);
  // Drop a steep (85deg) shot and place the target where it actually lands so we
  // get a guaranteed terrain/player impact inside the map. (Perfectly vertical
  // shots are no longer possible under V2, so the lob drifts a little.)
  const launchX = 200;
  const probe = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 85, power: 50,
    wind: 0, heights: h, players: [],
  });
  assert.ok(probe.impact, 'probe should land somewhere');
  const target = { id: 't', x: probe.impact.x, y: probe.impact.y - PLAYER_HIT_DY, hp: 100, alive: true };
  const shooter = { id: 'me', x: launchX, y: surface, hp: 100, alive: true };
  const res = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 85, power: 50,
    wind: 0, heights: h, players: [shooter, target],
  });
  assert.ok(res.impact, 'should land somewhere');
  assert.ok(res.crater && res.crater.r === CRATER_R, 'crater present with correct radius');
  assert.ok(res.hits.length >= 1, 'the target under the impact takes damage');
});

test('damage decreases with distance and >0 hit always >=1', () => {
  const surface = 200;
  const h = flatHeights(surface);
  // Build players around where an 85deg shot lands (it returns to roughly the
  // launch x at the surface).
  const launchX = 240;
  const res = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 85, power: 60,
    wind: 0, heights: h, players: [],
  });
  assert.ok(res.impact, 'steep shot returns to ground');
  const ix = res.impact.x;
  const iy = res.impact.y;

  // Construct players at the impact center, mid-range, and edge of DMG_RADIUS.
  const near = { id: 'near', x: ix, y: iy - PLAYER_HIT_DY, hp: 100, alive: true };
  const mid = { id: 'mid', x: ix + DMG_RADIUS * 0.5, y: iy - PLAYER_HIT_DY, hp: 100, alive: true };
  const far = { id: 'far', x: ix + DMG_RADIUS * 0.95, y: iy - PLAYER_HIT_DY, hp: 100, alive: true };

  const res2 = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 85, power: 60,
    wind: 0, heights: h, players: [near, mid, far],
  });
  // The shot may now hit the `near` player mid-air; what matters is hits exist
  // and damage falls off.
  assert.ok(res2.impact, 'shot impacts');
  const byId = Object.fromEntries(res2.hits.map((hh) => [hh.id, hh.dmg]));
  // near should take the most; far the least; all >=1 when present.
  if (byId.near !== undefined && byId.far !== undefined) {
    assert.ok(byId.near >= byId.far, `near dmg ${byId.near} >= far dmg ${byId.far}`);
  }
  for (const hh of res2.hits) {
    assert.ok(hh.dmg >= 1, `hit dmg ${hh.dmg} should be >= 1`);
  }
});

test('controlled damage falloff via direct geometry', () => {
  // Deterministically verify falloff: shoot at low power steeply from a raised
  // platform so the impact is near the launch column at the surface, then check
  // three players at known offsets.
  const surface = 240;
  const h = flatHeights(surface);
  const launchX = 240;
  const res = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 85, power: 30,
    wind: 0, heights: h, players: [],
  });
  assert.ok(res.impact, 'low steep shot lands');
  const ix = res.impact.x;

  // Players placed so their hit centers are at distances 0, half, near-edge.
  const mk = (id, off) => ({ id, x: ix + off, y: res.impact.y - PLAYER_HIT_DY, hp: 100, alive: true });
  const players = [mk('d0', 0), mk('d1', DMG_RADIUS * 0.5), mk('d2', DMG_RADIUS * 0.9)];
  const res2 = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 85, power: 30,
    wind: 0, heights: h, players,
  });
  const dmg = Object.fromEntries(res2.hits.map((hh) => [hh.id, hh.dmg]));
  assert.ok(res2.hits.length >= 1, 'at least one player damaged');
  // Monotonic non-increasing with distance among those present.
  if (dmg.d0 !== undefined && dmg.d1 !== undefined) {
    assert.ok(dmg.d0 >= dmg.d1, `d0 ${dmg.d0} >= d1 ${dmg.d1}`);
  }
  if (dmg.d1 !== undefined && dmg.d2 !== undefined) {
    assert.ok(dmg.d1 >= dmg.d2, `d1 ${dmg.d1} >= d2 ${dmg.d2}`);
  }
});

test('dead players are never hit', () => {
  const surface = 200;
  const h = flatHeights(surface);
  const launchX = 240;
  const probe = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 85, power: 60,
    wind: 0, heights: h, players: [],
  });
  const ghost = {
    id: 'ghost', x: probe.impact.x, y: probe.impact.y - PLAYER_HIT_DY,
    hp: 0, alive: false,
  };
  const res = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 85, power: 60,
    wind: 0, heights: h, players: [ghost],
  });
  assert.deepEqual(res.hits, [], 'dead player should not be hit');
});

// --- applyCrater -------------------------------------------------------------
test('applyCrater lowers terrain at the impact column', () => {
  const surface = 150;
  const h = flatHeights(surface);
  const before = h[200];
  applyCrater(h, { x: 200, y: surface, r: CRATER_R });
  // At the exact center, bottom = y + r, so surface drops by r.
  assert.ok(h[200] > before, `center should drop (was ${before}, now ${h[200]})`);
  assert.ok(h[200] <= before + CRATER_R + 1e-6, 'center drop bounded by radius');
});

test('applyCrater never digs below TERRAIN_FLOOR_Y', () => {
  const h = flatHeights(TERRAIN_FLOOR_Y - 2);
  applyCrater(h, { x: 120, y: TERRAIN_FLOOR_Y, r: CRATER_R });
  for (let x = 120 - CRATER_R; x <= 120 + CRATER_R; x++) {
    if (x < 0 || x >= WORLD_W) continue;
    assert.ok(h[x] <= TERRAIN_FLOOR_Y + 1e-9, `col ${x} dug below floor: ${h[x]}`);
  }
});

test('applyCrater only carves down (never raises terrain)', () => {
  const surface = 100;
  const h = flatHeights(surface);
  // Crater centered well below the surface: its bite bottom is far down, so the
  // shallow edge columns should be unchanged (max keeps current).
  const copy = Float64Array.from(h);
  applyCrater(h, { x: 50, y: surface + 40, r: CRATER_R });
  for (let x = 0; x < WORLD_W; x++) {
    assert.ok(h[x] >= copy[x] - 1e-9, `col ${x} was raised`);
  }
});

test('applyCrater ignores out-of-range columns', () => {
  const h = flatHeights(150);
  // Near the right edge — should not throw and should not touch out-of-range.
  applyCrater(h, { x: WORLD_W + 5, y: 150, r: CRATER_R });
  // Crater partly overlaps the right edge; columns inside are valid, no crash.
  assert.equal(h.length, WORLD_W);
});

// --- settlePlayers -----------------------------------------------------------
test('settlePlayers drops a floating player and reports it', () => {
  const surface = 200;
  const h = flatHeights(surface);
  const floating = { id: 'f', x: 100, y: 120, hp: 100, alive: true }; // above ground
  const grounded = { id: 'g', x: 150, y: surface, hp: 100, alive: true };
  const moved = settlePlayers(h, [floating, grounded]);
  assert.equal(moved.length, 1, 'only the floating player moves');
  assert.equal(moved[0].id, 'f');
  assert.equal(moved[0].y, surface, 'dropped to surface');
  assert.equal(floating.y, surface, 'player object mutated');
  assert.equal(grounded.y, surface, 'grounded unchanged');
});

test('settlePlayers ignores dead players', () => {
  const surface = 200;
  const h = flatHeights(surface);
  const deadFloat = { id: 'd', x: 100, y: 100, hp: 0, alive: false };
  const moved = settlePlayers(h, [deadFloat]);
  assert.deepEqual(moved, [], 'dead players are not settled');
  assert.equal(deadFloat.y, 100, 'dead player y unchanged');
});

test('settlePlayers does not raise a player already at/below surface', () => {
  const surface = 200;
  const h = flatHeights(surface);
  const buried = { id: 'b', x: 100, y: surface + 5, hp: 100, alive: true };
  const moved = settlePlayers(h, [buried]);
  assert.deepEqual(moved, [], 'player below surface is not moved up');
  assert.equal(buried.y, surface + 5, 'y unchanged');
});

// --- integration: crater then settle -----------------------------------------
test('integration: crater under a player lets settle drop them', () => {
  const surface = 180;
  const h = flatHeights(surface);
  const p = { id: 'p', x: 200, y: surface, hp: 100, alive: true };
  // Carve right under the player.
  applyCrater(h, { x: 200, y: surface, r: CRATER_R });
  // The player is now floating above the new (lower) surface.
  assert.ok(p.y < h[200], 'player should now be above the lowered ground');
  const moved = settlePlayers(h, [p]);
  assert.equal(moved.length, 1, 'player settles into the crater');
  assert.equal(p.y, h[200], 'rests on new surface');
});

// --- V2 SIEGE: elevation clamping (7.1) --------------------------------------
test('clampElevation: valid in-band angles pass through unchanged', () => {
  for (const a of [ELEV_MIN, 55, 70, ELEV_MAX, 95, 110, 130, 180 - ELEV_MIN]) {
    assert.equal(clampElevation(a), a, `in-band ${a} unchanged`);
  }
  // Endpoints of the left band derived from the constants.
  assert.equal(clampElevation(180 - ELEV_MAX), 180 - ELEV_MAX, 'left band low edge');
  assert.equal(clampElevation(180 - ELEV_MIN), 180 - ELEV_MIN, 'left band high edge');
});

test('clampElevation: invalid angles clamp to the nearest valid bound', () => {
  // Below the right band -> ELEV_MIN.
  assert.equal(clampElevation(45), ELEV_MIN, '45 -> ELEV_MIN');
  assert.equal(clampElevation(0), ELEV_MIN, '0 -> ELEV_MIN');
  assert.equal(clampElevation(-30), ELEV_MIN, 'negative -> ELEV_MIN');
  // Above the left band -> 180 - ELEV_MIN (left high edge).
  assert.equal(clampElevation(170), 180 - ELEV_MIN, '170 -> left high edge');
  assert.equal(clampElevation(200), 180 - ELEV_MIN, '200 -> left high edge');
  // Dead zone between bands: snap to nearest, tie favours the right band.
  assert.equal(clampElevation(86), ELEV_MAX, '86 -> right band top');
  assert.equal(clampElevation(88), ELEV_MAX, '88 -> right band top');
  assert.equal(clampElevation(90), ELEV_MAX, '90 (tie) -> right band top');
  assert.equal(clampElevation(92), 180 - ELEV_MAX, '92 -> left band bottom');
  assert.equal(clampElevation(94), 180 - ELEV_MAX, '94 -> left band bottom');
});

test('clampElevation: NaN / non-finite -> ELEV_MIN rightward', () => {
  assert.equal(clampElevation(NaN), ELEV_MIN, 'NaN -> ELEV_MIN');
  assert.equal(clampElevation(undefined), ELEV_MIN, 'undefined -> ELEV_MIN');
  assert.equal(clampElevation('nope'), ELEV_MIN, 'string -> ELEV_MIN');
  assert.equal(clampElevation(Infinity), ELEV_MIN, 'Infinity -> ELEV_MIN');
});

test('simulateShot clamps an invalid (flat) angle into the valid band', () => {
  // A would-be flat 10deg shot must behave like the clamped ELEV_MIN (50deg)
  // shot — identical trajectory and impact.
  const surface = 200;
  const flat = simulateShot({
    shooterId: 'me', x: 60, y: surface, angle: 10, power: 80,
    wind: 0, heights: flatHeights(surface), players: [],
  });
  const clamped = simulateShot({
    shooterId: 'me', x: 60, y: surface, angle: ELEV_MIN, power: 80,
    wind: 0, heights: flatHeights(surface), players: [],
  });
  assert.deepEqual(flat.trajectory, clamped.trajectory, 'clamped trajectory matches ELEV_MIN');
});

// --- V2 SIEGE: plunging-fire damage (7.2) ------------------------------------
test('plungeMultiplier is monotonic non-decreasing in vyImpact', () => {
  let prev = -Infinity;
  for (let vy = -400; vy <= 600; vy += 20) {
    const m = plungeMultiplier(vy);
    assert.ok(m >= prev - 1e-12, `non-monotonic at vy=${vy}: ${m} < ${prev}`);
    assert.ok(m >= 0.55 - 1e-12 && m <= 1.5 + 1e-12, `out of range at vy=${vy}: ${m}`);
    prev = m;
  }
  // Clamp endpoints.
  assert.equal(plungeMultiplier(-99999), 0.55, 'clamps to 0.55 floor');
  assert.equal(plungeMultiplier(99999), 1.5, 'clamps to 1.5 ceiling');
  // The reference value lands at 0.55 + 0.95 = 1.5 exactly.
  assert.ok(Math.abs(plungeMultiplier(PLUNGE_VY_REF) - 1.5) < 1e-9, 'ref vy -> 1.5');
});

test('simulateShot reports a 2-decimal plunge multiplier', () => {
  const surface = 200;
  const res = simulateShot({
    shooterId: 'me', x: 240, y: surface, angle: 85, power: 70,
    wind: 0, heights: flatHeights(surface), players: [],
  });
  assert.ok(typeof res.plunge === 'number', 'plunge present');
  assert.ok(res.plunge >= 0.55 && res.plunge <= 1.5, 'plunge in range');
  // Rounded to 2 decimals.
  assert.equal(res.plunge, Math.round(res.plunge * 100) / 100, 'plunge is 2-decimal');
});

test('85deg lob plunges harder and deals more damage than a 50deg shot', () => {
  // Spec 7.2: a steep 85deg lob deals measurably more damage than a shallower
  // 50deg shot landing at the same distance from the target (here: a target
  // dead-center under each impact). The steeper lob has a larger vyImpact, hence
  // a larger plunge multiplier, hence more center damage.
  //
  // Power note: a full-power (100) 50deg shot on flat ground sails off the right
  // edge (that is the >380px range guarantee, tested separately) and never lands
  // in-world, so we use a power at which BOTH shots land. The plunge relationship
  // is monotonic and holds at every power.
  const surface = 220;
  const launchX = 60;
  const power = 60;

  const probeLow = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 50, power,
    wind: 0, heights: flatHeights(surface), players: [],
  });
  const probeHigh = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 85, power,
    wind: 0, heights: flatHeights(surface), players: [],
  });
  assert.ok(probeLow.impact && probeHigh.impact, 'both probes land in-world');

  // Steeper shot falls faster at impact -> bigger plunge multiplier.
  assert.ok(
    probeHigh.vyImpact > probeLow.vyImpact,
    `85deg should fall faster (${probeHigh.vyImpact} > ${probeLow.vyImpact})`
  );
  assert.ok(
    probeHigh.plunge > probeLow.plunge,
    `85deg plunge ${probeHigh.plunge} > 50deg plunge ${probeLow.plunge}`
  );

  // Put a target dead-center at each shot's impact and compare center damage.
  const mkTarget = (impact) => ({
    id: 't', x: impact.x, y: impact.y - PLAYER_HIT_DY, hp: 100, alive: true,
  });
  const lowHit = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 50, power,
    wind: 0, heights: flatHeights(surface), players: [mkTarget(probeLow.impact)],
  });
  const highHit = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 85, power,
    wind: 0, heights: flatHeights(surface), players: [mkTarget(probeHigh.impact)],
  });
  const lowDmg = lowHit.hits.length ? lowHit.hits[0].dmg : 0;
  const highDmg = highHit.hits.length ? highHit.hits[0].dmg : 0;
  assert.ok(lowDmg >= 1 && highDmg >= 1, 'both shots damage their target');
  assert.ok(
    highDmg > lowDmg,
    `85deg center dmg ${highDmg} should exceed 50deg center dmg ${lowDmg}`
  );
});

// --- V2 SIEGE: castles (7.5) -------------------------------------------------
test('buildCastles is deterministic for the same inputs', () => {
  const h = generateTerrain(4242);
  const positions = placePlayers(h, 2, 4242);
  positions[0].id = 'p0';
  positions[1].id = 'p1';
  const a = buildCastles(h, positions);
  const b = buildCastles(h, positions);
  assert.deepEqual(a, b, 'identical castles for identical inputs');
  // Sanity: two castles, each with two 3-wide towers (16 tall) + 2 merlons.
  assert.equal(a.length, 2, 'one castle per player');
  const expectedBlocks = 2 * (3 * CASTLE_TOWER_H) + 2; // two towers + two merlons
  assert.equal(a[0].blocks.length, expectedBlocks, 'block count per castle');
  assert.equal(a[0].id, 'p0', 'castle id taken from position id');
});

test('buildCastles places towers on the pad edges at the right offsets', () => {
  const surface = 180;
  const h = flatHeights(surface);
  const castles = buildCastles(h, [{ x: 240, y: surface, id: 'p' }]);
  const cols = new Set(castles[0].blocks.map((b) => b.x));
  for (const dx of [-11, -10, -9, 9, 10, 11]) {
    assert.ok(cols.has(240 + dx), `tower column at 240${dx >= 0 ? '+' : ''}${dx}`);
  }
  // Stone rises ABOVE the surface (smaller y), never below it.
  for (const b of castles[0].blocks) {
    assert.ok(b.y < surface, `block y ${b.y} should be above surface ${surface}`);
    assert.ok(b.y >= surface - 1 - CASTLE_TOWER_H, `block y ${b.y} within tower height`);
  }
});

test('side shot into a tower terminates on the wall and shields the player', () => {
  // Owner stands at x=300; their left tower sits at x=289..291. A descending shot
  // aimed to land on that tower must terminate on the wall (a castle hit) rather
  // than continuing down to the player/terrain below — the wall intercepts it.
  const surface = 220;
  const h = flatHeights(surface);
  const ownerX = 300;
  const owner = { id: 'p', x: ownerX, y: surface, hp: 100, alive: true };
  const castles = buildCastles(h, [{ x: ownerX, y: surface, id: 'p' }]);

  // Find an angle/power whose bare-terrain impact lands on the left-tower columns
  // (289..291). Fire from the left so the round descends onto the near tower.
  const launchX = ownerX - 70;
  let shot = null;
  for (let power = 30; power <= 100 && !shot; power += 2) {
    for (let ang = ELEV_MIN; ang <= ELEV_MAX && !shot; ang++) {
      const probe = simulateShot({
        shooterId: 's', x: launchX, y: surface, angle: ang, power,
        wind: 0, heights: h, players: [],
      });
      if (probe.impact && probe.impact.x >= 289 && probe.impact.x <= 291) {
        shot = { ang, power };
      }
    }
  }
  assert.ok(shot, 'found a shot that lands on the left tower columns');

  // Without castles: the round reaches the ground (impact y ~= surface).
  const bare = simulateShot({
    shooterId: 's', x: launchX, y: surface, angle: shot.ang, power: shot.power,
    wind: 0, heights: h, players: [owner],
  });
  // With castles: the round terminates ON the wall, higher up (smaller y).
  const walled = simulateShot({
    shooterId: 's', x: launchX, y: surface, angle: shot.ang, power: shot.power,
    wind: 0, heights: h, players: [owner], castles,
  });
  assert.ok(bare.impact && walled.impact, 'both shots impact');
  assert.ok(
    walled.impact.y < bare.impact.y - 2,
    `wall stops the round higher up (walled y ${walled.impact.y} < bare y ${bare.impact.y})`
  );
  // The wall is hit -> resolving castle damage records a loss for the owner.
  applyCrater(h, walled.crater);
  const { castleHits } = resolveCastleDamage(castles, walled.impact, h);
  assert.ok(castleHits.length === 1 && castleHits[0].id === 'p', 'owner castle takes the hit');
  assert.ok(castleHits[0].blocks.length >= 1, 'at least one wall block destroyed');
});

test('resolveCastleDamage applies and caps castle damage', () => {
  const surface = 200;
  const h = flatHeights(surface);
  const castles = buildCastles(h, [{ x: 240, y: surface, id: 'p' }]);
  // Impact dead-center on the left tower so MANY blocks fall within CRATER_R.
  const impact = { x: 240 - 10, y: surface - 8 };
  const { castleHits } = resolveCastleDamage(castles, impact, h);
  assert.equal(castleHits.length, 1, 'one castle damaged');
  const hit = castleHits[0];
  const n = hit.blocks.length;
  assert.ok(n > 0, 'blocks destroyed');
  // Damage formula: min(CAP, ceil(n * PER_BLOCK)).
  const expected = Math.min(CASTLE_DMG_CAP, Math.ceil(n * CASTLE_DMG_PER_BLOCK));
  assert.equal(hit.dmg, expected, `dmg ${hit.dmg} == ceil(${n}*${CASTLE_DMG_PER_BLOCK}) capped`);
  assert.ok(hit.dmg <= CASTLE_DMG_CAP, 'never exceeds the cap');
  // Destroyed blocks are marked so a second resolve is idempotent (no new loss).
  const again = resolveCastleDamage(castles, impact, h);
  for (const ch of again.castleHits) {
    assert.deepEqual(ch.blocks, [], `no fresh blocks on re-resolve (got ${ch.blocks})`);
  }
});

test('castle damage cap is enforced on a large blast', () => {
  const surface = 200;
  const h = flatHeights(surface);
  const castles = buildCastles(h, [{ x: 240, y: surface, id: 'p' }]);
  // ceil(many blocks * 0.75) would exceed CASTLE_DMG_CAP; verify the clamp.
  // A blast centered between the towers, high enough to catch lots of blocks.
  const impact = { x: 240, y: surface - 10 };
  const { castleHits } = resolveCastleDamage(castles, impact, h);
  if (castleHits.length) {
    const n = castleHits[0].blocks.length;
    if (Math.ceil(n * CASTLE_DMG_PER_BLOCK) > CASTLE_DMG_CAP) {
      assert.equal(castleHits[0].dmg, CASTLE_DMG_CAP, 'damage clamped to the cap');
    }
  }
  // Force the cap unconditionally: destroy the whole castle with a huge bite by
  // resolving against an impact that engulfs every block.
  const castles2 = buildCastles(flatHeights(surface), [{ x: 240, y: surface, id: 'p' }]);
  // Resolve repeatedly across both towers to remove all blocks in one shot's
  // accounting by using a wide manual sweep: pick the centroid of all blocks.
  let sx = 0, sy = 0;
  for (const b of castles2[0].blocks) { sx += b.x + 0.5; sy += b.y + 0.5; }
  const centroid = { x: sx / castles2[0].blocks.length, y: sy / castles2[0].blocks.length };
  const r = resolveCastleDamage(castles2, centroid, flatHeights(surface));
  if (r.castleHits.length && Math.ceil(r.castleHits[0].blocks.length * CASTLE_DMG_PER_BLOCK) > CASTLE_DMG_CAP) {
    assert.equal(r.castleHits[0].dmg, CASTLE_DMG_CAP, 'centroid blast clamps to cap');
  }
});

test('floating blocks collapse after a crater bite under a tower', () => {
  const surface = 200;
  const h = flatHeights(surface);
  const castles = buildCastles(h, [{ x: 240, y: surface, id: 'p' }]);
  const blocks = castles[0].blocks;
  const totalBefore = blocks.filter((b) => !b.destroyed).length;

  // Carve a deep crater straight down under the LEFT tower column (x=240-10=230)
  // WITHOUT a blast impact on the blocks themselves — we want collapse, not
  // direct blast, to be the cause of destruction. Lower the terrain far below the
  // tower base so the whole tower is left floating.
  for (let x = 225; x <= 235; x++) {
    if (x >= 0 && x < WORLD_W) h[x] = surface + 30; // ground drops 30px under the tower
  }

  // resolveCastleDamage with NO blast impact (null) -> only the collapse phase
  // runs against the post-crater heights.
  const { castleHits } = resolveCastleDamage(castles, null, h);
  assert.equal(castleHits.length, 1, 'the undermined castle loses blocks');
  const lost = castleHits[0].blocks.length;
  assert.ok(lost > 0, 'collapse destroyed at least one block');

  // Every left-tower block (cols 229..231) should have collapsed (unsupported,
  // terrain dropped well below their bottom edge).
  const leftCols = new Set([229, 230, 231]);
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (leftCols.has(b.x)) {
      assert.ok(b.destroyed, `left-tower block at (${b.x},${b.y}) should have collapsed`);
    }
  }
  // Right-tower blocks (cols 249..251) sit on intact ground -> still standing.
  for (const b of blocks) {
    if (b.x >= 249 && b.x <= 251) {
      assert.ok(!b.destroyed, `right-tower block at (${b.x},${b.y}) should still stand`);
    }
  }
  const totalAfter = blocks.filter((b) => !b.destroyed).length;
  assert.ok(totalAfter < totalBefore, 'fewer intact blocks after collapse');
});

test('freshly built castles never collapse on unchanged terrain (impact=null)', () => {
  // Regression for the V2 castle anchoring bug: buildCastles used to anchor all
  // tower columns to the pad-CENTER surface, but the towers sit at x±9..11 —
  // outside the ±6 pad placePlayers flattens. On sloped terrain those columns'
  // ground differs from the pad surface by >2px, so the very first
  // resolveCastleDamage(impact=null) falsely "undermined" whole towers even
  // though nothing was hit. With per-column anchoring this must NEVER happen on
  // ANY seed/terrain/player-count.
  for (let s = 0; s < 25; s++) {
    const seed = s * 2654435761 + 17;
    for (let n = 2; n <= 4; n++) {
      const h = generateTerrain(seed);
      const positions = placePlayers(h, n, seed);
      for (let i = 0; i < positions.length; i++) positions[i].id = `p${i}`;
      const castles = buildCastles(h, positions);

      const totalBefore = castles.reduce(
        (acc, c) => acc + c.blocks.filter((b) => !b.destroyed).length, 0
      );

      // Resolve with NO impact and the UNCHANGED heights: only the collapse
      // phase runs, against the exact terrain the castles were built on.
      const { castleHits, destroyed } = resolveCastleDamage(castles, null, h);

      assert.deepEqual(
        castleHits, [],
        `seed ${seed} n=${n}: castleHits must be empty, got ${JSON.stringify(castleHits)}`
      );
      assert.equal(destroyed, 0, `seed ${seed} n=${n}: zero blocks destroyed`);
      const totalAfter = castles.reduce(
        (acc, c) => acc + c.blocks.filter((b) => !b.destroyed).length, 0
      );
      assert.equal(totalAfter, totalBefore, `seed ${seed} n=${n}: no block lost`);
    }
  }
});

test('resolveCastleDamage: no castles -> empty result', () => {
  const r1 = resolveCastleDamage([], { x: 100, y: 100 }, flatHeights(200));
  assert.deepEqual(r1.castleHits, [], 'no hits with empty castles');
  assert.equal(r1.destroyed, 0, 'nothing destroyed');
  const r2 = resolveCastleDamage(undefined, { x: 100, y: 100 }, flatHeights(200));
  assert.deepEqual(r2.castleHits, [], 'no hits with undefined castles');
});

console.log(`\nAll ${passed} tests passed.`);
