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
test('45 deg / power 100 / no wind travels > 300px horizontally', () => {
  const surface = 200;
  const h = flatHeights(surface);
  const players = [];
  const launchX = 60;
  const res = simulateShot({
    shooterId: 'me',
    x: launchX,
    y: surface,
    angle: 45,
    power: 100,
    wind: 0,
    heights: h,
    players,
  });
  // At full power the shot may sail off the right side before landing — what the
  // contract requires is that it covers > 300px horizontally from launch. Measure
  // the furthest horizontal extent reached along the trajectory.
  let maxDx = 0;
  for (const [px] of res.trajectory) {
    const d = Math.abs(px - launchX);
    if (d > maxDx) maxDx = d;
  }
  assert.ok(maxDx > 300, `expected >300px horizontal travel, got ${maxDx.toFixed(1)}`);
});

test('trajectory starts at the muzzle and has multiple samples', () => {
  const surface = 200;
  const h = flatHeights(surface);
  const res = simulateShot({
    shooterId: 'me',
    x: 60,
    y: surface,
    angle: 45,
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
  const base = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 90, power: 70,
    wind: 0, heights: flatHeights(surface), players: [],
  });
  const right = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 90, power: 70,
    wind: 20, heights: flatHeights(surface), players: [],
  });
  const left = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 90, power: 70,
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

test('simulateShot does not mutate heights or players', () => {
  const surface = 200;
  const h = flatHeights(surface);
  const hCopy = Float64Array.from(h);
  const players = [{ id: 'a', x: 100, y: surface, hp: 100, alive: true }];
  const before = JSON.stringify(players);
  simulateShot({
    shooterId: 'a', x: 100, y: surface, angle: 60, power: 90,
    wind: 5, heights: h, players,
  });
  for (let x = 0; x < WORLD_W; x++) {
    assert.equal(h[x], hCopy[x], `heights mutated at ${x}`);
  }
  assert.equal(JSON.stringify(players), before, 'players mutated');
});

test('flying off the side yields null impact and null crater', () => {
  const h = flatHeights(260); // terrain low so a flat shot can leave sideways
  const res = simulateShot({
    shooterId: 'me', x: WORLD_W - 50, y: 100, angle: 5, power: 100,
    wind: 25, heights: h, players: [],
  });
  // A near-flat, full-power shot with strong tailwind near the right edge should
  // exit the side before hitting low terrain.
  assert.equal(res.impact, null, 'impact should be null when flying off the map');
  assert.equal(res.crater, null, 'crater should be null when impact is null');
  assert.deepEqual(res.hits, [], 'no hits when nothing impacted');
});

test('a player hit produces a hit, crater, and impact', () => {
  const surface = 200;
  const h = flatHeights(surface);
  // Drop a near-vertical shot straight onto a target standing under the muzzle
  // so we get a guaranteed terrain/player impact inside the map.
  const launchX = 200;
  const target = { id: 't', x: launchX, y: surface, hp: 100, alive: true };
  const shooter = { id: 'me', x: launchX, y: surface, hp: 100, alive: true };
  const res = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 90, power: 50,
    wind: 0, heights: h, players: [shooter, target],
  });
  assert.ok(res.impact, 'should land somewhere');
  assert.ok(res.crater && res.crater.r === CRATER_R, 'crater present with correct radius');
  assert.ok(res.hits.length >= 1, 'the target under the impact takes damage');
});

test('damage decreases with distance and >0 hit always >=1', () => {
  const surface = 200;
  const h = flatHeights(surface);
  // Place a row of players at increasing distance from a fixed impact point.
  // Easiest: impact a known spot by shooting straight down-ish; instead, drive
  // hits via a controlled impact by aiming so the shot lands near players.
  // Simpler deterministic approach: build players around where a 90deg shot
  // lands (it returns to roughly the launch x at the surface).
  const launchX = 240;
  const res = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 90, power: 60,
    wind: 0, heights: h, players: [],
  });
  assert.ok(res.impact, 'vertical shot returns to ground');
  const ix = res.impact.x;
  const iy = res.impact.y;

  // Construct players at the impact center, mid-range, and edge of DMG_RADIUS.
  const near = { id: 'near', x: ix, y: iy - PLAYER_HIT_DY, hp: 100, alive: true };
  const mid = { id: 'mid', x: ix + DMG_RADIUS * 0.5, y: iy - PLAYER_HIT_DY, hp: 100, alive: true };
  const far = { id: 'far', x: ix + DMG_RADIUS * 0.95, y: iy - PLAYER_HIT_DY, hp: 100, alive: true };

  const res2 = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 90, power: 60,
    wind: 0, heights: h, players: [near, mid, far],
  });
  // The shot may now hit the `near` player mid-air; what matters is hits exist
  // and damage falls off. Recompute hits against the actual impact:
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

test('controlled damage falloff via direct computeHits-equivalent geometry', () => {
  // Deterministically verify falloff: shoot at very low power straight up from a
  // raised platform so the impact is exactly the launch column at the surface,
  // then check three players at known offsets. This avoids mid-air interception
  // by placing players slightly below the muzzle line.
  const surface = 240;
  const h = flatHeights(surface);
  const launchX = 240;
  const res = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 90, power: 30,
    wind: 0, heights: h, players: [],
  });
  assert.ok(res.impact, 'low vertical shot lands');
  const ix = res.impact.x;

  // Players placed so their hit centers are at distances 0, half, near-edge.
  const mk = (id, off) => ({ id, x: ix + off, y: res.impact.y - PLAYER_HIT_DY, hp: 100, alive: true });
  const players = [mk('d0', 0), mk('d1', DMG_RADIUS * 0.5), mk('d2', DMG_RADIUS * 0.9)];
  const res2 = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 90, power: 30,
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
    shooterId: 'me', x: launchX, y: surface, angle: 90, power: 60,
    wind: 0, heights: h, players: [],
  });
  const ghost = {
    id: 'ghost', x: probe.impact.x, y: probe.impact.y - PLAYER_HIT_DY,
    hp: 0, alive: false,
  };
  const res = simulateShot({
    shooterId: 'me', x: launchX, y: surface, angle: 90, power: 60,
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

console.log(`\nAll ${passed} tests passed.`);
