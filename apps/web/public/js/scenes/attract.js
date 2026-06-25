// attract.js — Agent GAME. Scene key 'Attract'.
//
// A self-contained, purely cosmetic "attract mode": a looping retro pixel-art
// siege used as a full-screen animated background for the desktop home screen.
// Two trebuchets lob rocks back and forth forever — no score, no win state, no
// network, no sim. It just loops.
//
// It mirrors boot.js for the ambient backdrop (sky gradient, drifting clouds,
// twinkling stars), bakes all pixel-art textures via sprites.js, and reuses the
// real baked texture keys (treb_<idx>_idle/swing/release, rock, boom_0..4,
// fx_spark/fx_ember/fx_smoke). Every texture/particle use is wrapped so a
// missing key degrades gracefully instead of throwing and breaking the loop.

import { WORLD_W, WORLD_H, TEAM_COLORS } from '/shared/constants.js';
import { bakeTextures } from '../sprites.js';

// Ground/hill geometry, kept consistent with the game's look (grass over dirt).
const GROUND_Y = Math.round(WORLD_H * 0.78);   // baseline ground surface
const HILL_RISE = 36;                           // how high the left/right hills sit above the baseline (2x world)
const GRASS_COLOR = 0x5dc961;
const GRASS_DARK = 0x3f9444;
const DIRT_COLOR = 0x6b4a2b;
const DIRT_DARK = 0x4a321d;

// Team color indices for the two siege engines (left = RED, right = BLUE).
const LEFT_TEAM = 0;
const RIGHT_TEAM = 1;

export class Attract extends Phaser.Scene {
  constructor() {
    super('Attract');
  }

  preload() {
    // Bake every procedural texture once (trebuchets, rock, booms, clouds, fx_*).
    // Done in preload so create() can immediately place sprites.
    try {
      bakeTextures(this);
    } catch (e) { /* cosmetic scene — never block on a bake failure */ }
  }

  create() {
    this._reduced =
      !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    this._clouds = [];
    this._stars = [];
    this._fxEmitters = [];
    this._fireFromLeft = true; // alternates each cycle

    this._paintSky();
    this._paintGround();
    this._spawnClouds();
    this._spawnStars();
    this._ensureBoomAnim();
    this._addTrebuchets();

    // Auto-playing siege loop. A repeating timer kicks off one volley every
    // ~2.5–3.5s, alternating sides. The timer is owned by this.time, so Phaser
    // tears it down with the scene on game.destroy(true).
    this._scheduleNextVolley(900);
  }

  // -- backdrop -----------------------------------------------------------

  _paintSky() {
    const g = this.add.graphics();
    g.setDepth(0);
    // Vertical dusk gradient painted as horizontal bands (mirrors boot.js).
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

  // A simple ground line with two flanking hills the trebuchets stand on. Grass
  // cap over a dirt body, consistent with the game's terrain palette.
  _paintGround() {
    const g = this.add.graphics();
    g.setDepth(2);

    // Surface y as a function of x: hills rise near the left/right edges and dip
    // to the baseline in the middle (a shallow valley between the two forts).
    const surfaceY = (x) => this._surfaceY(x);

    // Dirt body: fill from the surface down to the bottom of the world.
    g.fillStyle(DIRT_COLOR, 1);
    for (let x = 0; x < WORLD_W; x++) {
      const y = surfaceY(x);
      g.fillRect(x, y, 1, WORLD_H - y);
    }
    // Darker dirt band a few px below the surface for a touch of depth.
    g.fillStyle(DIRT_DARK, 1);
    for (let x = 0; x < WORLD_W; x++) {
      const y = surfaceY(x);
      g.fillRect(x, y + 10, 1, 4);
    }
    // Grass cap: a 6px grass strip riding the surface, with a 2px dark edge.
    g.fillStyle(GRASS_DARK, 1);
    for (let x = 0; x < WORLD_W; x++) {
      const y = surfaceY(x);
      g.fillRect(x, y + 4, 1, 2);
    }
    g.fillStyle(GRASS_COLOR, 1);
    for (let x = 0; x < WORLD_W; x++) {
      const y = surfaceY(x);
      g.fillRect(x, y, 1, 4);
    }
  }

  // Terrain surface height at x. Two hills near the edges, valley in the center.
  _surfaceY(x) {
    const t = x / WORLD_W; // 0..1
    // Cosine bump that is high (hill) at the edges, low (valley) in the middle.
    const hill = Math.cos(t * Math.PI * 2) * 0.5 + 0.5; // 1 at edges, 0 at center
    return Math.round(GROUND_Y - hill * HILL_RISE);
  }

  _spawnClouds() {
    const rng = mulberry32Local(99);
    const count = this._reduced ? 3 : 4;
    for (let i = 0; i < count; i++) {
      const key = 'cloud_' + (i % 3);
      if (!this._hasTexture(key)) continue;
      const x = rng() * WORLD_W;
      const y = 32 + rng() * 140;
      const c = this.add.image(x, y, key);
      c.setDepth(1);
      c.setAlpha(0.5);
      // Slow drift; even calmer under reduced motion. Speeds x2 for the 2x world.
      c._spd = (this._reduced ? 3 : 6) + rng() * (this._reduced ? 4 : 10);
      this._clouds.push(c);
    }
  }

  _spawnStars() {
    const rng = mulberry32Local(1337);
    const count = this._reduced ? 28 : 40;
    for (let i = 0; i < count; i++) {
      const x = Math.floor(rng() * WORLD_W);
      const y = Math.floor(rng() * (WORLD_H * 0.5));
      // 2x2 star dot (doubled from 1px for the 2x world).
      const s = this.add.rectangle(x, y, 2, 2, 0xffffff, 0.6 + rng() * 0.4);
      s.setDepth(1);
      s._phase = rng() * Math.PI * 2;
      s._spd = 1.5 + rng() * 2;
      this._stars.push(s);
    }
  }

  // -- trebuchets ---------------------------------------------------------

  _addTrebuchets() {
    this._trebs = [];

    const leftX = Math.round(WORLD_W * 0.16);
    const rightX = Math.round(WORLD_W * 0.84);

    this._trebs.push(this._makeTrebuchet(LEFT_TEAM, leftX, false));
    this._trebs.push(this._makeTrebuchet(RIGHT_TEAM, rightX, true));
  }

  // Build one trebuchet at x, planted on the hill surface. `faceLeft` flips the
  // RIGHT-authored sprite so it points toward the center of the map.
  _makeTrebuchet(teamIdx, x, faceLeft) {
    const y = this._surfaceY(x) + 2; // base sits just on the grass (2x world)
    const idleKey = 'treb_' + teamIdx + '_idle';
    let sprite = null;
    if (this._hasTexture(idleKey)) {
      sprite = this.add.image(x, y, idleKey);
      sprite.setOrigin(0.5, 1); // bottom-center
      sprite.flipX = faceLeft;
      sprite.setDepth(10);
    } else {
      // Degrade: a small colored block stands in for a missing trebuchet so the
      // loop still has a visible "fort" to fire from (sized x2 for the 2x world).
      sprite = this.add.rectangle(x, y - 16, 28, 32, TEAM_COLORS[teamIdx] || 0xffffff);
      sprite.setOrigin(0.5, 1);
      sprite.setDepth(10);
    }
    return { teamIdx, x, y, faceLeft, sprite };
  }

  // Swap a trebuchet to a pose frame if that texture exists (idle/swing/release).
  _setPose(treb, pose) {
    if (!treb || !treb.sprite || typeof treb.sprite.setTexture !== 'function') return;
    const key = 'treb_' + treb.teamIdx + '_' + pose;
    if (this._hasTexture(key)) {
      try { treb.sprite.setTexture(key); } catch (e) { /* ignore */ }
    }
  }

  // -- siege loop ---------------------------------------------------------

  _scheduleNextVolley(delayMs) {
    const base = typeof delayMs === 'number' ? delayMs : 2500 + Math.random() * 1000;
    this.time.delayedCall(base, () => {
      this._fireVolley();
      // Schedule the next one (2.5–3.5s) and keep looping forever.
      this._scheduleNextVolley(2500 + Math.random() * 1000);
    });
  }

  _fireVolley() {
    if (!this._trebs || this._trebs.length < 2) return;
    const shooter = this._fireFromLeft ? this._trebs[0] : this._trebs[1];
    const target = this._fireFromLeft ? this._trebs[1] : this._trebs[0];
    this._fireFromLeft = !this._fireFromLeft; // alternate each cycle

    this._animateShooter(shooter);
    this._launchRock(shooter, target);
  }

  // Visually "fire": cycle the swing/release poses if they exist, otherwise a
  // small recoil tween. Always returns to idle.
  _animateShooter(treb) {
    const hasSwing = this._hasTexture('treb_' + treb.teamIdx + '_swing');
    const hasRelease = this._hasTexture('treb_' + treb.teamIdx + '_release');

    if (hasSwing || hasRelease) {
      this._setPose(treb, hasSwing ? 'swing' : 'release');
      this.time.delayedCall(120, () => this._setPose(treb, hasRelease ? 'release' : 'idle'));
      this.time.delayedCall(320, () => this._setPose(treb, 'idle'));
    } else if (treb.sprite && typeof this.tweens !== 'undefined' && !this._reduced) {
      // Recoil fallback: a quick nudge away from the target, then back.
      const dir = treb.faceLeft ? 1 : -1;
      const homeX = treb.x;
      this.tweens.add({
        targets: treb.sprite,
        x: homeX + dir * 4,
        duration: 90,
        yoyo: true,
        ease: 'Quad.easeOut',
        onComplete: () => { if (treb.sprite) treb.sprite.x = homeX; }
      });
    }
  }

  // Spawn a rock and tween it along a parabolic arc from shooter to target.
  _launchRock(shooter, target) {
    const startX = shooter.x + (shooter.faceLeft ? -16 : 16);
    const startY = shooter.y - 32; // roughly the throwing-arm height (2x world)
    const endX = target.x;
    const endY = target.y - 20;    // land around the target's base/body (2x world)
    const apexY = Math.min(startY, endY) - (140 + Math.random() * 60);
    const duration = 1100 + Math.random() * 250;

    let rock = null;
    if (this._hasTexture('rock')) {
      rock = this.add.image(startX, startY, 'rock');
      rock.setDepth(40);
    } else {
      rock = this.add.rectangle(startX, startY, 8, 8, 0x9b9b9b);
      rock.setDepth(40);
    }

    // Drive a 0..1 value tween and place the rock on a quadratic Bezier arc so
    // it reads as a proper lobbed siege shot rather than a straight line.
    const state = { t: 0 };
    this.tweens.add({
      targets: state,
      t: 1,
      duration,
      ease: 'Linear',
      onUpdate: () => {
        if (!rock || !rock.active) return;
        const t = state.t;
        const mt = 1 - t;
        // Quadratic Bezier with a lifted control point => parabolic arc.
        const cx = (startX + endX) / 2;
        rock.x = mt * mt * startX + 2 * mt * t * cx + t * t * endX;
        rock.y = mt * mt * startY + 2 * mt * t * apexY + t * t * endY;
        if (typeof rock.setRotation === 'function') {
          rock.rotation += 0.25; // tumble
        }
      },
      onComplete: () => {
        const ix = rock && rock.active ? rock.x : endX;
        const iy = rock && rock.active ? rock.y : endY;
        if (rock) { try { rock.destroy(); } catch (e) {} }
        this._impact(ix, iy);
      }
    });
  }

  // -- impact fx ----------------------------------------------------------

  _impact(x, y) {
    this._explode(x, y);
    if (this._reduced) return; // calm mode: explosion only, no heavy bursts/shake

    // Particle speeds (px/s) and gravity (px/s^2) x2 for the 2x world.
    this._burst('fx_spark', x, y, {
      speed: { min: 60, max: 200 },
      scale: { start: 1, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan: { min: 200, max: 460 },
      quantity: 12,
      blendMode: 'ADD',
      gravityY: 120
    });
    this._burst('fx_ember', x, y, {
      speed: { min: 40, max: 160 },
      scale: { start: 1, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan: { min: 260, max: 600 },
      quantity: 8,
      blendMode: 'ADD',
      gravityY: 180
    });
    this._burst('fx_smoke', x, y - 4, {
      speed: { min: 12, max: 52 },
      scale: { start: 0.6, end: 1.6 },
      alpha: { start: 0.55, end: 0 },
      lifespan: { min: 420, max: 800 },
      quantity: 6,
      gravityY: -44
    });

    // A gentle camera shake for impact punch (skipped under reduced motion).
    try {
      if (this.cameras && this.cameras.main) {
        this.cameras.main.shake(120, 0.004);
      }
    } catch (e) { /* ignore */ }
  }

  _ensureBoomAnim() {
    // Only build the animation if every boom frame baked successfully.
    const frames = [];
    for (let i = 0; i < 5; i++) {
      if (this._hasTexture('boom_' + i)) frames.push({ key: 'boom_' + i });
    }
    this._boomFrames = frames.length;
    if (frames.length >= 2 && this.anims && !this.anims.exists('attract_boom')) {
      try {
        this.anims.create({
          key: 'attract_boom',
          frames,
          frameRate: 12, // ~80ms/frame
          repeat: 0
        });
      } catch (e) { /* ignore — explosion falls back to a static frame */ }
    }
  }

  // Play through the baked explosion frames if the animation exists; otherwise
  // show a single boom frame that fades out; otherwise nothing (never throws).
  _explode(x, y) {
    if (this._boomFrames >= 2 && this.anims && this.anims.exists('attract_boom')) {
      try {
        const s = this.add.sprite(x, y, 'boom_0');
        s.setDepth(60);
        s.play('attract_boom');
        s.once('animationcomplete', () => { try { s.destroy(); } catch (e) {} });
        return;
      } catch (e) { /* fall through to static */ }
    }
    if (this._hasTexture('boom_1')) {
      try {
        const s = this.add.sprite(x, y, 'boom_1');
        s.setDepth(60);
        this.tweens.add({
          targets: s,
          alpha: 0,
          scale: 1.3,
          duration: 360,
          onComplete: () => { try { s.destroy(); } catch (e) {} }
        });
      } catch (e) { /* ignore */ }
    }
  }

  // One-shot particle burst from a transient emitter. Defensive: bails if the
  // particle API or the texture is missing, and auto-destroys after the
  // particles die out. Mirrors game.js's _burst.
  _burst(key, x, y, cfg) {
    if (typeof this.add.particles !== 'function') return;
    if (!this._hasTexture(key)) return;
    try {
      const conf = Object.assign({ emitting: false }, cfg);
      const quantity = conf.quantity || 8;
      delete conf.quantity;
      const em = this.add.particles(x, y, key, conf);
      em.setDepth(60);
      this._fxEmitters.push(em);
      em.explode(quantity, x, y);
      const maxLife = (conf.lifespan && conf.lifespan.max) || conf.lifespan || 800;
      this.time.delayedCall(maxLife + 120, () => {
        const i = this._fxEmitters.indexOf(em);
        if (i >= 0) this._fxEmitters.splice(i, 1);
        try { em.destroy(); } catch (e) {}
      });
    } catch (e) { /* ignore — cosmetic */ }
  }

  // -- helpers ------------------------------------------------------------

  _hasTexture(key) {
    try {
      return !!(this.textures && this.textures.exists(key));
    } catch (e) {
      return false;
    }
  }

  // -- per-frame update ---------------------------------------------------

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

// Tiny local PRNG copy (mulberry32) so the decoration never depends on the
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
