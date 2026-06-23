// public/js/sprites.js
// Agent ART — all pixel-art textures baked at runtime from hand-authored string grids.
// Every sprite is drawn onto an offscreen canvas (1 grid char = 1 px) with a transparent
// background, then registered with Phaser via scene.textures.addCanvas(key, canvas).
//
// Phaser is a global (window.Phaser); we never import it. Textures are pure data here so this
// module has no other dependencies.

import { TEAM_COLORS } from '/shared/constants.js';

export const SPRITES_READY = true;

// ---------------------------------------------------------------------------------------------
// Palette helpers
// ---------------------------------------------------------------------------------------------

// Convert a 0xRRGGBB integer (Phaser color) to an "#rrggbb" string.
function hex(n) {
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0');
}

// Lighten / darken a 0xRRGGBB color by mixing toward white / black. amt in [-1, 1].
function shade(n, amt) {
  let r = (n >> 16) & 0xff;
  let g = (n >> 8) & 0xff;
  let b = n & 0xff;
  if (amt >= 0) {
    r = r + (255 - r) * amt;
    g = g + (255 - g) * amt;
    b = b + (255 - b) * amt;
  } else {
    const k = 1 + amt; // amt negative -> k < 1
    r *= k; g *= k; b *= k;
  }
  r = Math.max(0, Math.min(255, Math.round(r)));
  g = Math.max(0, Math.min(255, Math.round(g)));
  b = Math.max(0, Math.min(255, Math.round(b)));
  return (r << 16) | (g << 8) | b;
}

// ---------------------------------------------------------------------------------------------
// Generic baker: draw a string-grid + palette map onto a fresh canvas, register it with Phaser.
//   grid  : array of equal-length strings; one char per pixel. ' ' (space) or '.' = transparent.
//   pal   : { char: '#rrggbb' | 0xRRGGBB }
//   key   : texture key
//   w/h   : expected dimensions (asserted-ish; canvas sized to grid)
// ---------------------------------------------------------------------------------------------
function bakeGrid(scene, key, grid, pal) {
  const h = grid.length;
  const w = grid[0] ? grid[0].length : 0;

  // Build a lookup of resolved color strings (skip transparent markers).
  const colors = {};
  for (const ch in pal) {
    const v = pal[ch];
    colors[ch] = typeof v === 'number' ? hex(v) : v;
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  for (let y = 0; y < h; y++) {
    const row = grid[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === ' ' || ch === '.') continue;
      const col = colors[ch];
      if (!col) continue; // undefined char -> treat as transparent
      ctx.fillStyle = col;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  registerCanvas(scene, key, canvas);
}

// Register a finished canvas as a Phaser texture and force NEAREST filtering for crisp pixels.
function registerCanvas(scene, key, canvas) {
  if (scene.textures.exists(key)) {
    scene.textures.remove(key);
  }
  scene.textures.addCanvas(key, canvas);
  const tex = scene.textures.get(key);
  if (tex && window.Phaser && window.Phaser.Textures) {
    tex.setFilter(window.Phaser.Textures.FilterMode.NEAREST);
  }
}

// ---------------------------------------------------------------------------------------------
// TREBUCHET (26x26) — three pose frames (idle / swing / release) per team color.
//
// Authored facing RIGHT (the game flips with flipX). Origin is set by the game to bottom-center.
// A clear, iconic siege-engine silhouette that reads instantly at 1x:
//   - Wide wooden base beam + diagonal foot braces planted on the ground.
//   - HEAVY A-frame: two thick angled legs meeting at an iron pivot apex near the top-middle.
//   - LONG throwing arm pivoting at the apex. Short heavy end (back/left) carries a HANGING
//     counterweight box; long thin end (front/right) carries the sling + payload.
//   - A team-color BANNER flies from a pole at the apex.
//   - The counterweight box visibly HANGS from the short arm end (rope link, swings down as the
//     arm rotates), and SLING LINES connect the long arm tip to the stone payload.
//
// Three poses (counterweight + arm + sling tell the whole story):
//   idle    — arm cocked back-down: long end pulled DOWN to the rear, sling loaded low behind;
//             counterweight raised high on the short end. Primed and ready.
//   swing   — arm rotated toward vertical, counterweight mid-drop, sling whipping up & forward.
//   release — arm forward-high over the front, sling open/empty, counterweight at the bottom.
//
// Palette chars (shared by all frames):
//   D dark wood   W wood (mid)   L light wood (highlight)
//   K iron/pivot & arm spine (dark)   M metal pivot highlight
//   C counterweight box (team, lit)   c counterweight box (team, shade)   i iron cw band (dark)
//   F banner (team)   f banner shade   p banner pole (metal)
//   R rope / sling line (tan)   S stone payload (gray)
// ---------------------------------------------------------------------------------------------

// IDLE — arm cocked back-down. Counterweight box raised high on the short (right/front) end,
// long arm pulled DOWN to the rear (left), sling + stone resting low behind the frame.
const TREB_IDLE = [
  '.....................CCC..',
  '.Ff..................CiC..',
  '.FF..................ccc..',
  '.Ff...................R...',
  '.FF...................R...',
  '.p...................WL...',
  '.p..................WL....',
  '.p.................WL.....',
  '.p................WL......',
  '.p...............WL.......',
  '.p....RR........KMK.......',
  '.p...R..R......DKD........',
  '.p...R.SR.....DWKWD.......',
  '.p....RR.....DW.K.WD......',
  '.p..........DW..K..WD.....',
  '.p.........DW...K...WD....',
  '..........DW....K....WD...',
  '.........DW.....K.....WD..',
  '.....DDDDW......K......WDD',
  '....DLWWWWWWWWWWWWWWWWWWWWL',
  '....DWWWWWWWWWWWWWWWWWWWWWD',
  '....DLLLLLLLLLLLLLLLLLLLLD',
  '....D..DD..........DD...D.',
  '...DD..WW..........WW...DD',
  '..DW...WW..........WW...WD',
  '..D....DD..........DD....D',
];

// SWING — arm rotated toward vertical. Counterweight box mid-drop (swung down toward the rear),
// long arm pointing UP, sling whipping up and forward over the apex.
const TREB_SWING = [
  '..............R...........',
  '.Ff..........R.RR.........',
  '.FF.........R..SR.........',
  '.Ff........R...R..........',
  '.FF.......WL..............',
  '.p.......WL...............',
  '.p......WW................',
  '.p.....WL.................',
  '.p.....WL.................',
  '.p....WL..................',
  '.p....WL.........KMK......',
  '.p...iWi........DKD.......',
  '.p...CCC.......DWKWD......',
  '.p...CiC......DW.K.WD.....',
  '.p...ccc.....DW..K..WD....',
  '.p..........DW...K...WD...',
  '...........DW....K....WD..',
  '..........DW.....K.....WD.',
  '.....DDDDW......K......WDD',
  '....DLWWWWWWWWWWWWWWWWWWWWL',
  '....DWWWWWWWWWWWWWWWWWWWWWD',
  '....DLLLLLLLLLLLLLLLLLLLLD',
  '....D..DD..........DD...D.',
  '...DD..WW..........WW...DD',
  '..DW...WW..........WW...WD',
  '..D....DD..........DD....D',
];

// RELEASE — long arm whipped forward-HIGH over the front (right); sling thrown open and EMPTY
// (payload already launched). Counterweight box swung down to the BOTTOM at the rear (left),
// hanging from the short arm end. The A-frame + base are identical to IDLE; only the arm,
// counterweight and sling move.
const TREB_RELEASE = [
  '..................RR......',
  '.Ff.............RR..RR....',
  '.FF............R......R...',
  '.Ff...........R.......R...',
  '.FF..........WL...........',
  '.p..........WL............',
  '.p.........WW.............',
  '.p........WL..............',
  '.p.......WL...............',
  '.p......WL................',
  '.p.....WL.......KMK.......',
  '.p....WLK......DKD........',
  '.p....KCccc...DWKWD.......',
  '.p...CCCcccc.DW.K.WD......',
  '.p...iCiccc.DW..K..WD.....',
  '.p...CCCccWDW...K...WD....',
  '......iiiDW.....K....WD...',
  '.........DW.....K.....WD..',
  '.....DDDDW......K......WDD',
  '....DLWWWWWWWWWWWWWWWWWWWWL',
  '....DWWWWWWWWWWWWWWWWWWWWWD',
  '....DLLLLLLLLLLLLLLLLLLLLD',
  '....D..DD..........DD...D.',
  '...DD..WW..........WW...DD',
  '..DW...WW..........WW...WD',
  '..D....DD..........DD....D',
];

// Pad every trebuchet grid row to exactly 26 chars so the canvas is 26x26.
function padRows(grid, w) {
  return grid.map((r) => (r.length >= w ? r.slice(0, w) : r + ' '.repeat(w - r.length)));
}

function bakeTrebuchet(scene, idx) {
  const team = TEAM_COLORS[idx];

  // Wood ramp (warm browns) — shared across teams. 2-3 shade wood for legible volume.
  const pal = {
    D: 0x4a2f1a, // dark wood (shadow side / outlines)
    W: 0x7a4e29, // mid wood (body)
    L: 0xb07b43, // light wood (highlight)
    K: 0x2b2b33, // iron pivot / arm spine (dark)
    M: 0x9aa0ad, // metal pivot highlight
    R: 0xc9a86a, // rope / sling line (tan)
  };
  // Stone payload grays, banner pole, banner + counterweight from team color.
  pal.S = 0x9b9b9b; // stone payload (gray)
  pal.p = 0x8a8f99; // banner pole (metal gray)
  pal.i = 0x33333b; // iron band on the counterweight box (dark)
  pal.F = team;
  pal.f = shade(team, -0.35); // banner shade
  pal.C = shade(team, 0.12); // counterweight face (team, slightly lit)
  pal.c = shade(team, -0.4); // counterweight shade (darker team)

  bakeGrid(scene, `treb_${idx}_idle`, padRows(TREB_IDLE, 26), pal);
  bakeGrid(scene, `treb_${idx}_swing`, padRows(TREB_SWING, 26), pal);
  bakeGrid(scene, `treb_${idx}_release`, padRows(TREB_RELEASE, 26), pal);
}

// ---------------------------------------------------------------------------------------------
// ROCK (5x5) — round gray stone with a highlight and shadow.
// ---------------------------------------------------------------------------------------------
const ROCK = [
  '.lhh.',
  'lhhgg',
  'hhggd',
  'hggdd',
  '.gdd.',
];
const ROCK_PAL = {
  l: 0xd6d6d6, // highlight
  h: 0xa8a8a8, // light gray
  g: 0x7d7d7d, // mid gray
  d: 0x575757, // shadow
};

// ---------------------------------------------------------------------------------------------
// EXPLOSION (32x32) — boom_0..boom_4. Built procedurally as concentric radial bands so the
// frames feel punchy and animate cleanly: white-hot core -> orange/red ring -> gray smoke
// dissipating. Each frame is a ring profile (radii + colors) drawn with filled circle bands.
// ---------------------------------------------------------------------------------------------

// Color stops used in the explosion (string form for canvas).
const EX = {
  white: '#fffbe6',
  yellow: '#ffe14d',
  orange: '#ff9a1f',
  red: '#e23a1f',
  smokeL: '#9a958d',
  smoke: '#6f6a63',
  smokeD: '#48443e',
};

// Draw a filled "pixel disc" of radius r centered at (cx, cy) on the given ctx with a color.
// Uses a per-pixel test so edges stay chunky/retro rather than antialiased.
function fillDisc(ctx, cx, cy, r, color) {
  if (r <= 0) return;
  ctx.fillStyle = color;
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(31, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(31, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) ctx.fillRect(x, y, 1, 1);
    }
  }
}

// Draw an annulus (ring) between rInner and rOuter.
function fillRing(ctx, cx, cy, rInner, rOuter, color) {
  if (rOuter <= 0) return;
  ctx.fillStyle = color;
  const ro2 = rOuter * rOuter;
  const ri2 = rInner > 0 ? rInner * rInner : -1;
  const x0 = Math.max(0, Math.floor(cx - rOuter));
  const x1 = Math.min(31, Math.ceil(cx + rOuter));
  const y0 = Math.max(0, Math.floor(cy - rOuter));
  const y1 = Math.min(31, Math.ceil(cy + rOuter));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= ro2 && d2 > ri2) ctx.fillRect(x, y, 1, 1);
    }
  }
}

// Sprinkle a few detached "ember" / "smoke puff" pixels for a hand-made retro feel.
// Deterministic positions so frames look consistent run to run.
function speckle(ctx, cx, cy, points, color) {
  ctx.fillStyle = color;
  for (let i = 0; i < points.length; i += 2) {
    const x = Math.round(cx + points[i]);
    const y = Math.round(cy + points[i + 1]);
    if (x >= 0 && x < 32 && y >= 0 && y < 32) ctx.fillRect(x, y, 1, 1);
  }
}

function bakeExplosion(scene) {
  const cx = 16;
  const cy = 16;

  // Each frame: list of bands drawn outer->inner, plus optional speckles. Radii chosen so the
  // blast grows, the hot core fades, and smoke takes over and dissipates.
  const frames = [
    // boom_0 — tiny bright flash, just igniting.
    (ctx) => {
      fillRing(ctx, cx, cy, 4, 6, EX.orange);
      fillRing(ctx, cx, cy, 2, 4, EX.yellow);
      fillDisc(ctx, cx, cy, 2, EX.white);
    },
    // boom_1 — full fireball: white core, yellow, orange, red rim.
    (ctx) => {
      fillRing(ctx, cx, cy, 10, 12, EX.red);
      fillRing(ctx, cx, cy, 7, 10, EX.orange);
      fillRing(ctx, cx, cy, 4, 7, EX.yellow);
      fillDisc(ctx, cx, cy, 4, EX.white);
      speckle(ctx, cx, cy, [13, -2, -12, 3, 2, -13, -3, 12, 11, 8, -10, -9], EX.orange);
    },
    // boom_2 — expanded, core cooling: orange center, red ring, first smoke.
    (ctx) => {
      fillRing(ctx, cx, cy, 12, 14, EX.smoke);
      fillRing(ctx, cx, cy, 9, 12, EX.red);
      fillRing(ctx, cx, cy, 5, 9, EX.orange);
      fillDisc(ctx, cx, cy, 5, EX.yellow);
      speckle(ctx, cx, cy, [15, -1, -14, 2, 1, -15, -2, 14, 12, 10, -11, -11], EX.smokeL);
    },
    // boom_3 — mostly smoke with a dim red heart.
    (ctx) => {
      fillRing(ctx, cx, cy, 12, 15, EX.smokeD);
      fillRing(ctx, cx, cy, 8, 12, EX.smoke);
      fillRing(ctx, cx, cy, 5, 8, EX.smokeL);
      fillDisc(ctx, cx, cy, 5, EX.red);
      speckle(ctx, cx, cy, [16, 0, -15, -3, 3, -16, -4, 15, 13, -13, -12, 12], EX.smokeL);
    },
    // boom_4 — dissipating smoke puffs, dark and ragged.
    (ctx) => {
      fillRing(ctx, cx, cy, 11, 14, EX.smokeD);
      fillRing(ctx, cx, cy, 6, 11, EX.smoke);
      fillDisc(ctx, cx, cy, 6, EX.smokeL);
      // punch a couple of holes so it looks ragged / breaking up
      ctx.clearRect(13, 9, 3, 2);
      ctx.clearRect(17, 18, 2, 3);
      ctx.clearRect(9, 16, 2, 2);
      speckle(ctx, cx, cy, [17, -4, -16, 4, 5, -17, -6, 16, 14, 13, -14, -13], EX.smokeD);
    },
  ];

  for (let i = 0; i < frames.length; i++) {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 32, 32);
    frames[i](ctx);
    registerCanvas(scene, `boom_${i}`, canvas);
  }
}

// ---------------------------------------------------------------------------------------------
// CLOUDS (~44x14) — three wispy pale clouds, slightly transparent. Drawn with soft rounded
// blobs from a string grid using two alpha-ish shades (the game can also set sprite alpha).
//   o = solid cloud body, O = bright top highlight, . = transparent.
// We bake them at slightly less than full opacity so they read as soft.
// ---------------------------------------------------------------------------------------------
const CLOUD_0 = [
  '.................OOOO.......................',
  '............OOOOoooooOOO....................',
  '.........OOoooooooooooooooO.................',
  '......OOoooooooooooooooooooooOO.............',
  '....Ooooooooooooooooooooooooooooo...........',
  '...ooooooooooooooooooooooooooooooooO........',
  '..oooooooooooooooooooooooooooooooooooOO.....',
  '.Oooooooooooooooooooooooooooooooooooooooo...',
  '.oooooooooooooooooooooooooooooooooooooooooo.',
  '.oooooooooooooooooooooooooooooooooooooooooo.',
  '..ooooooooooooooooooooooooooooooooooooooooo.',
  '...oooooooooooooooooooooooooooooooooooooooo.',
  '.....ooooooooooooooooooooooooooooooooooo....',
  '........oooooooooooooooooooooooooo..........',
];
const CLOUD_1 = [
  '..........OOOOO.............................',
  '.......OOOoooooOOO..........OOOO............',
  '....OOoooooooooooooOO....OOoooooOO..........',
  '..Oooooooooooooooooooo OOoooooooooO.........',
  '.ooooooooooooooooooooooooooooooooooooO......',
  'OoooooooooooooooooooooooooooooooooooooooO...',
  'oooooooooooooooooooooooooooooooooooooooooo..',
  'oooooooooooooooooooooooooooooooooooooooooooO',
  '.ooooooooooooooooooooooooooooooooooooooooooo',
  '..oooooooooooooooooooooooooooooooooooooooooo',
  '...ooooooooooooooooooooooooooooooooooooooo..',
  '.....oooooooooooooooooooooooooooooooooo.....',
  '........oooooooooooooooooooooooo............',
  '...........ooooooooooooo....................',
];
const CLOUD_2 = [
  '...................OOOO.....................',
  '..............OOOoooooOOO...................',
  '..........OOooooooooooooooO.................',
  '.......OOoooooooooooooooooooOO..............',
  '.....Ooooooooooooooooooooooooooo............',
  '...Oooooooooooooooooooooooooooooooo.........',
  '..oooooooooooooooooooooooooooooooooooO......',
  '.Oooooooooooooooooooooooooooooooooooooooo...',
  '.oooooooooooooooooooooooooooooooooooooooooo.',
  '..oooooooooooooooooooooooooooooooooooooooo..',
  '...oooooooooooooooooooooooooooooooooooooo...',
  '.....oooooooooooooooooooooooooooooooooo.....',
  '........ooooooooooooooooooooooooooo.........',
  '............oooooooooooooooo................',
];
const CLOUD_PAL = {
  o: 'rgba(232,238,248,0.78)', // soft pale body
  O: 'rgba(255,255,255,0.88)', // bright highlight
};

// ---------------------------------------------------------------------------------------------
// WIND ARROW (16x7) — chunky LEFT-pointing white arrow (game flips/tints for direction/strength).
//   W = white body, S = soft gray edge for a touch of depth.
// ---------------------------------------------------------------------------------------------
const WIND_ARROW = [
  '....S...........',
  '...SWS..........',
  '..SWWWSSSSSSSSS.',
  '.SWWWWWWWWWWWWWW',
  '..SWWWSSSSSSSSS.',
  '...SWS..........',
  '....S...........',
];
const WIND_PAL = {
  W: 0xffffff,
  S: 0xb8c0cc,
};

// ---------------------------------------------------------------------------------------------
// Public entry point — bake everything onto the given scene's texture manager.
// ---------------------------------------------------------------------------------------------
export function bakeTextures(scene) {
  // Trebuchets: 4 team colors x 3 frames.
  for (let i = 0; i < TEAM_COLORS.length; i++) {
    bakeTrebuchet(scene, i);
  }

  // Rock.
  bakeGrid(scene, 'rock', ROCK, ROCK_PAL);

  // Explosion frames.
  bakeExplosion(scene);

  // Clouds.
  bakeGrid(scene, 'cloud_0', CLOUD_0, CLOUD_PAL);
  bakeGrid(scene, 'cloud_1', CLOUD_1, CLOUD_PAL);
  bakeGrid(scene, 'cloud_2', CLOUD_2, CLOUD_PAL);

  // Wind arrow.
  bakeGrid(scene, 'wind_arrow', WIND_ARROW, WIND_PAL);
}
