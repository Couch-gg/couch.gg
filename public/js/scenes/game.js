// game.js — Agent GAME. Scene key 'Game'. The heart of the client.
//
// Renders the world identically on every client (terrain from the seed via the
// shared sim), mirrors authoritative state from the server, animates every shot
// the server broadcasts, handles keyboard aiming on your turn, and drives the
// game-over / rematch flow. All net listeners are removed on shutdown so the
// scene is cleanly restartable (rematch).

import {
  WORLD_W, WORLD_H,
  TERRAIN_FLOOR_Y,
  ANGLE_MIN, ANGLE_MAX, POWER_MIN, POWER_MAX,
  MUZZLE_DY,
  TEAM_COLORS, TEAM_NAMES
} from '/shared/constants.js';
import { generateTerrain, placePlayers, applyCrater } from '/shared/sim.js';
import { net } from '../net.js';
import { SFX } from '../sfx.js';

const DIRT_COLOR = 0x6b4a2b;
const DIRT_DARK = 0x4a321d;
const GRASS_COLOR = 0x5dc961;
const GRASS_DARK = 0x3f9444;

export class Game extends Phaser.Scene {
  constructor() {
    super('Game');
  }

  // -- lifecycle ----------------------------------------------------------
  init(data) {
    this.payload = data || {};
    // Reset all per-game scratch so a restarted scene (rematch) starts clean.
    this._bound = null;
    this._animating = false;
    this._myTurn = false;
    this._gameOver = false;
    this._turnEndsAt = 0;
    this._lastTickSecond = -1;
    this._aimAngle = 45;
    this._aimPower = 70;
    this._heldAngle = null; // remembered between turns
    this._heldPower = null;
    this._trebs = new Map();   // id -> { container, sprite, label, hpBg, hpFill, p }
    this._notes = [];
    // Monotonic counter bumped every time a turn/left/shot-next is applied. The
    // pending _afterShot from a shot captures this at fire time and skips its
    // (now stale) m.next if a later turn/left advanced the epoch meanwhile.
    this._turnEpoch = 0;
    this._projUpdate = null;
  }

  create() {
    const data = this.payload;
    this.seed = data.seed;
    this.players = (data.players || []).map((p) => ({ ...p }));

    // --- Rebuild terrain deterministically from the seed -------------------
    // generateTerrain + placePlayers reproduce the flattened pads exactly as on
    // the server; authoritative x/y/hp still come from the payload.
    this.heights = generateTerrain(this.seed);
    placePlayers(this.heights, this.players.length, this.seed);

    // --- Background layers -------------------------------------------------
    this._paintSky();
    this._spawnClouds();
    this._paintMountains();

    // --- Terrain (redrawable) ---------------------------------------------
    this.terrainGfx = this.add.graphics();
    this.terrainGfx.setDepth(10);
    this._redrawTerrain();

    // --- Trebuchets --------------------------------------------------------
    for (const p of this.players) {
      this._addTrebuchet(p);
    }

    // --- Projectile (reused) + explosion animation -------------------------
    this.rock = this.add.image(-50, -50, 'rock');
    this.rock.setDepth(40);
    this.rock.setVisible(false);
    this._ensureBoomAnims();

    // --- HUD ---------------------------------------------------------------
    this._buildHud();

    // --- Aim line ----------------------------------------------------------
    this.aimGfx = this.add.graphics();
    this.aimGfx.setDepth(45);

    // --- Restore remembered aim, set up turn state -------------------------
    this.turn = data.turn;
    this.wind = data.wind;
    this._turnEndsAt = data.turnEndsAt || 0;
    this._applyTurn(data.turn, false);

    // --- Input -------------------------------------------------------------
    this.cursors = this.input.keyboard.createCursorKeys();
    this.shiftKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);
    this.spaceKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    // Discrete-press handling for arrows + space (held repeat handled in update).
    this.input.keyboard.on('keydown-SPACE', this._tryFire, this);
    // Click anywhere / on the FIRE button to fire too.
    this.input.on('pointerdown', this._onPointerDown, this);

    // --- Net listeners (ALL removed in shutdown) ---------------------------
    // Seed hostId from the registry (set by main.js from the lobby that preceded
    // this start); keep listening for live host changes (e.g. host promotion).
    this._hostId = this.registry.get('hostId') || null;
    this._onShot = (m) => this._handleShot(m);
    this._onTurn = (m) => this._handleTurn(m);
    this._onLeft = (m) => this._handleLeft(m);
    this._onLobby = (m) => { if (m && m.hostId) this._hostId = m.hostId; };
    net.on('shot', this._onShot);
    net.on('turn', this._onTurn);
    net.on('left', this._onLeft);
    net.on('lobby', this._onLobby);

    // Clean teardown on scene shutdown (rematch restart / leave).
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this._shutdown, this);

    this._refreshHud();
  }

  _shutdown() {
    net.off('shot', this._onShot);
    net.off('turn', this._onTurn);
    net.off('left', this._onLeft);
    net.off('lobby', this._onLobby);
    if (this.input && this.input.keyboard) {
      this.input.keyboard.off('keydown-SPACE', this._tryFire, this);
    }
    if (this.input) {
      this.input.off('pointerdown', this._onPointerDown, this);
    }
    // Detach any in-flight projectile ticker so it can't fire after teardown.
    if (this._projUpdate) {
      this.events.off('update', this._projUpdate);
      this._projUpdate = null;
    }
  }

  // -- background ---------------------------------------------------------
  _paintSky() {
    const g = this.add.graphics();
    g.setDepth(0);
    const top = { r: 0x12, g: 0x10, b: 0x26 };
    const bot = { r: 0x5a, g: 0x2c, b: 0x42 };
    const bands = 60;
    const bh = WORLD_H / bands;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      const r = Math.round(top.r + (bot.r - top.r) * t);
      const gg = Math.round(top.g + (bot.g - top.g) * t);
      const b = Math.round(top.b + (bot.b - top.b) * t);
      g.fillStyle((r << 16) | (gg << 8) | b, 1);
      g.fillRect(0, Math.floor(i * bh), WORLD_W, Math.ceil(bh) + 1);
    }
    // A soft setting sun.
    g.fillStyle(0xffcf8a, 0.18);
    g.fillCircle(WORLD_W * 0.5, WORLD_H * 0.42, 34);
    g.fillStyle(0xffe0a8, 0.22);
    g.fillCircle(WORLD_W * 0.5, WORLD_H * 0.42, 22);
  }

  _spawnClouds() {
    this._clouds = [];
    const rng = this._rng(this.seed ^ 0x51a4);
    for (let i = 0; i < 4; i++) {
      const c = this.add.image(rng() * WORLD_W, 14 + rng() * 60, 'cloud_' + (i % 3));
      c.setDepth(2);
      c.setAlpha(0.5);
      c._spd = 2 + rng() * 4;
      this._clouds.push(c);
    }
  }

  _paintMountains() {
    const g = this.add.graphics();
    g.setDepth(3);
    const rng = this._rng(this.seed ^ 0x9e37);
    // Two layered silhouettes, darker behind.
    this._mountainLayer(g, rng, 0x241a30, WORLD_H * 0.62, 26);
    this._mountainLayer(g, rng, 0x352440, WORLD_H * 0.70, 18);
  }

  _mountainLayer(g, rng, color, baseY, amp) {
    g.fillStyle(color, 1);
    g.beginPath();
    g.moveTo(0, WORLD_H);
    const step = 24;
    g.lineTo(0, baseY);
    for (let x = 0; x <= WORLD_W; x += step) {
      const y = baseY - rng() * amp;
      g.lineTo(x, y);
    }
    g.lineTo(WORLD_W, WORLD_H);
    g.closePath();
    g.fillPath();
  }

  // -- terrain ------------------------------------------------------------
  _redrawTerrain() {
    const g = this.terrainGfx;
    g.clear();
    const h = this.heights;
    // Solid dirt body.
    g.fillStyle(DIRT_COLOR, 1);
    g.beginPath();
    g.moveTo(0, WORLD_H);
    g.lineTo(0, h[0]);
    for (let x = 1; x < WORLD_W; x++) g.lineTo(x, h[x]);
    g.lineTo(WORLD_W - 1, WORLD_H);
    g.closePath();
    g.fillPath();

    // Darker underground band for a touch of depth.
    g.fillStyle(DIRT_DARK, 1);
    for (let x = 0; x < WORLD_W; x++) {
      const top = Math.min(TERRAIN_FLOOR_Y, h[x] + 10);
      g.fillRect(x, top, 1, WORLD_H - top);
    }

    // 2px grass cap line (skip near-vertical crater walls so grass doesn't smear).
    for (let x = 0; x < WORLD_W; x++) {
      const y = h[x];
      const neighbor = h[Math.min(WORLD_W - 1, x + 1)];
      const steep = Math.abs(neighbor - y) > 6;
      g.fillStyle(steep ? GRASS_DARK : GRASS_COLOR, 1);
      g.fillRect(x, y, 1, 2);
      if (!steep) {
        g.fillStyle(GRASS_DARK, 1);
        g.fillRect(x, y + 2, 1, 1);
      }
    }
  }

  // -- trebuchets ---------------------------------------------------------
  _addTrebuchet(p) {
    const c = p.colorIdx | 0;
    const sprite = this.add.image(0, 0, 'treb_' + c + '_idle');
    sprite.setOrigin(0.5, 1); // bottom-center
    // Face map center.
    sprite.flipX = p.x > WORLD_W / 2;

    const label = this.add.text(0, 0, (p.name || TEAM_NAMES[c] || 'P'), {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '6px',
      color: '#ffffff'
    });
    label.setOrigin(0.5, 1);
    label.setResolution(2);

    const hpBg = this.add.graphics();
    const hpFill = this.add.graphics();

    const container = this.add.container(p.x, p.y, [sprite, hpBg, hpFill, label]);
    // children are positioned relative to container.
    sprite.setPosition(0, 0);

    const t = { container, sprite, label, hpBg, hpFill, p, colorIdx: c, dead: false };
    container.setDepth(30);
    this._trebs.set(p.id, t);
    this._layoutTreb(t);
    this._drawHp(t);
    // Start payload carries full hp; guard anyway in case a rematch payload differs.
    if (p.hp <= 0) this._killTreb(t, false);
    return t;
  }

  _layoutTreb(t) {
    // Label + HP bar float above the trebuchet (sprite is 26 tall, origin bottom).
    // Default offsets place the label at container.y-32 and the HP bar at
    // container.y-28. On peak terrain the player sits near the top, which would
    // push these above the turn banner. Clamp so neither rises above world y=18.
    const cy = t.container.y;
    const MIN_WORLD_Y = 18;
    // Keep the same 4px gap between the HP bar and the label below it.
    let hpY = -28;
    let labelY = -32;
    // The topmost drawn pixel is the HP bar background (hpY - 1).
    if (cy + (hpY - 1) < MIN_WORLD_Y) {
      const shift = MIN_WORLD_Y - (cy + (hpY - 1));
      hpY += shift;
      labelY += shift;
    }
    t.label.setPosition(0, labelY);
    // HP bar geometry stored for redraw.
    t._hpW = 22;
    t._hpY = hpY;
  }

  _drawHp(t) {
    const w = t._hpW;
    const y = t._hpY;
    const x = -w / 2;
    const hp = Math.max(0, t.p.hp);
    const frac = Math.max(0, Math.min(1, hp / 100));
    t.hpBg.clear();
    t.hpBg.fillStyle(0x000000, 0.85);
    t.hpBg.fillRect(x - 1, y - 1, w + 2, 5);
    t.hpBg.fillStyle(0x2a2a2a, 1);
    t.hpBg.fillRect(x, y, w, 3);
    t.hpFill.clear();
    if (frac > 0) {
      t.hpFill.fillStyle(TEAM_COLORS[t.colorIdx] || 0xffffff, 1);
      t.hpFill.fillRect(x, y, Math.max(1, Math.round(w * frac)), 3);
    }
  }

  _killTreb(t, withFx) {
    if (t.dead) return;
    t.dead = true;
    t.p.alive = false;
    t.p.hp = 0;
    this._drawHp(t);
    if (withFx) {
      // Topple + fade the trebuchet.
      this.tweens.add({
        targets: t.container,
        angle: t.sprite.flipX ? -75 : 75,
        y: t.container.y + 6,
        alpha: 0,
        duration: 650,
        ease: 'Quad.easeIn',
        onComplete: () => { t.container.setVisible(false); }
      });
    } else {
      t.container.setVisible(false);
    }
  }

  _removeTreb(id, withPoof) {
    const t = this._trebs.get(id);
    if (!t) return;
    if (withPoof) {
      this._smallPoof(t.container.x, t.container.y - 10);
    }
    t.container.destroy();
    this._trebs.delete(id);
  }

  // -- HUD ----------------------------------------------------------------
  _buildHud() {
    const fontBig = {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '8px',
      color: '#ffffff'
    };
    const fontSmall = {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '6px',
      color: '#ffffff'
    };

    // Wind arrow + text, centered top.
    this.windArrow = this.add.image(WORLD_W / 2, 12, 'wind_arrow');
    this.windArrow.setDepth(80);
    this.windText = this.add.text(WORLD_W / 2, 20, '', fontSmall);
    this.windText.setOrigin(0.5, 0);
    this.windText.setDepth(80);

    // Turn banner (top-left).
    this.turnBanner = this.add.text(4, 4, '', fontBig);
    this.turnBanner.setDepth(80);

    // Countdown (top-right).
    this.countText = this.add.text(WORLD_W - 4, 4, '', fontBig);
    this.countText.setOrigin(1, 0);
    this.countText.setDepth(80);

    // Aim readout (bottom-left).
    this.aimText = this.add.text(4, WORLD_H - 12, '', fontSmall);
    this.aimText.setDepth(80);

    // FIRE button (bottom-right) — chunky pixel box.
    this.fireBtnRect = new Phaser.Geom.Rectangle(WORLD_W - 56, WORLD_H - 20, 52, 16);
    this.fireBtnBg = this.add.graphics();
    this.fireBtnBg.setDepth(80);
    this.fireBtnText = this.add.text(WORLD_W - 30, WORLD_H - 12, 'FIRE', {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '7px',
      color: '#1a0a0a'
    });
    this.fireBtnText.setOrigin(0.5, 0.5);
    this.fireBtnText.setDepth(81);
    this._drawFireBtn();
  }

  _drawFireBtn() {
    const r = this.fireBtnRect;
    const enabled = this._myTurn && !this._animating && !this._gameOver;
    const g = this.fireBtnBg;
    g.clear();
    g.fillStyle(0x000000, 0.9);
    g.fillRect(r.x - 2, r.y - 2, r.width + 4, r.height + 4);
    g.fillStyle(enabled ? 0xe8c44d : 0x554a2a, 1);
    g.fillRect(r.x, r.y, r.width, r.height);
    g.lineStyle(2, enabled ? 0xfff0b0 : 0x332a18, 1);
    g.strokeRect(r.x, r.y, r.width, r.height);
    this.fireBtnText.setColor(enabled ? '#1a0a0a' : '#7a6a40');
    this.fireBtnBg.setVisible(true);
    this.fireBtnText.setVisible(true);
  }

  _refreshHud() {
    // Wind arrow: points in wind direction (wind > 0 blows right).
    const w = this.wind || 0;
    const mag = Math.abs(w);
    const roundedMag = Math.round(mag);
    // Base art points LEFT; flipX to point right when wind is positive.
    this.windArrow.flipX = w > 0;
    const len = 1 + Math.min(1.6, mag / 25);
    this.windArrow.setScale(len, 1);
    this.windArrow.setTint(0xffffff);
    // Hide the arrow entirely when the rounded magnitude is 0 (no meaningful
    // direction); the 'WIND · 0' text stays.
    this.windArrow.setVisible(roundedMag !== 0);
    const dir = roundedMag === 0 ? '·' : (w > 0 ? '►' : '◄');
    this.windText.setText('WIND ' + dir + ' ' + roundedMag);

    // Turn banner.
    const cur = this._trebs.get(this.turn);
    if (this._gameOver) {
      this.turnBanner.setText('');
    } else if (this._myTurn) {
      this.turnBanner.setText('YOUR TURN');
      this.turnBanner.setColor('#ffe066');
    } else if (cur) {
      const name = cur.p.name || TEAM_NAMES[cur.colorIdx];
      this.turnBanner.setText(name + "'S TURN");
      this.turnBanner.setColor('#ffffff');
    } else {
      this.turnBanner.setText('');
    }

    // Aim readout.
    if (this._myTurn && !this._gameOver) {
      this.aimText.setText('ANGLE ' + this._aimAngle + '  POWER ' + this._aimPower);
      this.aimText.setVisible(true);
    } else {
      this.aimText.setVisible(false);
    }

    this._drawFireBtn();
    this._drawAimLine();
  }

  _drawAimLine() {
    this.aimGfx.clear();
    if (!this._myTurn || this._animating || this._gameOver) return;
    const me = this._trebs.get(net.you);
    if (!me || me.dead) return;
    const baseX = me.container.x;
    const baseY = me.container.y - MUZZLE_DY;
    const rad = (this._aimAngle * Math.PI) / 180;
    const len = 14 + (this._aimPower / 100) * 26;
    const ex = baseX + Math.cos(rad) * len;
    const ey = baseY - Math.sin(rad) * len;
    // Dotted-ish aim line.
    this.aimGfx.lineStyle(1, 0xffffff, 0.85);
    this.aimGfx.beginPath();
    this.aimGfx.moveTo(baseX, baseY);
    this.aimGfx.lineTo(ex, ey);
    this.aimGfx.strokePath();
    // Arrow tip.
    this.aimGfx.fillStyle(0xffe066, 1);
    this.aimGfx.fillCircle(ex, ey, 1.6);
  }

  // -- turn / input -------------------------------------------------------
  _applyTurn(turnId, announce) {
    this.turn = turnId;
    const wasMine = this._myTurn;
    this._myTurn = (turnId === net.you);
    if (this._myTurn) {
      // Restore remembered aim if any.
      if (this._heldAngle != null) this._aimAngle = this._heldAngle;
      if (this._heldPower != null) this._aimPower = this._heldPower;
      this._clampAim();
      if (announce && !wasMine) {
        try { SFX.play('yourturn'); } catch (e) { /* ignore */ }
      }
    }
    this._lastTickSecond = -1;
    this._refreshHud();
  }

  _clampAim() {
    this._aimAngle = Math.max(ANGLE_MIN, Math.min(ANGLE_MAX, Math.round(this._aimAngle)));
    this._aimPower = Math.max(POWER_MIN, Math.min(POWER_MAX, Math.round(this._aimPower)));
  }

  _onPointerDown(pointer) {
    if (!this._myTurn || this._animating || this._gameOver) return;
    // Convert screen pointer to world coords (FIT scale handled by Phaser).
    const x = pointer.worldX;
    const y = pointer.worldY;
    if (Phaser.Geom.Rectangle.Contains(this.fireBtnRect, x, y)) {
      this._tryFire();
    }
  }

  _tryFire() {
    if (!this._myTurn || this._animating || this._gameOver) return;
    const me = this._trebs.get(net.you);
    if (!me || me.dead) return;
    this._clampAim();
    this._heldAngle = this._aimAngle;
    this._heldPower = this._aimPower;
    // Lock input until the shot resolves.
    this._animating = true;
    this._myTurn = false;
    this._refreshHud();
    net.send({ t: 'fire', angle: this._aimAngle, power: this._aimPower });
  }

  update(time, delta) {
    // Cloud drift.
    if (this._clouds) {
      const dt = delta / 1000;
      for (const c of this._clouds) {
        c.x += c._spd * dt;
        if (c.x - c.width / 2 > WORLD_W) c.x = -c.width / 2;
      }
    }

    // Flash the YOUR TURN banner.
    if (this._myTurn && !this._gameOver && this.turnBanner) {
      this.turnBanner.setAlpha(0.55 + 0.45 * (0.5 + 0.5 * Math.sin(time / 140)));
    } else if (this.turnBanner) {
      this.turnBanner.setAlpha(1);
    }

    // Countdown.
    if (!this._gameOver && this._turnEndsAt) {
      const remMs = this._turnEndsAt - Date.now();
      if (remMs <= 0) {
        // Time's up — show nothing rather than a frozen red '0s'.
        this.countText.setText('');
      } else {
        const rem = Math.max(0, Math.ceil(remMs / 1000));
        this.countText.setText(rem + 's');
        this.countText.setColor(rem <= 5 ? '#ff5555' : '#ffffff');
        if (rem <= 5 && rem > 0 && rem !== this._lastTickSecond && this._myTurn) {
          this._lastTickSecond = rem;
          try { SFX.play('tick'); } catch (e) { /* ignore */ }
        }
      }
    } else if (this.countText) {
      this.countText.setText('');
    }

    // Keyboard aiming (held-repeat with discrete-press for crispness).
    if (this._myTurn && !this._animating && !this._gameOver) {
      this._handleAimKeys(time);
    }
  }

  _handleAimKeys(time) {
    const shift = this.shiftKey.isDown;
    const step = shift ? 5 : 1;
    let changed = false;

    const just = Phaser.Input.Keyboard.JustDown;
    const repeatOk = (key) => {
      // Allow an initial press, then auto-repeat after a short hold.
      if (just(key)) { key._nextRepeat = time + 280; return true; }
      if (key.isDown && key._nextRepeat != null && time >= key._nextRepeat) {
        key._nextRepeat = time + 45;
        return true;
      }
      return false;
    };

    if (repeatOk(this.cursors.left)) { this._aimAngle += step; changed = true; }
    if (repeatOk(this.cursors.right)) { this._aimAngle -= step; changed = true; }
    if (repeatOk(this.cursors.up)) { this._aimPower += step; changed = true; }
    if (repeatOk(this.cursors.down)) { this._aimPower -= step; changed = true; }

    if (changed) {
      this._clampAim();
      this._heldAngle = this._aimAngle;
      this._heldPower = this._aimPower;
      this.aimText.setText('ANGLE ' + this._aimAngle + '  POWER ' + this._aimPower);
      this._drawAimLine();
    }
  }

  // -- shot animation -----------------------------------------------------
  _handleShot(m) {
    if (!m) return;
    this._animating = true;
    this._myTurn = false;
    this._refreshHud();

    // Capture the current turn epoch. If a later turn/left message advances it
    // while this shot is animating, _afterShot must NOT re-apply this shot's
    // (now stale) m.next.
    const shotEpoch = this._turnEpoch;

    const shooter = this._trebs.get(m.shooterId);
    // Fire animation on shooter.
    if (shooter && !shooter.dead) {
      shooter.sprite.setTexture('treb_' + shooter.colorIdx + '_fire');
      this.time.delayedCall(420, () => {
        if (shooter.sprite && !shooter.dead) {
          shooter.sprite.setTexture('treb_' + shooter.colorIdx + '_idle');
        }
      });
    }
    try { SFX.play('fire'); } catch (e) { /* ignore */ }

    const traj = m.trajectory || [];
    this._animateProjectile(traj, () => this._resolveImpact(m, shotEpoch));
  }

  _animateProjectile(traj, done) {
    // Defensive: tear down any in-flight projectile ticker before starting a
    // new one so two shot animations can never run simultaneously.
    if (this._projUpdate) {
      this.events.off('update', this._projUpdate);
      this._projUpdate = null;
    }
    if (!traj.length) { done(); return; }
    this.rock.setVisible(true);
    this.rock.setPosition(traj[0][0], traj[0][1]);
    this.rock.setRotation(0);

    // Each sample represents 1/60 s of flight. Step through time-based.
    const sampleDt = 1 / 60; // seconds per sample
    let elapsed = 0;
    const totalT = (traj.length - 1) * sampleDt;
    const startTime = this.time.now;

    const tick = () => {
      elapsed = (this.time.now - startTime) / 1000;
      let f = totalT > 0 ? elapsed / totalT : 1;
      if (f >= 1) {
        const last = traj[traj.length - 1];
        this.rock.setPosition(last[0], last[1]);
        // Detach the LOCAL listener (this._projUpdate may have been reassigned
        // by a newer animation) and only clear the field if it's still ours.
        this.events.off('update', tick);
        if (this._projUpdate === tick) this._projUpdate = null;
        done();
        return;
      }
      const fi = f * (traj.length - 1);
      const i = Math.floor(fi);
      const frac = fi - i;
      const a = traj[i];
      const b = traj[Math.min(traj.length - 1, i + 1)];
      const x = a[0] + (b[0] - a[0]) * frac;
      const y = a[1] + (b[1] - a[1]) * frac;
      this.rock.setPosition(x, y);
      this.rock.rotation += 0.35;
    };
    this._projUpdate = tick;
    this.events.on('update', tick);
  }

  _resolveImpact(m, shotEpoch) {
    this.rock.setVisible(false);
    const res = m.result || {};

    // Explosion at impact (if any).
    const impact = res.impact;
    const hasDeaths = (res.deaths || []).length > 0;
    if (impact) {
      this._explode(impact.x, impact.y, hasDeaths);
      try { SFX.play(hasDeaths ? 'death' : 'explode'); } catch (e) { /* ignore */ }
      // Camera shake.
      this.cameras.main.shake(hasDeaths ? 320 : 180, hasDeaths ? 0.012 : 0.006);
      // Carve terrain.
      if (res.crater) {
        applyCrater(this.heights, res.crater);
        this._redrawTerrain();
      }
    }

    // Apply hits (hp authoritative from server).
    for (const h of (res.hits || [])) {
      const t = this._trebs.get(h.id);
      if (!t) continue;
      t.p.hp = h.hp;
      this._drawHp(t);
      if (!t.dead) this._flashHit(t);
    }

    // Settle (drop) players whose ground was carved out.
    for (const s of (res.settled || [])) {
      const t = this._trebs.get(s.id);
      if (!t || t.dead) continue;
      t.p.y = s.y;
      this.tweens.add({
        targets: t.container,
        y: s.y,
        duration: 260,
        ease: 'Bounce.easeOut'
      });
    }

    // Deaths: bigger boom + remove trebuchet.
    for (const id of (res.deaths || [])) {
      const t = this._trebs.get(id);
      if (t) {
        this._explode(t.container.x, t.container.y - 8, true);
        this._killTreb(t, true);
      }
    }

    // Let the explosion breathe, then advance state.
    this.time.delayedCall(impact ? 520 : 120, () => this._afterShot(m, shotEpoch));
  }

  _afterShot(m, shotEpoch) {
    this._animating = false;
    if (m.winner || m.draw) {
      this._endGame(m.winner, m.draw);
      return;
    }
    // If a later turn/left message advanced the epoch while this shot animated,
    // its turn already applied — do NOT re-apply this shot's stale m.next.
    if (shotEpoch != null && shotEpoch !== this._turnEpoch) {
      this._refreshHud();
      return;
    }
    if (m.next) {
      this.wind = m.next.wind;
      this._turnEndsAt = m.next.turnEndsAt || 0;
      this._turnEpoch++;
      this._applyTurn(m.next.turn, true);
    }
    this._refreshHud();
  }

  // -- explosions / fx ----------------------------------------------------
  _ensureBoomAnims() {
    if (!this.anims.exists('boom')) {
      this.anims.create({
        key: 'boom',
        frames: [0, 1, 2, 3, 4].map((i) => ({ key: 'boom_' + i })),
        frameRate: 12, // ~80ms/frame
        repeat: 0
      });
    }
  }

  _explode(x, y, big) {
    const s = this.add.sprite(x, y, 'boom_0');
    s.setDepth(60);
    s.setScale(big ? 1.4 : 1);
    s.play('boom');
    s.once('animationcomplete', () => s.destroy());
  }

  _flashHit(t) {
    t.sprite.setTintFill(0xffffff);
    this.time.delayedCall(90, () => { if (t.sprite) t.sprite.clearTint(); });
    this.time.delayedCall(180, () => { if (t.sprite && !t.dead) t.sprite.setTintFill(0xffffff); });
    this.time.delayedCall(270, () => { if (t.sprite) t.sprite.clearTint(); });
  }

  _smallPoof(x, y) {
    const s = this.add.sprite(x, y, 'boom_2');
    s.setDepth(60);
    s.setScale(0.7);
    s.setAlpha(0.85);
    this.tweens.add({
      targets: s,
      alpha: 0,
      scale: 1.1,
      duration: 360,
      onComplete: () => s.destroy()
    });
  }

  // -- in-canvas toast notes ---------------------------------------------
  _note(text) {
    // Long notes (e.g. '<LONGNAME> WINS!') shrink to 8px so they don't crowd
    // the 480px stage.
    const fontSize = (text && text.length > 16) ? '8px' : '10px';
    const t = this.add.text(WORLD_W / 2, WORLD_H * 0.34, text, {
      fontFamily: '"Press Start 2P", monospace',
      fontSize,
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 3
    });
    t.setOrigin(0.5, 0.5);
    t.setDepth(90);
    this.tweens.add({
      targets: t,
      y: t.y - 14,
      alpha: 0,
      duration: 1600,
      ease: 'Quad.easeIn',
      onComplete: () => t.destroy()
    });
  }

  // -- timeout skip -------------------------------------------------------
  _handleTurn(m) {
    if (!m) return;
    if (m.skipped) this._note('TIME UP');
    this.wind = m.wind;
    this._turnEndsAt = m.turnEndsAt || 0;
    this._turnEpoch++;
    this._applyTurn(m.turn, true);
  }

  // -- player left --------------------------------------------------------
  _handleLeft(m) {
    if (!m) return;
    const t = this._trebs.get(m.id);
    const name = (t && t.p.name) || (m.name) || 'PLAYER';
    this._note(name + ' LEFT');
    if (t) {
      this._removeTreb(m.id, true);
    }
    if (m.winner || m.draw) {
      this._animating = false;
      this._endGame(m.winner || null, !!m.draw);
      return;
    }
    if (m.next) {
      this.wind = m.next.wind;
      this._turnEndsAt = m.next.turnEndsAt || 0;
      this._turnEpoch++;
      this._applyTurn(m.next.turn, true);
    }
    this._refreshHud();
  }

  // -- game over ----------------------------------------------------------
  _endGame(winnerId, draw) {
    if (this._gameOver) return;
    this._gameOver = true;
    this._myTurn = false;
    this._animating = false;
    this._refreshHud();

    let winnerName = '';
    let youWin = false;
    if (!draw && winnerId) {
      const t = this._trebs.get(winnerId);
      winnerName = (t && t.p.name) ||
        (this.players.find((p) => p.id === winnerId) || {}).name || 'WINNER';
      youWin = (winnerId === net.you);
    }

    try { SFX.play(youWin ? 'win' : 'lose'); } catch (e) { /* ignore */ }

    const isHost = (this._hostId === net.you);

    // Brief in-canvas banner, then hand off to the HTML game-over panel.
    this._note(draw ? 'DRAW!' : (youWin ? 'YOU WIN!' : winnerName + ' WINS!'));
    this.time.delayedCall(900, () => {
      document.dispatchEvent(new CustomEvent('ui:gameover', {
        detail: { winnerName, youWin, draw, isHost }
      }));
    });
  }

  // -- util ---------------------------------------------------------------
  _rng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
}
