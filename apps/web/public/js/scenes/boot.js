// boot.js — Agent GAME
// Bakes all procedural textures, then shows a subtle animated retro background
// while the HTML menu/lobby (owned by ui.js) sits on top. main.js starts the
// 'Game' scene when the server says so — Boot performs no transition logic.

import { WORLD_W, WORLD_H } from '/shared/constants.js';
import { bakeTextures } from '../sprites.js';

export class Boot extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create() {
    // Bake every texture once up front (trebuchets, rock, booms, clouds, arrow).
    bakeTextures(this);

    // Ambient backdrop behind the HTML overlay: a dark dusk gradient with a few
    // slow-drifting clouds and a faint scanline shimmer. Purely decorative.
    this._paintSky();
    this._spawnClouds();

    // Twinkle dots for a little life on the menu screen.
    this._stars = [];
    const rng = mulberry32Local(1337);
    for (let i = 0; i < 40; i++) {
      const x = Math.floor(rng() * WORLD_W);
      const y = Math.floor(rng() * (WORLD_H * 0.55));
      // 2x2 star dot (doubled from 1px for the 2x world).
      const s = this.add.rectangle(x, y, 2, 2, 0xffffff, 0.6 + rng() * 0.4);
      s.setDepth(1);
      s._phase = rng() * Math.PI * 2;
      s._spd = 1.5 + rng() * 2;
      this._stars.push(s);
    }
  }

  _paintSky() {
    const g = this.add.graphics();
    g.setDepth(0);
    // Vertical dusk gradient painted as horizontal bands.
    const top = { r: 0x12, g: 0x10, b: 0x26 };
    const bot = { r: 0x4a, g: 0x24, b: 0x3a };
    const bands = 54;
    const bh = WORLD_H / bands;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      const r = Math.round(top.r + (bot.r - top.r) * t);
      const gg = Math.round(top.g + (bot.g - top.g) * t);
      const b = Math.round(top.b + (bot.b - top.b) * t);
      g.fillStyle((r << 16) | (gg << 8) | b, 1);
      g.fillRect(0, Math.floor(i * bh), WORLD_W, Math.ceil(bh) + 1);
    }
  }

  _spawnClouds() {
    this._clouds = [];
    const rng = mulberry32Local(99);
    for (let i = 0; i < 4; i++) {
      const key = 'cloud_' + (i % 3);
      const x = rng() * WORLD_W;
      const y = 40 + rng() * 160;
      const c = this.add.image(x, y, key);
      c.setDepth(1);
      c.setAlpha(0.55);
      c._spd = 6 + rng() * 10;
      this._clouds.push(c);
    }
  }

  update(time, delta) {
    const dt = delta / 1000;
    if (this._clouds) {
      for (const c of this._clouds) {
        c.x += c._spd * dt;
        if (c.x - c.width > WORLD_W) c.x = -c.width;
      }
    }
    if (this._stars) {
      const tt = time / 1000;
      for (const s of this._stars) {
        s.setAlpha(0.45 + 0.35 * (0.5 + 0.5 * Math.sin(tt * s._spd + s._phase)));
      }
    }
  }
}

// Tiny local PRNG copy (mulberry32) so Boot's decoration never depends on the
// shared module's load order. Deterministic, used only for cosmetic placement.
function mulberry32Local(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
