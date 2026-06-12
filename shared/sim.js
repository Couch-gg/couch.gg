// shared/sim.js — deterministic artillery simulation.
//
// Pure functions only: no DOM, no Phaser, no Node APIs. Runs identically in
// Node (server) and the browser (client). All randomness flows through
// mulberry32 from constants so the same seed always yields the same world.
//
// Coordinate system: origin top-left, x right, y down. Terrain is solid from
// heights[x] (the surface y) down to WORLD_H. Angles in degrees: 0 = right,
// 90 = straight up, 180 = left. vx = cos(rad)*speed, vy = -sin(rad)*speed.

import {
  WORLD_W,
  WORLD_H,
  TERRAIN_MIN_Y,
  TERRAIN_MAX_Y,
  TERRAIN_FLOOR_Y,
  GRAVITY,
  DT,
  TRAJ_SAMPLE_EVERY,
  MAX_FLIGHT_T,
  SPEED_MAX,
  PROJ_RADIUS,
  CRATER_R,
  DMG_MAX,
  DMG_RADIUS,
  PLAYER_HIT_R,
  PLAYER_HIT_DY,
  MUZZLE_DY,
  mulberry32,
} from './constants.js';

const DEG2RAD = Math.PI / 180;

// Clamp helper.
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Smooth interpolation curve (smoothstep) for value noise — gives gentle,
// walkable-looking slopes instead of sharp linear ridges.
function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

// One octave of 1-D value noise sampled across [0, WORLD_W). `cells` random
// control values (one per lattice node) are interpolated with smoothstep.
// `phase` shifts the lattice so octaves don't all share their peaks.
function valueNoise(x, cells, freq) {
  // Map column x to lattice space.
  const pos = (x / WORLD_W) * freq;
  const i0 = Math.floor(pos);
  const frac = pos - i0;
  const n = cells.length;
  // Wrap lattice indices so the field tiles cleanly (no abrupt edge seam).
  const a = cells[((i0 % n) + n) % n];
  const b = cells[(((i0 + 1) % n) + n) % n];
  return a + (b - a) * smoothstep(frac);
}

/**
 * generateTerrain(seed) -> Float64Array(WORLD_W)
 *
 * Rolling hills with character via layered value noise (3 octaves) on top of a
 * gentle large-scale base swell, then box-blur smoothed. Output uses the full
 * allowed vertical range and is clamped to [TERRAIN_MIN_Y, TERRAIN_MAX_Y].
 * Deterministic: identical array for identical seed.
 */
export function generateTerrain(seed) {
  const rand = mulberry32(seed | 0);

  // Build lattice control points for each octave. Lower-frequency octaves
  // dominate (big hills); higher-frequency octaves add fine character.
  // Frequencies chosen so the highest octave still spans several columns per
  // cell — keeps slopes smooth/walkable rather than spiky.
  const octaves = [
    { freq: 3, amp: 1.0 },
    { freq: 6, amp: 0.55 },
    { freq: 12, amp: 0.28 },
    { freq: 24, amp: 0.14 },
  ];

  // Generate one set of random lattice cells per octave.
  for (const oct of octaves) {
    const cells = new Float64Array(oct.freq);
    for (let i = 0; i < oct.freq; i++) cells[i] = rand();
    oct.cells = cells;
  }

  // A slow whole-map tilt/swell so different seeds favour different sides —
  // gives variety in where the high ground sits.
  const tiltDir = rand() < 0.5 ? -1 : 1;
  const tiltAmt = 0.15 + rand() * 0.25; // 0.15..0.40 of range
  const tiltPhase = rand() * Math.PI * 2;

  const raw = new Float64Array(WORLD_W);
  let totalAmp = 0;
  for (const oct of octaves) totalAmp += oct.amp;

  let minV = Infinity;
  let maxV = -Infinity;

  for (let x = 0; x < WORLD_W; x++) {
    let v = 0;
    for (const oct of octaves) {
      v += valueNoise(x, oct.cells, oct.freq) * oct.amp;
    }
    v /= totalAmp; // normalize noise to ~[0,1]

    // Add a gentle single-hump tilt across the map for large-scale variety.
    const u = x / (WORLD_W - 1);
    const tilt = Math.sin(u * Math.PI + tiltPhase) * tiltAmt;
    v += tilt;

    raw[x] = v;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  // Normalize the combined field to exactly [0,1] so we always use the full
  // vertical band regardless of seed.
  const span = maxV - minV || 1;
  const range = TERRAIN_MAX_Y - TERRAIN_MIN_Y;
  const heights = new Float64Array(WORLD_W);
  for (let x = 0; x < WORLD_W; x++) {
    const norm = (raw[x] - minV) / span; // 0..1, 0 = highest peak region
    // Higher noise value => higher ground => smaller y. Invert so peaks reach
    // TERRAIN_MIN_Y and valleys reach TERRAIN_MAX_Y.
    heights[x] = TERRAIN_MIN_Y + (1 - norm) * range;
  }

  // Box-blur smoothing pass to soften any residual kinks — keeps slopes
  // looking walkable. Two light passes.
  smoothInPlace(heights, 2, 2);

  // Clamp (smoothing can only pull values inward, but be safe).
  for (let x = 0; x < WORLD_W; x++) {
    heights[x] = clamp(heights[x], TERRAIN_MIN_Y, TERRAIN_MAX_Y);
  }

  return heights;
}

// In-place box blur with given radius, repeated `passes` times. Edge columns
// clamp-extend so the ends stay anchored.
function smoothInPlace(heights, radius, passes) {
  const n = heights.length;
  const tmp = new Float64Array(n);
  for (let p = 0; p < passes; p++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      let count = 0;
      for (let k = -radius; k <= radius; k++) {
        const xi = clamp(x + k, 0, n - 1);
        sum += heights[xi];
        count++;
      }
      tmp[x] = sum / count;
    }
    heights.set(tmp);
  }
}

/**
 * placePlayers(heights, n, seed) -> [{ x, y }]
 *
 * n positions left-to-right, evenly spaced with a small seeded jitter, kept at
 * least 40 px from each edge. Flattens a 13 px wide pad in `heights` around
 * each x (MUTATES heights) so trebuchets sit on level ground. y = heights[x]
 * after flattening. Deterministic for a given (n, seed).
 */
export function placePlayers(heights, n, seed) {
  // Use a distinct PRNG stream from terrain so jitter is independent but still
  // reproducible. Offset keeps it deterministic and separate.
  const rand = mulberry32(((seed | 0) ^ 0x9e3779b9) | 0);

  const margin = 40;
  const usable = WORLD_W - 1 - margin * 2; // span of valid x centers
  const positions = [];

  for (let i = 0; i < n; i++) {
    // Even base spacing across the usable band. For n === 1 place at center.
    const frac = n === 1 ? 0.5 : i / (n - 1);
    let cx = Math.round(margin + frac * usable);

    // Seeded jitter, but keep slots from overlapping: jitter range scales with
    // available gap and never pushes a player past the margins.
    const slot = n > 1 ? usable / (n - 1) : usable;
    const jitterMax = Math.min(12, slot * 0.25);
    const jitter = Math.round((rand() * 2 - 1) * jitterMax);
    cx = clamp(cx + jitter, margin, WORLD_W - 1 - margin);

    positions.push(cx);
  }

  // Flatten a 13 px wide pad (±6 around center) to the average local height so
  // the trebuchet has a level footing. Mutates heights.
  const half = 6; // 13 px total (center ±6)
  const result = [];
  for (const cx of positions) {
    const lo = clamp(cx - half, 0, WORLD_W - 1);
    const hi = clamp(cx + half, 0, WORLD_W - 1);

    // Pad level = average of the span, clamped to the legal terrain band so the
    // pad never floats above the ceiling or sinks below the floor.
    let sum = 0;
    let count = 0;
    for (let x = lo; x <= hi; x++) {
      sum += heights[x];
      count++;
    }
    let level = sum / count;
    level = clamp(level, TERRAIN_MIN_Y, TERRAIN_MAX_Y);

    for (let x = lo; x <= hi; x++) {
      heights[x] = level;
    }

    result.push({ x: cx, y: heights[cx] });
  }

  return result;
}

/**
 * simulateShot({ shooterId, x, y, angle, power, wind, heights, players })
 *   -> { trajectory, impact, crater, hits }
 *
 * Pure: does NOT mutate heights or players. Integrates a projectile with fixed
 * DT, samples the trajectory, and resolves the first terminating event.
 */
export function simulateShot({ shooterId, x, y, angle, power, wind, heights, players }) {
  const rad = angle * DEG2RAD;
  const speed = (power / 100) * SPEED_MAX;

  // Spawn at the muzzle, above the trebuchet base.
  let px = x;
  let py = y - MUZZLE_DY;
  let vx = Math.cos(rad) * speed;
  let vy = -Math.sin(rad) * speed;

  const trajectory = [];
  const pushSample = () => {
    trajectory.push([round2(px), round2(py)]);
  };
  pushSample(); // always record the launch point

  // Precompute alive player hit circles. Self-hits are allowed; the shooter is
  // included. We ignore hits during the first 0.15 s so the round clears its
  // own circle on the way out.
  const aliveList = Array.isArray(players)
    ? players.filter((p) => p && p.alive)
    : [];
  const hitArmTime = 0.15;
  const hitReach = PLAYER_HIT_R + PROJ_RADIUS;
  const hitReachSq = hitReach * hitReach;

  let impact = null;
  let t = 0;
  let step = 0;
  const maxSteps = Math.ceil(MAX_FLIGHT_T / DT);

  for (step = 1; step <= maxSteps; step++) {
    // Integrate (semi-implicit Euler, matching the contract update order).
    vx += wind * DT;
    vy += GRAVITY * DT;
    px += vx * DT;
    py += vy * DT;
    t += DT;

    // --- Player collision (only after the arming delay) ---
    if (t >= hitArmTime) {
      for (const p of aliveList) {
        const cx = p.x;
        const cy = p.y + PLAYER_HIT_DY;
        const dx = px - cx;
        const dy = py - cy;
        if (dx * dx + dy * dy <= hitReachSq) {
          impact = { x: px, y: py };
          break;
        }
      }
      if (impact) break;
    }

    // --- Terrain collision ---
    if (px >= 0 && px < WORLD_W) {
      const col = Math.round(px);
      // Guard col into range (round of values just under WORLD_W could equal
      // WORLD_W).
      if (col >= 0 && col < WORLD_W && py >= heights[col]) {
        impact = { x: px, y: py };
        break;
      }
    }

    // --- Left the map sideways ---
    if (px < -60 || px > WORLD_W + 60) {
      break; // flew off; impact stays null
    }

    // --- Fell below the bottom of the world ---
    if (py > WORLD_H + 20) {
      break; // off the bottom; impact stays null
    }

    // Record trajectory samples at the configured cadence.
    if (step % TRAJ_SAMPLE_EVERY === 0) {
      pushSample();
    }
  }

  // Always record the final point so animation lands exactly where it stopped.
  pushSample();

  // Build crater + hits from the impact (if any).
  let crater = null;
  let hits = [];
  if (impact) {
    crater = { x: impact.x, y: impact.y, r: CRATER_R };
    hits = computeHits(impact, aliveList);
  }

  return { trajectory, impact, crater, hits };
}

// Damage to every alive player within DMG_RADIUS of the impact. Linear falloff
// to 0 at DMG_RADIUS; a player that is hit always takes at least 1.
function computeHits(impact, aliveList) {
  const hits = [];
  for (const p of aliveList) {
    const cx = p.x;
    const cy = p.y + PLAYER_HIT_DY;
    const dx = impact.x - cx;
    const dy = impact.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= DMG_RADIUS) {
      let dmg = Math.round(DMG_MAX * (1 - dist / DMG_RADIUS));
      if (dmg < 1) dmg = 1;
      hits.push({ id: p.id, dmg });
    }
  }
  return hits;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * applyCrater(heights, crater) -> void  (MUTATES heights)
 *
 * Circular bite centered at (crater.x, crater.y) with radius crater.r. For each
 * column within the radius the crater removes terrain down to
 * crater.y + sqrt(r^2 - dx^2): new height = max(current, that value), then
 * clamped so it never digs below TERRAIN_FLOOR_Y. Columns outside the world are
 * ignored.
 */
export function applyCrater(heights, crater) {
  if (!crater) return;
  const { x: cxRaw, y: cy, r } = crater;
  const cx = cxRaw;
  const r2 = r * r;
  const loX = Math.ceil(cx - r);
  const hiX = Math.floor(cx + r);

  for (let xi = loX; xi <= hiX; xi++) {
    if (xi < 0 || xi >= WORLD_W) continue;
    const dx = xi - cx;
    const inside = r2 - dx * dx;
    if (inside < 0) continue;
    const bottom = cy + Math.sqrt(inside); // lower edge of the circular bite
    // The crater lowers the surface (increases y) to at least `bottom`, but the
    // contract says new height = max(current, bottom) — i.e. only carve down,
    // never raise terrain. Then clamp to the floor.
    let nh = Math.max(heights[xi], bottom);
    if (nh > TERRAIN_FLOOR_Y) nh = TERRAIN_FLOOR_Y;
    heights[xi] = nh;
  }
}

/**
 * settlePlayers(heights, players) -> [{ id, y }]  (MUTATES player y)
 *
 * Any alive player now floating above the terrain (y < heights[round(x)]) drops
 * to rest on the surface. Returns ONLY the players that moved, with their new y.
 */
export function settlePlayers(heights, players) {
  const moved = [];
  if (!Array.isArray(players)) return moved;
  for (const p of players) {
    if (!p || !p.alive) continue;
    let col = Math.round(p.x);
    if (col < 0) col = 0;
    if (col >= WORLD_W) col = WORLD_W - 1;
    const surface = heights[col];
    if (p.y < surface) {
      p.y = surface;
      moved.push({ id: p.id, y: surface });
    }
  }
  return moved;
}
