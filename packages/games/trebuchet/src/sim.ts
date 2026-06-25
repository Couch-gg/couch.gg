// @ts-nocheck
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
  ELEV_MIN,
  ELEV_MAX,
  PLUNGE_VY_REF,
  CASTLE_TOWER_H,
  CASTLE_DMG_PER_BLOCK,
  CASTLE_DMG_CAP,
  mulberry32,
} from './constants.js';

const DEG2RAD = Math.PI / 180;

// Clamp helper.
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * clampElevation(angle) -> number
 *
 * V2 SIEGE — trebuchet-realistic arcs. Launch angles live in two elevation
 * bands (0=right/90=up/180=left convention):
 *   shooting right: [ELEV_MIN .. ELEV_MAX]            e.g. 50..85
 *   shooting left:  [180-ELEV_MAX .. 180-ELEV_MIN]    e.g. 95..130
 * Invalid angles are clamped to the NEAREST valid bound. The dead zone
 * (85..95) snaps to whichever side is nearer; a tie favours the right band.
 * NaN / non-finite -> ELEV_MIN (rightward), per spec.
 */
export function clampElevation(angle) {
  const a = Number(angle);
  if (!Number.isFinite(a)) return ELEV_MIN;

  const rightLo = ELEV_MIN;
  const rightHi = ELEV_MAX;
  const leftLo = 180 - ELEV_MAX; // e.g. 95
  const leftHi = 180 - ELEV_MIN; // e.g. 130

  // Already inside one of the two valid bands.
  if (a >= rightLo && a <= rightHi) return a;
  if (a >= leftLo && a <= leftHi) return a;

  // Below the right band entirely (too flat / shooting low-right) -> ELEV_MIN.
  if (a < rightLo) return rightLo;
  // Above the left band entirely (too flat / shooting low-left) -> leftHi.
  if (a > leftHi) return leftHi;

  // In the dead zone between the bands (rightHi < a < leftLo): snap to the
  // nearest bound. Distance to the right band's top vs the left band's bottom.
  const dRight = a - rightHi; // distance up to 85
  const dLeft = leftLo - a;   // distance up to 95
  // Tie (a exactly at the midpoint, e.g. 90) favours the right band.
  return dRight <= dLeft ? rightHi : leftLo;
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
 * buildCastles(heights, positions) -> castles
 *
 * V2 SIEGE — deterministic castle construction. Called by server, online
 * client, and local driver right after placePlayers (same order, same args) so
 * castle state stays identical everywhere.
 *
 * For player i at positions[i] = { x, y } (and optionally { id }): two flanking
 * towers on the pad edges. Each tower is 6 stone columns wide (1px cells),
 * rising CASTLE_TOWER_H px from the terrain surface, topped with 1-px
 * crenellations (merlons on the outer column of each tower). Left tower columns
 * sit at x-23..x-18; right tower at x+18..x+23.
 *
 * ANCHORING (bug fix): each tower column is anchored to THAT column's own
 * terrain surface — its bottom block's top edge is round(heights[col]) - 1.
 * The tower columns (offsets ±18..23) lie OUTSIDE the ±6 pad placePlayers
 * flattens, so on sloped terrain the column ground differs from the pad-center
 * surface. Anchoring per-column keeps every bottom block resting on its own
 * ground, so the floating-collapse phase never falsely undermines a freshly
 * built castle. Falls back to the position's own y for out-of-range columns.
 *
 * Returns: castles[i] = { id, blocks: [{ x, y, w:1, h:1 }, ...] } where each
 * block is a 1x1 logical stone cell. y is the cell's TOP edge (cell occupies
 * the vertical span [y, y+1)). The block order is fully deterministic — a
 * block's index identifies that physical cell forever (so clients can mirror
 * destroyed indices from result.castleHits[].blocks). Order: left tower columns
 * low-to-high x (each column bottom-up rows, then its merlon if outer), then the
 * right tower the same way. `id` is taken from positions[i].id when present,
 * else null (caller sets it).
 *
 * Pure: does NOT mutate heights or positions.
 */
export function buildCastles(heights, positions) {
  const castles = [];
  if (!Array.isArray(positions)) return castles;

  // Column offsets for the two towers, outer -> inner per tower. Order matters:
  // it fixes the block index layout forever.
  const towerOffsets = [
    [-23, -22, -21, -20, -19, -18], // left tower (left col is the outer/merlon col)
    [18, 19, 20, 21, 22, 23],       // right tower (right col is the outer/merlon col)
  ];

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    if (!pos) {
      castles.push({ id: null, blocks: [] });
      continue;
    }
    const baseX = Math.round(pos.x);
    // Per-column surface resolver: the rounded terrain height at the given
    // column, falling back to the position's own y when out of range. Each
    // tower column rises from its OWN ground (not the pad center) so blocks are
    // never born already-floating on sloped terrain.
    const surfaceYAt = (col) => {
      if (heights && col >= 0 && col < heights.length) return Math.round(heights[col]);
      return Math.round(pos.y);
    };

    const blocks = [];
    // For each tower, stack CASTLE_TOWER_H cells per column from THAT column's
    // surface up, then add a crenellation merlon on the outer column (one extra
    // cell on top of that column's wall).
    for (let tIdx = 0; tIdx < towerOffsets.length; tIdx++) {
      const cols = towerOffsets[tIdx];
      for (let c = 0; c < cols.length; c++) {
        const bx = baseX + cols[c];
        // Skip columns that fall outside the world.
        if (bx < 0 || bx >= WORLD_W) continue;
        const colSurfaceY = surfaceYAt(bx);
        // Wall cells: row 0 sits with its bottom on this column's surface (top
        // edge at colSurfaceY - 1), rising upward.
        for (let row = 0; row < CASTLE_TOWER_H; row++) {
          const topY = colSurfaceY - 1 - row;
          blocks.push({ x: bx, y: topY, w: 1, h: 1 });
        }
      }
      // Crenellations: one extra merlon cell on the outer column of this tower,
      // sitting directly atop that column's wall (row CASTLE_TOWER_H). The outer
      // column is the first listed for the left tower and the last for the right.
      const merlonCol = tIdx === 0 ? cols[0] : cols[cols.length - 1];
      const mx = baseX + merlonCol;
      if (mx >= 0 && mx < WORLD_W) {
        const merlonTopY = surfaceYAt(mx) - 1 - CASTLE_TOWER_H;
        blocks.push({ x: mx, y: merlonTopY, w: 1, h: 1 });
      }
    }

    castles.push({
      id: pos.id != null ? pos.id : null,
      blocks,
    });
  }

  return castles;
}

/**
 * simulateShot({ shooterId, x, y, angle, power, wind, heights, players, castles })
 *   -> { trajectory, impact, crater, hits, plunge, vyImpact }
 *
 * Pure: does NOT mutate heights, players, or castles. Integrates a projectile
 * with fixed DT, samples the trajectory, and resolves the first terminating
 * event. The optional `castles` argument (V2) makes intact castle blocks
 * collidable; block checks run BEFORE player-circle checks (walls protect).
 * When `castles` is omitted/empty, behavior matches v1 exactly.
 */
export function simulateShot({ shooterId, x, y, angle, power, wind, heights, players, castles }) {
  // V2: clamp to the valid elevation bands. Invalid -> nearest bound,
  // NaN -> ELEV_MIN rightward.
  const elev = clampElevation(angle);
  const rad = elev * DEG2RAD;
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

  // V2: castle block collision. A projectile within (PROJ_RADIUS + 0.5) of an
  // intact block center terminates there. Block checks run before player checks
  // (walls protect) and after the same arming delay. We flatten the intact
  // blocks once into a fast array of {cx, cy} centers.
  const blockReach = PROJ_RADIUS + 0.5;
  const blockReachSq = blockReach * blockReach;
  const blockCenters = [];
  if (Array.isArray(castles) && castles.length) {
    for (const castle of castles) {
      if (!castle || !Array.isArray(castle.blocks)) continue;
      for (const b of castle.blocks) {
        if (!b || b.destroyed) continue; // honor an inline destroyed flag if present
        blockCenters.push({ cx: b.x + 0.5, cy: b.y + 0.5 });
      }
    }
  }
  const hasBlocks = blockCenters.length > 0;

  let impact = null;
  let vyImpact = 0; // vertical velocity at the terminating event (positive = falling)
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

    // --- Castle block collision (before player checks; walls protect) ---
    if (hasBlocks && t >= hitArmTime) {
      for (let bi = 0; bi < blockCenters.length; bi++) {
        const dx = px - blockCenters[bi].cx;
        const dy = py - blockCenters[bi].cy;
        if (dx * dx + dy * dy <= blockReachSq) {
          impact = { x: px, y: py };
          vyImpact = vy;
          break;
        }
      }
      if (impact) break;
    }

    // --- Player collision (only after the arming delay) ---
    if (t >= hitArmTime) {
      for (const p of aliveList) {
        const cx = p.x;
        const cy = p.y + PLAYER_HIT_DY;
        const dx = px - cx;
        const dy = py - cy;
        if (dx * dx + dy * dy <= hitReachSq) {
          impact = { x: px, y: py };
          vyImpact = vy;
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
        vyImpact = vy;
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

  // V2: plunging-fire multiplier from the vertical velocity at impact.
  const plunge = plungeMultiplier(vyImpact);

  // Build crater + hits from the impact (if any).
  let crater = null;
  let hits = [];
  if (impact) {
    crater = { x: impact.x, y: impact.y, r: CRATER_R };
    hits = computeHits(impact, aliveList, plunge);
  }

  return {
    trajectory,
    impact,
    crater,
    hits,
    plunge: round2(plunge),
    vyImpact: round2(vyImpact),
  };
}

/**
 * plungeMultiplier(vyImpact) -> number
 *
 * V2 SIEGE — arc height matters. Steeper, faster-falling rounds plunge harder.
 *   plunge = clamp(0.55 + 0.95 * (vyImpact / PLUNGE_VY_REF), 0.55, 1.5)
 * vyImpact is positive when the projectile is falling at impact. Monotonic
 * non-decreasing in vyImpact across the clamped range.
 */
export function plungeMultiplier(vyImpact) {
  const vy = Number(vyImpact) || 0;
  return clamp(0.55 + 0.95 * (vy / PLUNGE_VY_REF), 0.55, 1.5);
}

// Damage to every alive player within DMG_RADIUS of the impact. Linear falloff
// to 0 at DMG_RADIUS, scaled by the plunge multiplier; a player that is hit
// always takes at least 1.
function computeHits(impact, aliveList, plunge) {
  const mult = Number.isFinite(plunge) ? plunge : 1;
  const hits = [];
  for (const p of aliveList) {
    const cx = p.x;
    const cy = p.y + PLAYER_HIT_DY;
    const dx = impact.x - cx;
    const dy = impact.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= DMG_RADIUS) {
      let dmg = Math.round(DMG_MAX * (1 - dist / DMG_RADIUS) * mult);
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

/**
 * resolveCastleDamage(castles, impact, heights)
 *   -> { castleHits, destroyed }   (MUTATES castle blocks: sets block.destroyed)
 *
 * V2 SIEGE — the single helper the server AND local driver call to keep castle
 * state consistent. Run it for EVERY shot that produced an impact, AFTER
 * applyCrater has already lowered `heights` (so floating-block collapse sees the
 * post-crater terrain).
 *
 * Two destruction phases, both counting toward the same per-owner total:
 *   1. Blast: every intact block whose CENTER lies within CRATER_R of `impact`
 *      is destroyed.
 *   2. Collapse: after the crater, any intact block left floating collapses — a
 *      block is floating when its column's terrain surface has dropped below the
 *      block's bottom edge (`block.y + 1`) by more than 4 px AND there is no
 *      intact block directly beneath it (same column, immediately below). The
 *      pass cascades bottom-up so a collapsing lower block can unsupport the
 *      blocks above it within the same call.
 *
 * Scoring: for each castle owner losing `n` blocks this shot,
 *   dmg = min(CASTLE_DMG_CAP, ceil(n * CASTLE_DMG_PER_BLOCK))
 * Self-hits included (you can smash your own walls and bleed yourself).
 *
 * Arguments:
 *   castles : the authoritative castle list from buildCastles. Block objects are
 *             mutated in place — `block.destroyed = true` marks a dead cell.
 *             Already-destroyed blocks are skipped (idempotent across shots).
 *   impact  : { x, y } | null. Null/absent -> no blast phase (but collapse still
 *             runs against the current terrain, which is correct after a crater).
 *   heights : the post-crater authoritative heightmap (used by the collapse
 *             phase only). If omitted, the collapse phase is skipped.
 *
 * Returns:
 *   castleHits : [{ id, dmg, blocks: [blockIndex...] }] — one entry per castle
 *                that lost ≥ 1 block this shot, in castle order. `blocks` are the
 *                indices (into that castle's block list) destroyed THIS shot, in
 *                ascending order. NOTE: no `hp` field — the caller subtracts
 *                `dmg` from the owner's hp and adds the post-damage `hp` itself
 *                (so blast + castle damage can share one final hp value).
 *   destroyed  : total number of blocks destroyed across all castles this shot
 *                (convenience; usually unused).
 *
 * Pure aside from the intended block mutation: does NOT touch `heights`,
 * `impact`, players, or terrain.
 */
export function resolveCastleDamage(castles, impact, heights) {
  const castleHits = [];
  let destroyedTotal = 0;
  if (!Array.isArray(castles) || castles.length === 0) {
    return { castleHits, destroyed: destroyedTotal };
  }

  const craterR2 = CRATER_R * CRATER_R;
  const hasImpact = impact && Number.isFinite(impact.x) && Number.isFinite(impact.y);
  const hasHeights = heights && typeof heights.length === 'number';

  for (let ci = 0; ci < castles.length; ci++) {
    const castle = castles[ci];
    if (!castle || !Array.isArray(castle.blocks)) continue;
    const blocks = castle.blocks;
    const destroyedThis = [];

    // --- Phase 1: blast destruction within CRATER_R of the impact center. ---
    if (hasImpact) {
      for (let bi = 0; bi < blocks.length; bi++) {
        const b = blocks[bi];
        if (!b || b.destroyed) continue;
        const cx = b.x + 0.5;
        const cy = b.y + 0.5;
        const dx = cx - impact.x;
        const dy = cy - impact.y;
        if (dx * dx + dy * dy <= craterR2) {
          b.destroyed = true;
          destroyedThis.push(bi);
        }
      }
    }

    // --- Phase 2: floating-block collapse after the crater bite. ---
    // A block floats when its column terrain dropped below its bottom edge by
    // > 4 px AND nothing intact directly supports it from below. We process each
    // column bottom-up (largest y last in screen space = lowest block first) so
    // a collapse cascades to the blocks resting on top of it in one pass.
    if (hasHeights) {
      // Group intact-or-just-checked blocks by column. We only need columns that
      // actually have blocks; build a per-column list of {bi, b} sorted so the
      // LOWEST cell (largest y) is processed first.
      const byCol = new Map();
      for (let bi = 0; bi < blocks.length; bi++) {
        const b = blocks[bi];
        if (!b) continue;
        let list = byCol.get(b.x);
        if (!list) {
          list = [];
          byCol.set(b.x, list);
        }
        list.push(bi);
      }

      for (const [col, idxs] of byCol) {
        if (col < 0 || col >= heights.length) continue;
        // Round the terrain surface the SAME way buildCastles anchors blocks
        // (round(heights[col])). buildCastles sets each column's bottom block so
        // its bottom edge == round(heights[col]); comparing against the rounded
        // surface here guarantees a freshly built castle on unchanged terrain is
        // never falsely undermined, on any seed/slope. A real crater lowers
        // heights[col] far past this, so genuine collapses still trigger.
        const surface = Math.round(heights[col]);
        // Sort cells in this column from lowest (largest y) to highest (smallest
        // y) so support checks see the already-resolved cell beneath.
        idxs.sort((a, c) => blocks[c].y - blocks[a].y);
        for (const bi of idxs) {
          const b = blocks[bi];
          if (!b || b.destroyed) continue;
          const bottomEdge = b.y + 1; // cell occupies [y, y+1); bottom edge = y+1
          // Terrain surface dropped below the block bottom by more than 4 px?
          // (pixel slack scaled with the 2x world)
          if (surface <= bottomEdge + 4) continue; // still supported by ground
          // Intact block directly beneath? (a cell whose top edge == this bottom
          // edge, i.e. block at y = bottomEdge, same column, not destroyed).
          let supported = false;
          for (const oj of idxs) {
            if (oj === bi) continue;
            const ob = blocks[oj];
            if (!ob || ob.destroyed) continue;
            if (ob.y === bottomEdge) {
              supported = true;
              break;
            }
          }
          if (supported) continue;
          // Floating: collapse.
          b.destroyed = true;
          destroyedThis.push(bi);
        }
      }
    }

    if (destroyedThis.length > 0) {
      destroyedThis.sort((a, c) => a - c);
      destroyedTotal += destroyedThis.length;
      const n = destroyedThis.length;
      const dmg = Math.min(
        CASTLE_DMG_CAP,
        Math.ceil(n * CASTLE_DMG_PER_BLOCK)
      );
      castleHits.push({
        id: castle.id != null ? castle.id : null,
        dmg,
        blocks: destroyedThis,
      });
    }
  }

  return { castleHits, destroyed: destroyedTotal };
}
