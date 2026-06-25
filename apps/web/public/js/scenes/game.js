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
  ELEV_MIN, ELEV_MAX, POWER_MIN, POWER_MAX,
  CHARGE_TIME_MS,
  MUZZLE_DY,
  TEAM_COLORS, TEAM_NAMES
} from '/shared/constants.js';
import { generateTerrain, placePlayers, applyCrater, buildCastles } from '/shared/sim.js';
import { net } from '../net.js';
import { SFX } from '../sfx.js';

const DIRT_COLOR = 0x6b4a2b;
const DIRT_DARK = 0x4a321d;
const GRASS_COLOR = 0x5dc961;
const GRASS_DARK = 0x3f9444;

// V2 castle stone palette — 3 gray shades, picked per-block by a seeded index
// hash so each wall has subtle variation. Index 0 = face, 1 = light edge,
// 2 = dark shade.
const STONE_SHADES = [0x8b8b94, 0xa8a8b2, 0x6e6e78];
const STONE_MORTAR = 0x4a4a52;

// V2 aim bounds in the 0=right / 90=up / 180=left convention:
//   right shots  : ELEV_MIN..ELEV_MAX            (elevation == angle)
//   left  shots  : 180-ELEV_MAX..180-ELEV_MIN    (elevation == 180-angle)
// The dead gap (ELEV_MAX+1 .. 180-ELEV_MAX-1) is snapped across.
const RIGHT_LO = ELEV_MIN;            // 50
const RIGHT_HI = ELEV_MAX;            // 85
const LEFT_LO = 180 - ELEV_MAX;       // 95
const LEFT_HI = 180 - ELEV_MIN;       // 130

export class Game extends Phaser.Scene {
  constructor() {
    super('Game');
  }

  // -- lifecycle ----------------------------------------------------------
  init(data) {
    this.payload = data || {};
    // Local hotseat: everyone shares one screen and one keyboard. The driver
    // sets net.you to the active player each turn, so _myTurn tracks "the
    // player whose turn it is". We tweak the turn banner + game-over detail
    // accordingly. Online payloads never set `local`, so this is a no-op there.
    this._local = data && data.local === true;
    // Reset all per-game scratch so a restarted scene (rematch) starts clean.
    this._bound = null;
    this._animating = false;
    this._myTurn = false;
    this._gameOver = false;
    this._turnEndsAt = 0;
    this._lastTickSecond = -1;
    // Aim angle in the 0=right/90=up/180=left convention. Default: 60° elevation
    // shooting right (a sensible trebuchet lob). Snapped into a valid band by
    // _clampAim().
    this._aimAngle = 60;
    this._heldAngle = null; // remembered between turns
    // --- Hold-to-charge firing (7.3) ---------------------------------------
    // Power is no longer arrow-controlled; it charges while SPACE or the FIRE
    // button is held, from POWER_MIN to POWER_MAX over CHARGE_TIME_MS.
    this._charging = false;
    this._chargePower = POWER_MIN; // current charged power while holding
    this._chargeStart = 0;         // this.time.now when the hold began
    // Guard so a single Space *hold* (key-repeat) can't retrigger a new charge
    // after a release-fire — stays true until the next keyup.
    this._spaceLatched = false;
    this._chargeSource = null;     // 'key' | 'pointer' | null
    this._trebs = new Map();   // id -> { container, sprite, label, hpBg, hpFill, p }
    // --- Castles (7.5) -----------------------------------------------------
    // castleByOwner: ownerId -> { gfx, blocks:[{x,y,w,h}], alive:[bool] }.
    // Destroyed block indices are mirrored from result.castleHits[].blocks.
    this._castles = new Map();
    this._notes = [];
    // Monotonic counter bumped every time a turn/left/shot-next is applied. The
    // pending _afterShot from a shot captures this at fire time and skips its
    // (now stale) m.next if a later turn/left advanced the epoch meanwhile.
    this._turnEpoch = 0;
    this._projUpdate = null;

    // --- V3 §8.3 audio + VFX scratch ---------------------------------------
    // Reset so a rematch restart (which re-runs init+create) never carries
    // stale references. These back the sustained charge tone, the charge glow
    // aura, the projectile trail, transient impact bursts, the big-plunge
    // screen flash and the one-shot impact cue guards.
    this._chargeToneOn = false;    // guards SFX.startCharge/stopCharge pairing
    this._trailEmitter = null;     // projectile trail particle emitter
    this._chargeGlow = null;       // pulsing aura on the active trebuchet
    this._flashRect = null;        // reused white-flash overlay
    this._fxEmitters = [];         // transient burst emitters awaiting cleanup
    this._whistled = false;        // 'whistle' fires once per shot at apex
    this._crumbledThisShot = false; // 'crumble' fires once per shot
    this._chargeFullPinged = false; // 'charge_full' fires once per charge
    // prefers-reduced-motion: skip flash + heavy bursts when it matches.
    this._reducedMotion = !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  create() {
    const data = this.payload;
    this.seed = data.seed;
    this.players = (data.players || []).map((p) => ({ ...p }));

    // Subtle in-game music bed (no-op if audio is locked/muted/unavailable).
    try { SFX.musicScene('game'); } catch (e) { /* ignore */ }

    // --- Rebuild terrain deterministically from the seed -------------------
    // generateTerrain + placePlayers reproduce the flattened pads exactly as on
    // the server; authoritative x/y/hp still come from the payload.
    this.heights = generateTerrain(this.seed);
    const positions = placePlayers(this.heights, this.players.length, this.seed);
    // Castles are built right after placePlayers (same order as server/local
    // driver) so block indices line up with result.castleHits[].blocks. The
    // sim sets each castle's id to the matching player id.
    const idPositions = positions.map((pos, i) => ({
      x: pos.x,
      y: pos.y,
      id: this.players[i] ? this.players[i].id : ('p' + i),
    }));
    this._rawCastles = buildCastles(this.heights, idPositions);
    if (Array.isArray(data.castles)) {
      this._rawCastles = data.castles.map((castle) => ({
        id: castle && castle.id,
        blocks: Array.isArray(castle && castle.blocks)
          ? castle.blocks.map((block) => ({ ...block }))
          : [],
      }));
    }
    if (Array.isArray(data.heights) && data.heights.length === WORLD_W) {
      this.heights = data.heights.slice();
    }

    // --- Background layers -------------------------------------------------
    this._paintSky();
    this._spawnClouds();
    this._paintMountains();

    // --- Terrain (redrawable) ---------------------------------------------
    this.terrainGfx = this.add.graphics();
    this.terrainGfx.setDepth(10);
    this._redrawTerrain();

    // --- Castles (drawn UNDER trebuchets/HP bars) -------------------------
    this._buildCastleState();

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
    // Hold-to-charge: SPACE down begins charging, SPACE up fires (7.3). The
    // keydown fires repeatedly while held (OS key-repeat) — _spaceLatched +
    // _charging guard against retrigger.
    this._onSpaceDown = () => this._beginCharge('key');
    this._onSpaceUp = () => this._releaseCharge('key');
    this.input.keyboard.on('keydown-SPACE', this._onSpaceDown, this);
    this.input.keyboard.on('keyup-SPACE', this._onSpaceUp, this);
    // Pointer-down on the FIRE button begins charging; pointer-up (anywhere)
    // releases. Pointer-down elsewhere is ignored for firing.
    this.input.on('pointerdown', this._onPointerDown, this);
    this.input.on('pointerup', this._onPointerUp, this);
    // If the pointer leaves the canvas while held, treat it as a release so the
    // shot still fires (and the bar never sticks).
    this.input.on('gameout', this._onPointerUp, this);

    // --- Net listeners (ALL removed in shutdown) ---------------------------
    // Seed hostId from the registry (set by main.js from the lobby that preceded
    // this start); keep listening for live host changes (e.g. host promotion).
    this._hostId = this.registry.get('hostId') || null;
    this._onShot = (m) => this._handleShot(m);
    this._onTurn = (m) => this._handleTurn(m);
    this._onLeft = (m) => this._handleLeft(m);
    this._onLobby = (m) => { if (m && m.hostId) this._hostId = m.hostId; };
    this._onControl = (m) => this._handleControl(m);
    net.on('shot', this._onShot);
    net.on('turn', this._onTurn);
    net.on('left', this._onLeft);
    net.on('lobby', this._onLobby);
    net.on('control', this._onControl);

    // Clean teardown on scene shutdown (rematch restart / leave).
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this._shutdown, this);

    this._refreshHud();
  }

  _shutdown() {
    net.off('shot', this._onShot);
    net.off('turn', this._onTurn);
    net.off('left', this._onLeft);
    net.off('lobby', this._onLobby);
    net.off('control', this._onControl);
    if (this.input && this.input.keyboard) {
      this.input.keyboard.off('keydown-SPACE', this._onSpaceDown, this);
      this.input.keyboard.off('keyup-SPACE', this._onSpaceUp, this);
    }
    if (this.input) {
      this.input.off('pointerdown', this._onPointerDown, this);
      this.input.off('pointerup', this._onPointerUp, this);
      this.input.off('gameout', this._onPointerUp, this);
    }
    // Detach any in-flight projectile ticker so it can't fire after teardown.
    if (this._projUpdate) {
      this.events.off('update', this._projUpdate);
      this._projUpdate = null;
    }
    // --- V3 §8.3 cleanup ---------------------------------------------------
    // Always stop the sustained charge tone, even if a charge (local OR remote)
    // was mid-flight when the scene tore down.
    this._stopChargeTone();
    // Clear the charge glow aura.
    this._clearChargeGlow();
    // Destroy the projectile trail + every transient burst emitter SYNCHRONOUSLY
    // (any deferred fade timers won't run once the scene is torn down).
    this._destroyFxEmitters();
    // Reusable white-flash overlay.
    if (this._flashRect) {
      this._flashRect.destroy();
      this._flashRect = null;
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
    g.fillCircle(WORLD_W * 0.5, WORLD_H * 0.42, 68);
    g.fillStyle(0xffe0a8, 0.22);
    g.fillCircle(WORLD_W * 0.5, WORLD_H * 0.42, 44);
  }

  _spawnClouds() {
    this._clouds = [];
    const rng = this._rng(this.seed ^ 0x51a4);
    for (let i = 0; i < 4; i++) {
      const c = this.add.image(rng() * WORLD_W, 28 + rng() * 120, 'cloud_' + (i % 3));
      c.setDepth(2);
      c.setAlpha(0.5);
      c._spd = 4 + rng() * 8;
      this._clouds.push(c);
    }
  }

  _paintMountains() {
    const g = this.add.graphics();
    g.setDepth(3);
    const rng = this._rng(this.seed ^ 0x9e37);
    // Two layered silhouettes, darker behind.
    this._mountainLayer(g, rng, 0x241a30, WORLD_H * 0.62, 52);
    this._mountainLayer(g, rng, 0x352440, WORLD_H * 0.70, 36);
  }

  _mountainLayer(g, rng, color, baseY, amp) {
    g.fillStyle(color, 1);
    g.beginPath();
    g.moveTo(0, WORLD_H);
    const step = 48;
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
      const top = Math.min(TERRAIN_FLOOR_Y, h[x] + 20);
      g.fillRect(x, top, 1, WORLD_H - top);
    }

    // 4px grass cap line (skip near-vertical crater walls so grass doesn't smear).
    for (let x = 0; x < WORLD_W; x++) {
      const y = h[x];
      const neighbor = h[Math.min(WORLD_W - 1, x + 1)];
      const steep = Math.abs(neighbor - y) > 12;
      g.fillStyle(steep ? GRASS_DARK : GRASS_COLOR, 1);
      g.fillRect(x, y, 1, 4);
      if (!steep) {
        g.fillStyle(GRASS_DARK, 1);
        g.fillRect(x, y + 4, 1, 2);
      }
    }
  }

  // -- castles (7.5) ------------------------------------------------------
  // Turn the raw deterministic castle list from buildCastles into renderable
  // state (one Graphics per owner, an `alive` flag per block) and draw them.
  _buildCastleState() {
    this._castles.clear();
    const list = this._rawCastles || [];
    for (let i = 0; i < list.length; i++) {
      const castle = list[i];
      if (!castle) continue;
      const blocks = Array.isArray(castle.blocks) ? castle.blocks : [];
      // Owner id: prefer the id the sim stamped on the castle; otherwise fall
      // back to the player at the same index (build order matches player order).
      let ownerId = castle.id;
      if (ownerId == null && this.players[i]) ownerId = this.players[i].id;
      if (ownerId == null) continue;
      const gfx = this.add.graphics();
      // Under trebuchets (depth 30) and HP bars, above terrain (depth 10).
      gfx.setDepth(20);
      const state = {
        id: ownerId,
        blocks,
        alive: blocks.map((block) => !block.destroyed),
        gfx,
      };
      this._castles.set(ownerId, state);
      this._redrawCastle(state);
    }
  }

  _redrawCastle(state) {
    const g = state.gfx;
    g.clear();
    const blocks = state.blocks;
    for (let i = 0; i < blocks.length; i++) {
      if (!state.alive[i]) continue;
      const b = blocks[i];
      const w = b.w || 1;
      const h = b.h || 1;
      // Per-block shade variation seeded by the block index so each wall has a
      // stable, slightly varied masonry look (2-3 gray shades).
      const shade = STONE_SHADES[this._stoneHash(i) % STONE_SHADES.length];
      g.fillStyle(shade, 1);
      g.fillRect(b.x, b.y, w, h);
      // For taller cells, a 1px mortar line at the bottom reads as stacked
      // stone. 1x1 cells (the common case) are left as a solid shade.
      if (h >= 3) {
        g.fillStyle(STONE_MORTAR, 0.6);
        g.fillRect(b.x, b.y + h - 1, w, 1);
      }
    }
  }

  // Tiny stable hash so a block's shade never changes between redraws.
  _stoneHash(i) {
    let v = (i * 2654435761) >>> 0;
    v ^= v >>> 13;
    return v >>> 0;
  }

  // Apply destroyed block indices from result.castleHits[].blocks (mirroring
  // authoritative state, like craters) and puff each removed cell.
  _applyCastleHit(ownerId, blockIndices) {
    const state = this._castles.get(ownerId);
    if (!state || !Array.isArray(blockIndices)) return;
    let destroyedAny = false;
    for (const idx of blockIndices) {
      if (idx == null || idx < 0 || idx >= state.alive.length) continue;
      if (!state.alive[idx]) continue;
      state.alive[idx] = false;
      destroyedAny = true;
      const b = state.blocks[idx];
      if (b) {
        const cx = b.x + (b.w || 1) / 2;
        const cy = b.y + (b.h || 1) / 2;
        this._debrisPuff(cx, cy);
        // Stony chunks flung with gravity/spin (skipped under reduced motion).
        this._spawnDebris(cx, cy);
      }
    }
    // Gravelly 'crumble' once per shot that breaks any masonry.
    if (destroyedAny && !this._crumbledThisShot) {
      this._crumbledThisShot = true;
      try { SFX.play('crumble'); } catch (e) { /* ignore */ }
    }
    this._redrawCastle(state);
  }

  // A tiny gray dust puff where a stone block was destroyed.
  _debrisPuff(x, y) {
    const g = this.add.graphics();
    g.setDepth(58);
    g.fillStyle(0xb0b0b8, 0.9);
    g.fillRect(-2, -2, 4, 4);
    g.fillStyle(0x86868f, 0.9);
    g.fillRect(0, 0, 2, 2);
    g.setPosition(x, y);
    this.tweens.add({
      targets: g,
      y: y - 8,
      alpha: 0,
      scaleX: 1.8,
      scaleY: 1.8,
      duration: 320,
      ease: 'Quad.easeOut',
      onComplete: () => g.destroy(),
    });
  }

  // -- trebuchets ---------------------------------------------------------
  // Rig geometry (see sprites.js TREB_FRAME/TREB_ARM):
  //   - The static frame is 26x26 in grid data but baked at 2x (52x52 px),
  //     origin bottom-center; the iron pivot pin sits at grid (col 17, row 10)
  //     => (+8, -32) from that origin in the 2x-baked pixels (RIGHT-facing).
  //   - The arm texture is baked with its pivot at the texture center, so it
  //     mounts with setOrigin(0.5,0.5) and rotates about `angle`.
  // Arm angles (degrees, RIGHT-facing; +angle = clockwise, screen-y down) are
  // UNCHANGED by the 2x scale (only pixel offsets/distances double):
  //   REST    168° — long sling end cocked low to the rear (sling tip ~ grid
  //                  row 13, matching the idle art's loaded sling), counterweight
  //                  raised up on the short end. Reads as the idle "primed" pose.
  //   RELEASE -70° — long sling end whipped high over the front, CW dropped to
  //                  the rear-bottom. A ~238° over-the-top throw arc.
  // Left-facing rigs mirror X (frame.flipX, arm.flipX) and negate the angle.
  static get TREB_PIVOT_DX() { return 8; }
  static get TREB_PIVOT_DY() { return -32; }
  static get TREB_ARM_REST() { return 168; }
  static get TREB_ARM_RELEASE() { return -70; }

  _addTrebuchet(p) {
    const c = p.colorIdx | 0;
    const faceLeft = p.x > WORLD_W / 2;

    // Prefer the rigged frame so the arm can physically rotate; fall back to the
    // single idle pose sprite if the rig bake is unavailable (defensive — a bake
    // failure must never break the game).
    const hasRig = this.textures.exists('treb_' + c + '_frame') &&
      this.textures.exists('treb_' + c + '_arm') &&
      this.textures.exists('treb_' + c + '_weight');

    const sprite = this.add.image(0, 0, hasRig ? ('treb_' + c + '_frame') : ('treb_' + c + '_idle'));
    sprite.setOrigin(0.5, 1); // bottom-center
    sprite.flipX = faceLeft;  // face map center
    sprite.setPosition(0, 0);

    const label = this.add.text(0, 0, (p.name || TEAM_NAMES[c] || 'P'), {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '12px',
      color: '#ffffff'
    });
    label.setOrigin(0.5, 1);
    label.setResolution(3);

    const hpBg = this.add.graphics();
    const hpFill = this.add.graphics();

    // Build the rig children (arm + counterweight) when textures exist. They are
    // added to the container BEFORE the HP bar/label so they draw behind those.
    let arm = null;
    let weight = null;
    const pivotDx = (faceLeft ? -1 : 1) * Game.TREB_PIVOT_DX;
    const pivotDy = Game.TREB_PIVOT_DY;
    const restAngle = (faceLeft ? -1 : 1) * Game.TREB_ARM_REST;
    if (hasRig) {
      arm = this.add.image(pivotDx, pivotDy, 'treb_' + c + '_arm');
      arm.setOrigin(0.5, 0.5);   // texture center == arm pivot
      arm.flipX = faceLeft;      // mirror the arm for left-facing rigs
      arm.setAngle(restAngle);   // cocked rest pose (matches idle)

      weight = this.add.image(0, 0, 'treb_' + c + '_weight');
      weight.setOrigin(0.5, 0.5);
      // Hang the counterweight off the arm's SHORT (counterweight) end; placed
      // by _layoutWeight from the current arm angle so it tracks the swing.
    }

    const children = [sprite];
    if (arm) children.push(arm);
    if (weight) children.push(weight);
    children.push(hpBg, hpFill, label);
    const container = this.add.container(p.x, p.y, children);

    const t = {
      container, sprite, label, hpBg, hpFill, p, colorIdx: c, dead: false,
      // Rig refs (null when falling back to the pose sprite).
      frame: hasRig ? sprite : null,
      arm, weight, hasRig, faceLeft,
      pivotDx, pivotDy, restAngle,
    };
    container.setDepth(30);
    this._trebs.set(p.id, t);
    if (t.arm) this._layoutWeight(t, t.arm.angle); // seat the CW at rest
    this._layoutTreb(t);
    this._drawHp(t);
    // Start payload carries full hp; guard anyway in case a rematch payload differs.
    if (p.hp <= 0) this._killTreb(t, false);
    return t;
  }

  // Seat the counterweight box at the SHORT (counterweight) end of the arm for a
  // given arm angle. The short end is ~5px from the pivot on the opposite side
  // of the long sling arm, so it sits along (angle + 180°). Called as the arm
  // tweens so the weight visibly rides the swing (down on release).
  _layoutWeight(t, armAngleDeg) {
    if (!t || !t.weight) return;
    const a = (armAngleDeg + 180) * Math.PI / 180; // counterweight side
    const stub = 12; // px from pivot to the counterweight box center (2x world)
    const wx = t.pivotDx + Math.cos(a) * stub;
    const wy = t.pivotDy + Math.sin(a) * stub;
    t.weight.setPosition(wx, wy);
  }

  _layoutTreb(t) {
    // Label + HP bar float above the trebuchet (sprite is 52 tall, origin bottom).
    // Default offsets place the label at container.y-64 and the HP bar at
    // container.y-56. On peak terrain the player sits near the top, which would
    // push these above the turn banner. Clamp so neither rises above world y=36.
    const cy = t.container.y;
    const MIN_WORLD_Y = 36;
    // Keep the same 8px gap between the HP bar and the label below it.
    let hpY = -56;
    let labelY = -64;
    // The topmost drawn pixel is the HP bar background (hpY - 1).
    if (cy + (hpY - 1) < MIN_WORLD_Y) {
      const shift = MIN_WORLD_Y - (cy + (hpY - 1));
      hpY += shift;
      labelY += shift;
    }
    t.label.setPosition(0, labelY);
    // HP bar geometry stored for redraw.
    t._hpW = 44;
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
    t.hpBg.fillRect(x - 2, y - 2, w + 4, 10);
    t.hpBg.fillStyle(0x2a2a2a, 1);
    t.hpBg.fillRect(x, y, w, 6);
    t.hpFill.clear();
    if (frac > 0) {
      t.hpFill.fillStyle(TEAM_COLORS[t.colorIdx] || 0xffffff, 1);
      t.hpFill.fillRect(x, y, Math.max(1, Math.round(w * frac)), 6);
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
        y: t.container.y + 12,
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
      this._smallPoof(t.container.x, t.container.y - 20);
    }
    t.container.destroy();
    this._trebs.delete(id);
  }

  // -- HUD ----------------------------------------------------------------
  _buildHud() {
    // Bumped one step for legibility at the internal 960x540 resolution (2x): the
    // "big" HUD text is now 20px and the "small" readouts 16px. Every HUD text
    // object also renders at 3x resolution (setResolution(3)) so the pixel font
    // stays crisp after the FIT upscale to the canvas.
    const fontBig = {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '20px',
      color: '#ffffff'
    };
    const fontSmall = {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '16px',
      color: '#ffffff'
    };

    // Wind arrow + text, centered top.
    this.windArrow = this.add.image(WORLD_W / 2, 24, 'wind_arrow');
    this.windArrow.setDepth(80);
    this.windText = this.add.text(WORLD_W / 2, 40, '', fontSmall);
    this.windText.setOrigin(0.5, 0);
    this.windText.setResolution(3);
    this.windText.setDepth(80);

    // Turn banner (top-left).
    this.turnBanner = this.add.text(8, 8, '', fontBig);
    this.turnBanner.setResolution(3);
    this.turnBanner.setDepth(80);

    // Countdown (top-right).
    this.countText = this.add.text(WORLD_W - 8, 8, '', fontBig);
    this.countText.setOrigin(1, 0);
    this.countText.setResolution(3);
    this.countText.setDepth(80);

    // Aim readout (bottom-left). Leaves room to the right for the charge meter.
    this.aimText = this.add.text(8, WORLD_H - 26, '', fontSmall);
    this.aimText.setResolution(3);
    this.aimText.setDepth(80);

    // Controls hint (bottom-left, above the readout) — in-canvas since ui.js
    // has no in-game hint string to edit. Nudged up 4px so the taller 16px
    // readout below it doesn't crowd the bottom edge.
    this.hintText = this.add.text(8, WORLD_H - 46, '◄► AIM   HOLD = POWER', {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '16px',
      color: '#9a9aa8'
    });
    this.hintText.setResolution(3);
    this.hintText.setDepth(80);

    // Thin vertical charge meter next to the readout (7.3). Drawn each frame
    // while charging; otherwise just shows an empty frame on your turn.
    this.chargeMeterX = 184;
    this.chargeMeterY = WORLD_H - 28;
    this.chargeMeterW = 12;
    this.chargeMeterH = 22;
    this.chargeMeter = this.add.graphics();
    this.chargeMeter.setDepth(80);

    // FIRE button (bottom-right) — chunky pixel box that doubles as a charge
    // bar (fills POWER_MIN..POWER_MAX while held).
    this.fireBtnRect = new Phaser.Geom.Rectangle(WORLD_W - 112, WORLD_H - 40, 104, 32);
    this.fireBtnBg = this.add.graphics();
    this.fireBtnBg.setDepth(80);
    this.fireBtnText = this.add.text(WORLD_W - 60, WORLD_H - 24, 'FIRE', {
      fontFamily: '"Press Start 2P", monospace',
      fontSize: '16px',
      color: '#1a0a0a'
    });
    this.fireBtnText.setOrigin(0.5, 0.5);
    this.fireBtnText.setResolution(3);
    this.fireBtnText.setDepth(81);
    this._drawFireBtn();
    this._drawChargeMeter();
  }

  _drawFireBtn() {
    const r = this.fireBtnRect;
    const enabled = this._myTurn && !this._animating && !this._gameOver;
    const g = this.fireBtnBg;
    g.clear();
    g.fillStyle(0x000000, 0.9);
    g.fillRect(r.x - 4, r.y - 4, r.width + 8, r.height + 8);
    // Base (un-charged) face. Dim when disabled.
    g.fillStyle(enabled ? 0x6b5a22 : 0x554a2a, 1);
    g.fillRect(r.x, r.y, r.width, r.height);
    // Charge fill (left -> right) doubles as a charge bar inside the button.
    if (this._charging) {
      const frac = this._chargeFrac();
      const fillW = Math.max(1, Math.round(r.width * frac));
      // Shift toward hot orange near full charge for feedback.
      const fillColor = frac >= 0.999 ? 0xffe26a : 0xe8c44d;
      g.fillStyle(fillColor, 1);
      g.fillRect(r.x, r.y, fillW, r.height);
    } else if (enabled) {
      // Bright, ready-to-charge fill.
      g.fillStyle(0xe8c44d, 1);
      g.fillRect(r.x, r.y, r.width, r.height);
    }
    g.lineStyle(4, enabled ? 0xfff0b0 : 0x332a18, 1);
    g.strokeRect(r.x, r.y, r.width, r.height);
    this.fireBtnText.setText(this._charging ? String(this._chargePower) : 'FIRE');
    this.fireBtnText.setColor(enabled ? '#1a0a0a' : '#7a6a40');
    this.fireBtnBg.setVisible(true);
    this.fireBtnText.setVisible(true);
  }

  // Thin vertical charge meter beside the aim readout. Fills bottom -> top.
  _drawChargeMeter() {
    const g = this.chargeMeter;
    g.clear();
    const show = this._myTurn && !this._animating && !this._gameOver;
    if (!show) {
      g.setVisible(false);
      return;
    }
    g.setVisible(true);
    const x = this.chargeMeterX;
    const y = this.chargeMeterY;
    const w = this.chargeMeterW;
    const h = this.chargeMeterH;
    // Frame + dark track.
    g.fillStyle(0x000000, 0.85);
    g.fillRect(x - 2, y - 2, w + 4, h + 4);
    g.fillStyle(0x2a2a2a, 1);
    g.fillRect(x, y, w, h);
    // Fill from the bottom up by the current charge fraction.
    const frac = this._charging ? this._chargeFrac() : 0;
    const fillH = Math.round(h * frac);
    if (fillH > 0) {
      g.fillStyle(frac >= 0.999 ? 0xffe26a : 0xe8c44d, 1);
      g.fillRect(x, y + (h - fillH), w, fillH);
    }
  }

  // 0..1 fraction of the charge window currently held.
  _chargeFrac() {
    return (this._chargePower - POWER_MIN) / Math.max(1, (POWER_MAX - POWER_MIN));
  }

  _refreshHud() {
    // Wind arrow: points in wind direction (wind > 0 blows right).
    const w = this.wind || 0;
    const mag = Math.abs(w);
    const roundedMag = Math.round(mag);
    // Base art points LEFT; flipX to point right when wind is positive.
    this.windArrow.flipX = w > 0;
    // mag/WIND_MAX is the wind-strength fraction; WIND_MAX is now 50 (2x world),
    // so divide by 50 to keep the arrow's stretch-with-strength behavior identical.
    const len = 1 + Math.min(1.6, mag / 50);
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
    } else if (this._myTurn && this._local) {
      // Local hotseat: everyone sees the same screen, so name the active
      // player ("<NAME>'S TURN") and tint it with their team color. It still
      // flashes (driven by _myTurn in update()) like YOUR TURN does.
      const name = (cur && (cur.p.name || TEAM_NAMES[cur.colorIdx])) || 'PLAYER';
      this.turnBanner.setText(name + "'S TURN");
      this.turnBanner.setColor(this._hexColor(cur ? cur.colorIdx : 0));
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

    // Aim readout — ARC + direction + elevation (7.1), e.g. 'ARC ► 62'.
    const showAim = this._myTurn && !this._gameOver;
    if (showAim) {
      this.aimText.setText(this._arcLabel());
      this.aimText.setVisible(true);
    } else {
      this.aimText.setVisible(false);
    }
    if (this.hintText) this.hintText.setVisible(showAim);

    this._drawFireBtn();
    this._drawChargeMeter();
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
    // While charging the line grows with power so the player sees how hard the
    // shot will be; otherwise it shows a fixed medium length (pure direction).
    const powerFrac = this._charging ? this._chargeFrac() : 0.45;
    const len = 28 + powerFrac * 52;
    const ex = baseX + Math.cos(rad) * len;
    const ey = baseY - Math.sin(rad) * len;
    // Dotted-ish aim line.
    this.aimGfx.lineStyle(2, 0xffffff, 0.85);
    this.aimGfx.beginPath();
    this.aimGfx.moveTo(baseX, baseY);
    this.aimGfx.lineTo(ex, ey);
    this.aimGfx.strokePath();
    // Arrow tip.
    this.aimGfx.fillStyle(0xffe066, 1);
    this.aimGfx.fillCircle(ex, ey, 3.2);
  }

  // -- turn / input -------------------------------------------------------
  _applyTurn(turnId, announce) {
    this.turn = turnId;
    const wasMine = this._myTurn;
    // Any in-flight charge belongs to the previous turn — drop it silently.
    this._cancelCharge();
    this._myTurn = (turnId === net.you);
    if (this._myTurn) {
      // Restore remembered aim if any.
      if (this._heldAngle != null) this._aimAngle = this._heldAngle;
      this._clampAim();
      if (announce && !wasMine) {
        try { SFX.play('yourturn'); } catch (e) { /* ignore */ }
      }
    }
    this._lastTickSecond = -1;
    this._refreshHud();
  }

  // Snap the aim angle into a valid launch band (7.1): right [50..85] or left
  // [95..130]. Values in the dead gap are pushed to the nearest valid bound;
  // anything else is clamped to the overall [50..130] sweep range.
  _clampAim() {
    let a = Math.round(this._aimAngle);
    if (!Number.isFinite(a)) a = RIGHT_LO; // NaN -> ELEV_MIN rightward
    if (a < RIGHT_LO) a = RIGHT_LO;
    else if (a > LEFT_HI) a = LEFT_HI;
    else if (a > RIGHT_HI && a < LEFT_LO) {
      // Inside the dead gap [86..94]: snap to whichever bound is nearer (ties
      // resolve to the right side, matching the 85<->95 boundary).
      a = (a - RIGHT_HI) <= (LEFT_LO - a) ? RIGHT_HI : LEFT_LO;
    }
    this._aimAngle = a;
  }

  // HUD label 'ARC ► 62' (right) / 'ARC ◄ 70' (left) — direction + elevation.
  _arcLabel() {
    const right = this._aimAngle <= RIGHT_HI;
    const elev = right ? this._aimAngle : (180 - this._aimAngle);
    return 'ARC ' + (right ? '►' : '◄') + ' ' + elev;
  }

  _onPointerDown(pointer) {
    if (!this._canCharge()) return;
    // Convert screen pointer to world coords (FIT scale handled by Phaser).
    const x = pointer.worldX;
    const y = pointer.worldY;
    if (Phaser.Geom.Rectangle.Contains(this.fireBtnRect, x, y)) {
      this._beginCharge('pointer');
    }
  }

  _onPointerUp() {
    this._releaseCharge('pointer');
  }

  // Whether starting a charge is currently allowed (your turn, idle, alive).
  _canCharge() {
    if (!this._myTurn || this._animating || this._gameOver) return false;
    const me = this._trebs.get(net.you);
    return !!(me && !me.dead);
  }

  // Begin (or ignore a duplicate begin of) a charge. `source` is 'key' or
  // 'pointer'; only the source that began it can release it.
  _beginCharge(source) {
    if (source === 'key') {
      // Guard against OS key-repeat retriggering after a release-fire: the
      // latch stays set until keyup clears it.
      if (this._spaceLatched) return;
      this._spaceLatched = true;
    }
    if (this._charging) return;
    if (!this._canCharge()) return;
    this._charging = true;
    this._chargeSource = source;
    this._chargeStart = this.time.now;
    this._chargePower = POWER_MIN;
    this._chargeFullPinged = false;
    // Sustained "winding up" whine + a starting charge glow on the trebuchet.
    // Hooked into the shared lifecycle so it fires for local charging; the
    // remote path mirrors this in _handleControl.
    this._startChargeTone();
    this._updateChargeGlow();
    this._refreshHud();
  }

  // Release the charge and fire with the charged power. Only the source that
  // started the charge releases it (a stray pointerup won't fire a key charge).
  _releaseCharge(source) {
    if (source === 'key') this._spaceLatched = false;
    if (!this._charging) return;
    if (this._chargeSource !== source) return;
    const power = this._chargePower;
    this._charging = false;
    this._chargeSource = null;
    // Stop the charge whine + clear the glow before the shot animates.
    this._stopChargeTone();
    this._clearChargeGlow();
    this._fire(power);
  }

  // Silently abort any in-flight charge (turn end / timeout). The Space latch
  // is left as-is: a still-held key must not start a brand new charge on the
  // next turn until it is physically released (keyup clears the latch).
  _cancelCharge() {
    // Always silence the charge tone + clear the glow on a cancel, even if the
    // _charging flag was already cleared (defensive: turn end mid-release).
    // This is the shared abort path for BOTH local and remote charges — turn
    // changes (_applyTurn) and shots (_handleShot) route through here.
    this._stopChargeTone();
    this._clearChargeGlow();
    if (!this._charging) return;
    this._charging = false;
    this._chargeSource = null;
    this._refreshHud();
  }

  // Commit the shot. Power is the charged value; angle is the current aim.
  _fire(power) {
    const me = this._trebs.get(net.you);
    if (!me || me.dead) { this._refreshHud(); return; }
    this._clampAim();
    this._heldAngle = this._aimAngle;
    const p = Math.max(POWER_MIN, Math.min(POWER_MAX, Math.round(power)));
    // Lock input until the shot resolves.
    this._animating = true;
    this._myTurn = false;
    this._refreshHud();
    net.send({ t: 'fire', angle: this._aimAngle, power: p });
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

    // Hold-to-charge progress (7.3). Power ramps POWER_MIN..POWER_MAX over
    // CHARGE_TIME_MS; reaching full charge auto-fires.
    if (this._charging) {
      if (this._chargeSource === 'remote') {
        // Remote charge: power is set directly by _handleControl (the React
        // controller drives the ramp). We still drive the SHARED audio/VFX off
        // the current charge fraction so the sustained tone pitch, the
        // charge_full ping and the glow behave identically to local charging.
        const frac = this._chargeFrac();
        try { SFX.setChargeLevel(frac); } catch (e) { /* ignore */ }
        this._updateChargeGlow();
        if (frac >= 1 && !this._chargeFullPinged) {
          this._chargeFullPinged = true;
          try { SFX.play('charge_full'); } catch (e) { /* ignore */ }
        }
        this._drawFireBtn();
        this._drawChargeMeter();
        this._drawAimLine();
      } else
      if (!this._canCharge()) {
        // Turn ended / shot started under us — abort silently.
        this._cancelCharge();
      } else {
        const frac = Math.min(1, (this.time.now - this._chargeStart) / CHARGE_TIME_MS);
        this._chargePower = Math.round(POWER_MIN + (POWER_MAX - POWER_MIN) * frac);
        // Nudge the sustained whine pitch + grow the trebuchet charge glow.
        try { SFX.setChargeLevel(frac); } catch (e) { /* ignore */ }
        this._updateChargeGlow();
        // One-shot ping the instant charge tops out.
        if (frac >= 1 && !this._chargeFullPinged) {
          this._chargeFullPinged = true;
          try { SFX.play('charge_full'); } catch (e) { /* ignore */ }
        }
        this._drawFireBtn();
        this._drawChargeMeter();
        this._drawAimLine();
        if (frac >= 1) {
          // Auto-fire at full charge. Keep the same source-release semantics so
          // the Space latch is cleared only on the real keyup.
          const power = POWER_MAX;
          this._charging = false;
          this._chargeSource = null;
          this._stopChargeTone();
          this._clearChargeGlow();
          this._fire(power);
        }
      }
    }

    // Keyboard aiming — LEFT/RIGHT sweep the arc (UP/DOWN are dead in V2).
    if (this._myTurn && !this._animating && !this._gameOver) {
      this._handleAimKeys(time);
    }

    // Keep the charge glow pulsing/growing while charging (both sources).
    if (this._charging) this._updateChargeGlow();
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

    // LEFT raises the angle toward 180 (aims more leftward); RIGHT lowers it
    // toward 0 (more rightward). Direction is tracked so the sweep jumps the
    // dead gap deterministically: 85 -> 95 going left, 95 -> 85 going right.
    let dir = 0;
    if (repeatOk(this.cursors.left)) { this._aimAngle += step; dir = +1; changed = true; }
    if (repeatOk(this.cursors.right)) { this._aimAngle -= step; dir = -1; changed = true; }

    if (changed) {
      this._snapAim(dir);
      this._heldAngle = this._aimAngle;
      this.aimText.setText(this._arcLabel());
      this._drawAimLine();
    }
  }

  // Sweep snap (7.1): keep the angle in a valid band, jumping the dead gap in
  // the direction of travel so the sweep crosses 85<->95 cleanly. `dir` is +1
  // for a leftward sweep (increasing angle) and -1 for rightward.
  _snapAim(dir) {
    let a = Math.round(this._aimAngle);
    if (a < RIGHT_LO) a = RIGHT_LO;
    else if (a > LEFT_HI) a = LEFT_HI;
    else if (a > RIGHT_HI && a < LEFT_LO) {
      // Landed in the gap: sweeping left jumps up to LEFT_LO, sweeping right
      // jumps down to RIGHT_HI. (dir 0 falls back to nearest bound.)
      if (dir > 0) a = LEFT_LO;
      else if (dir < 0) a = RIGHT_HI;
      else a = (a - RIGHT_HI) <= (LEFT_LO - a) ? RIGHT_HI : LEFT_LO;
    }
    this._aimAngle = a;
  }

  _handleControl(m) {
    if (!m || this._gameOver) return;
    const playerId = m.playerId || m.id;
    if (playerId && playerId !== net.you) return;
    const control = m.control;
    const value = m.value || {};

    if (control === 'aim' || control === 'trebuchet.aim') {
      if (!this._myTurn || this._animating) return;
      const nextAngle = Number(value.angle);
      const dir = Number(value.direction) || 0;
      if (Number.isFinite(nextAngle)) this._aimAngle = nextAngle;
      else if (dir !== 0) this._aimAngle += dir * (Number(value.step) || 1);
      this._snapAim(dir);
      this._heldAngle = this._aimAngle;
      if (this.aimText) this.aimText.setText(this._arcLabel());
      this._drawAimLine();
      this._refreshHud();
      return;
    }

    if (control === 'charge' || control === 'trebuchet.charge') {
      if (!this._myTurn || this._animating) return;
      const active = value.active !== false && value.charging !== false;
      if (!active) {
        this._charging = false;
        this._chargeSource = null;
        // Stop the sustained tone + clear the glow when the remote controller
        // releases (mirrors the local _releaseCharge cleanup).
        this._stopChargeTone();
        this._clearChargeGlow();
      } else {
        const nextPower = Number(value.power);
        const wasCharging = this._charging;
        this._charging = true;
        this._chargeSource = 'remote';
        this._chargePower = Math.max(POWER_MIN, Math.min(POWER_MAX, Number.isFinite(nextPower) ? Math.round(nextPower) : POWER_MIN));
        // On the leading edge of a remote charge, start the sustained whine +
        // glow (mirrors local _beginCharge). _startChargeTone is idempotent, so
        // subsequent power updates won't restack it; the level/glow then ramp
        // off the shared update() path.
        if (!wasCharging) this._chargeFullPinged = false;
        this._startChargeTone();
        this._updateChargeGlow();
      }
      this._drawFireBtn();
      this._drawChargeMeter();
      this._drawAimLine();
    }
  }

  // -- charge tone + glow (§8.3 VFX) --------------------------------------
  // Shared by BOTH the local (key/pointer) and remote ('trebuchet.charge')
  // charge lifecycles — the tone/glow are driven from _beginCharge/_handleControl
  // and the update() ramp, never from a specific input source.
  _startChargeTone() {
    if (this._chargeToneOn) return;
    this._chargeToneOn = true;
    try { SFX.startCharge(); } catch (e) { /* ignore */ }
  }

  _stopChargeTone() {
    // Idempotent + safe to call any time (stopCharge no-ops if not running).
    this._chargeToneOn = false;
    try { SFX.stopCharge(); } catch (e) { /* ignore */ }
  }

  // Pulsing heat aura on the active trebuchet that grows with charge fraction.
  _updateChargeGlow() {
    if (this._reducedMotion) return; // keep it calm under reduced motion
    const me = this._trebs.get(net.you);
    if (!me || me.dead) { this._clearChargeGlow(); return; }
    const frac = this._charging ? this._chargeFrac() : 0;
    if (!this._chargeGlow) {
      const g = this.add.image(me.container.x, me.container.y - 16, 'fx_ring');
      // Behind the trebuchet container (depth 30) so it haloes the machine
      // rather than covering it; additive so it reads as heat.
      g.setDepth(29);
      g.setBlendMode(Phaser.BlendModes.ADD);
      g.setTint(0xffcf6a);
      this._chargeGlow = g;
    }
    const g = this._chargeGlow;
    g.setPosition(me.container.x, me.container.y - 16);
    // Grow + brighten with charge; gentle pulse from the frame time.
    const pulse = 0.85 + 0.15 * Math.sin((this.time ? this.time.now : 0) / 90);
    const scale = (0.9 + frac * 1.6) * pulse;
    g.setScale(scale);
    g.setAlpha(0.25 + 0.5 * frac);
    g.setVisible(true);
  }

  _clearChargeGlow() {
    if (this._chargeGlow) {
      this._chargeGlow.destroy();
      this._chargeGlow = null;
    }
  }

  // -- projectile trail (§8.3 VFX) ----------------------------------------
  // A faint warm trail following the rock. Uses the modern Phaser 3.60+
  // particle API; feature-detected so a missing API never throws.
  _startProjectileTrail() {
    this._clearProjectileTrail();
    if (this._reducedMotion) return;
    if (typeof this.add.particles !== 'function') return;
    try {
      const em = this.add.particles(0, 0, 'fx_trail', {
        speed: { min: 4, max: 20 },
        scale: { start: 1, end: 0 },
        alpha: { start: 0.8, end: 0 },
        // Widened to match the slow-mo flight (Part A) so the arc reads as one
        // continuous streak at the slower playback speed instead of a dashed
        // line of short-lived puffs.
        lifespan: 620,
        frequency: 18,
        blendMode: 'ADD',
        follow: this.rock,
      });
      em.setDepth(39);
      this._trailEmitter = em;
    } catch (e) { /* ignore — trail is purely cosmetic */ }
  }

  _clearProjectileTrail() {
    if (this._trailEmitter) {
      try {
        // Stop emitting, let live particles fade, then destroy shortly after.
        this._trailEmitter.stop();
        const em = this._trailEmitter;
        // Let the now-longer-lived (lifespan 620) particles fade before destroy.
        this.time.delayedCall(680, () => { try { em.destroy(); } catch (e) {} });
      } catch (e) {
        try { this._trailEmitter.destroy(); } catch (e2) {}
      }
      this._trailEmitter = null;
    }
  }

  // -- enhanced impact VFX (§8.3) -----------------------------------------
  // Expanding shockwave ring + spark/ember burst + smoke puff. Heavy bursts are
  // skipped under reduced-motion (the ring is kept, it's cheap + informative).
  _impactVfx(x, y, big) {
    // Expanding shockwave ring (scale up + fade) — always shown (lightweight).
    const ring = this.add.image(x, y, 'fx_ring');
    ring.setDepth(59);
    ring.setBlendMode(Phaser.BlendModes.ADD);
    ring.setTint(big ? 0xffd0a0 : 0xffffff);
    ring.setScale(0.4);
    ring.setAlpha(0.9);
    this.tweens.add({
      targets: ring,
      scale: big ? 3.4 : 2.4,
      alpha: 0,
      duration: big ? 420 : 320,
      ease: 'Quad.easeOut',
      onComplete: () => ring.destroy(),
    });

    if (this._reducedMotion) return; // skip the heavy bursts
    if (typeof this.add.particles !== 'function') return;

    // Hot spark + ember burst. Particle speeds (px/s) and gravity (px/s^2) x2
    // for the 2x world; scale/alpha/lifespan/quantity are unchanged.
    this._burst('fx_spark', x, y, {
      speed: { min: 60, max: big ? 240 : 160 },
      scale: { start: 1, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan: { min: 200, max: 460 },
      quantity: big ? 16 : 9,
      blendMode: 'ADD',
      gravityY: 120,
    });
    this._burst('fx_ember', x, y, {
      speed: { min: 40, max: big ? 180 : 120 },
      scale: { start: 1, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan: { min: 260, max: 620 },
      quantity: big ? 12 : 7,
      blendMode: 'ADD',
      gravityY: 180,
    });
    // Soft smoke puff rising.
    this._burst('fx_smoke', x, y - 4, {
      speed: { min: 12, max: 52 },
      scale: { start: 0.6, end: 1.6 },
      alpha: { start: 0.55, end: 0 },
      lifespan: { min: 420, max: 820 },
      quantity: big ? 8 : 5,
      gravityY: -44,
    });
  }

  // Emit a one-shot particle burst from a transient emitter, tracked so it can
  // be torn down on shutdown and auto-destroyed once its particles die out.
  _burst(key, x, y, cfg) {
    if (typeof this.add.particles !== 'function') return;
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

  _destroyFxEmitters() {
    if (this._trailEmitter) {
      try { this._trailEmitter.destroy(); } catch (e) {}
      this._trailEmitter = null;
    }
    if (this._fxEmitters) {
      for (const em of this._fxEmitters) {
        try { em.destroy(); } catch (e) {}
      }
      this._fxEmitters = [];
    }
  }

  // Brief, subtle white screen flash for a big plunge. Skipped under reduced
  // motion. Reuses a single full-screen rectangle.
  _bigFlash() {
    if (this._reducedMotion) return;
    if (!this._flashRect) {
      this._flashRect = this.add.rectangle(
        WORLD_W / 2, WORLD_H / 2, WORLD_W, WORLD_H, 0xffffff
      );
      this._flashRect.setDepth(95);
      this._flashRect.setScrollFactor(0);
    }
    const r = this._flashRect;
    r.setAlpha(0.5);
    r.setVisible(true);
    this.tweens.add({
      targets: r,
      alpha: 0,
      duration: 180,
      ease: 'Quad.easeOut',
      onComplete: () => { if (r) r.setVisible(false); },
    });
  }

  // Stony debris chunks flung from a destroyed castle block — gravity + spin,
  // fading out. Skipped under reduced motion (the existing dust puff remains).
  _spawnDebris(x, y) {
    if (this._reducedMotion) return;
    const n = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const chunk = this.add.image(x, y, 'fx_debris');
      chunk.setDepth(59);
      // Velocities (px/s) and gravity (px/s^2) x2 for the 2x world; spin
      // (angular, rad/s) is unchanged.
      const vx = (Math.random() * 2 - 1) * 44;
      const vy = -(28 + Math.random() * 52);
      const spin = (Math.random() * 2 - 1) * 6;
      // Simple ballistic toss via a value tween driving x/y/rotation.
      const startX = x;
      const startY = y;
      const dur = 520 + Math.random() * 200;
      const g = 280; // px/s^2-ish (scaled to the tween's 0..1 progress)
      const obj = { t: 0 };
      this.tweens.add({
        targets: obj,
        t: 1,
        duration: dur,
        ease: 'Linear',
        onUpdate: () => {
          const ts = (obj.t * dur) / 1000;
          chunk.x = startX + vx * ts;
          chunk.y = startY + vy * ts + 0.5 * g * ts * ts;
          chunk.rotation += spin * 0.016;
          chunk.alpha = 1 - obj.t;
        },
        onComplete: () => chunk.destroy(),
      });
    }
  }

  // -- shot animation -----------------------------------------------------
  _handleShot(m) {
    if (!m) return;
    this._animating = true;
    this._myTurn = false;
    this._refreshHud();

    // A charge that was somehow still live (shouldn't happen — firing locks
    // input) must not survive into the animation.
    this._cancelCharge();

    // Capture the current turn epoch. If a later turn/left message advances it
    // while this shot is animating, _afterShot must NOT re-apply this shot's
    // (now stale) m.next.
    const shotEpoch = this._turnEpoch;

    const traj = m.trajectory || [];

    // Reset per-shot one-shot cue guards (whistle at apex / crumble on masonry).
    this._whistled = false;
    this._crumbledThisShot = false;

    // Fire sequence: a SLOW, weighty wind-up (SWING_MS) ending in the release,
    // then a long held/settle (RELEASE_HOLD_MS). The projectile + 'fire' SFX
    // launch AT the release moment so the rock leaves the sling exactly as the
    // arm whips over, never before. These were 90/360; raised so the throw reads.
    const shooter = this._trebs.get(m.shooterId);
    const SWING_MS = 260;
    const RELEASE_HOLD_MS = 600;

    // Shared "the arm just released the stone" handler — runs once, at the
    // release instant, for BOTH the rigged tween path and the texture fallback.
    let launched = false;
    const launch = () => {
      if (launched) return;
      launched = true;
      try { SFX.play('fire'); } catch (e) { /* ignore */ }
      // Machine kick: a small camera shake on release (skipped under reduced
      // motion). Light enough not to fight the heavier impact shake later.
      if (!this._reducedMotion) {
        try { this.cameras.main.shake(120, 0.004); } catch (e) { /* ignore */ }
      }
      // Optional dust puff at the trebuchet on release.
      if (shooter && !shooter.dead) {
        this._debrisPuff(shooter.container.x, shooter.container.y - 4);
      }
      this._animateProjectile(traj, () => this._resolveImpact(m, shotEpoch));
    };

    const canRig = shooter && !shooter.dead && shooter.hasRig &&
      shooter.arm && shooter.weight;

    if (canRig) {
      this._animateThrowRig(shooter, SWING_MS, RELEASE_HOLD_MS, launch);
    } else if (shooter && !shooter.dead) {
      // Fallback: the original idle -> swing -> release -> idle pose swaps,
      // re-timed to the new (slower) SWING_MS / RELEASE_HOLD_MS so a bake
      // failure still gives a slowed, readable shot.
      const c = shooter.colorIdx;
      shooter.sprite.setTexture('treb_' + c + '_swing');
      this.time.delayedCall(SWING_MS, () => {
        if (shooter.sprite && !shooter.dead) {
          shooter.sprite.setTexture('treb_' + c + '_release');
        }
        launch();
      });
      this.time.delayedCall(SWING_MS + RELEASE_HOLD_MS, () => {
        if (shooter.sprite && !shooter.dead) {
          shooter.sprite.setTexture('treb_' + c + '_idle');
        }
      });
    } else {
      // Shooter gone/dead — still launch the rock on the same schedule so the
      // shot resolves normally.
      this.time.delayedCall(SWING_MS, launch);
    }
  }

  // Physically swing the rigged arm: a weighty wind-up (counterweight drops and
  // accelerates the arm, whip at the end), the release at the wind-up's end
  // (fires `onRelease`), then an overshoot + settle back to rest plus a small
  // machine recoil. Purely cosmetic — it never gates the sim, only when the rock
  // visually leaves the sling.
  _animateThrowRig(t, swingMs, holdMs, onRelease) {
    const arm = t.arm;
    const rest = t.restAngle;
    const release = (t.faceLeft ? -1 : 1) * Game.TREB_ARM_RELEASE;
    const homeX = t.container.x;

    // Keep the counterweight glued to the arm's short end every frame.
    const trackWeight = () => this._layoutWeight(t, arm.angle);

    // Counterweight leads the arm slightly (mass first): a tiny early drop on the
    // weight's own offset before the arm tween, giving the swing a "the weight
    // yanks the arm" read. ~50ms head start.
    if (!this._reducedMotion) {
      this.tweens.add({
        targets: arm,
        // overshoot a hair past rest (cock back) before the throw — Back.easeIn
        // gives that anticipatory dip, then the whip.
        angle: release,
        duration: swingMs,
        delay: 50,
        ease: 'Cubic.easeIn',
        onUpdate: trackWeight,
        onComplete: () => {
          trackWeight();
          onRelease();
          this._settleThrowRig(t, rest, holdMs, homeX);
        },
      });
      // Machine recoil: nudge the whole rig back (away from the shot) a hair as
      // the counterweight slams down, then ease home during the settle.
      const recoilDir = t.faceLeft ? 1 : -1; // shove opposite the throw
      this.tweens.add({
        targets: t.container,
        x: homeX + recoilDir * 4,
        duration: swingMs,
        delay: 50,
        ease: 'Cubic.easeIn',
      });
    } else {
      // Reduced motion: snap arm to release, fire, snap back — no tween motion.
      arm.setAngle(release);
      trackWeight();
      onRelease();
      this.time.delayedCall(holdMs, () => {
        if (arm && !t.dead) { arm.setAngle(rest); trackWeight(); }
        t.container.x = homeX;
      });
    }
  }

  // Overshoot + settle the arm back toward its cocked rest pose, and ease the
  // recoiled rig back home. Bounce/Back gives a satisfying mechanical rebound.
  _settleThrowRig(t, rest, holdMs, homeX) {
    const arm = t.arm;
    if (!arm || t.dead) return;
    const trackWeight = () => this._layoutWeight(t, arm.angle);
    // Let the released pose linger, then swing back with a small overshoot.
    this.tweens.add({
      targets: arm,
      angle: rest,
      duration: Math.max(120, holdMs),
      ease: 'Back.easeOut',
      onUpdate: trackWeight,
      onComplete: trackWeight,
    });
    this.tweens.add({
      targets: t.container,
      x: homeX,
      duration: Math.max(120, holdMs),
      ease: 'Back.easeOut',
    });
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

    // Faint warm particle trail follows the rock (cleared on impact).
    this._startProjectileTrail();

    // Cosmetic slow-motion: stretch the visual flight so the arc reads as a
    // weighty trebuchet lob WITHOUT touching the sim. Each trajectory sample is
    // 1/60 s of *simulated* flight; multiplying by SLOMO makes one sample take
    // longer to play back, so the rock still passes through EXACTLY the same
    // sampled points (same landing spot) — only slower. Everything below derives
    // from sampleDt, so the whole flight scales uniformly.
    const SLOMO = 2.2;
    let elapsed = 0;
    const sampleDt = (1 / 60) * SLOMO; // seconds of real time per sample
    const totalT = (traj.length - 1) * sampleDt;
    const startTime = this.time.now;
    let prevY = traj[0][1]; // track y to detect the apex (start of the fall)

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
      // Descending whistle once, when the rock passes its apex (y starts
      // increasing — screen y grows downward). Guarded so it plays only once.
      if (!this._whistled && y > prevY + 0.01 && f > 0.05) {
        this._whistled = true;
        try { SFX.play('whistle'); } catch (e) { /* ignore */ }
      }
      prevY = y;
      this.rock.setPosition(x, y);
      // Spin scaled down by SLOMO so the rock's tumble rate matches the slowed
      // flight (≈0.16 rad/frame at SLOMO 2.2) rather than spinning frantically.
      this.rock.rotation += 0.35 / SLOMO;
    };
    this._projUpdate = tick;
    this.events.on('update', tick);
  }

  _resolveImpact(m, shotEpoch) {
    this.rock.setVisible(false);
    // Stop + tidy the projectile trail now that the rock has landed.
    this._clearProjectileTrail();
    const res = m.result || {};

    // Big-hit emphasis (7.2): plunge >= 1.25 renders popups 1px larger + flash.
    const plunge = typeof res.plunge === 'number' ? res.plunge : 1;
    const bigHit = plunge >= 1.25;

    // Did this shot hit a player directly (any blast/castle damage)?
    const playerHit = ((res.hits || []).some((h) => h && h.dmg > 0)) ||
      ((res.castleHits || []).some((ch) => ch && ch.dmg > 0));

    // Explosion at impact (if any).
    const impact = res.impact;
    const hasDeaths = (res.deaths || []).length > 0;
    if (impact) {
      this._explode(impact.x, impact.y, hasDeaths);
      try { SFX.play(hasDeaths ? 'death' : 'explode'); } catch (e) { /* ignore */ }
      // Layered impact accents on top of the boom:
      //   - direct player hit  -> 'hit'
      //   - terrain-only (no damage) -> 'thud'
      //   - big plunge -> 'bighit'
      if (playerHit) { try { SFX.play('hit'); } catch (e) { /* ignore */ } }
      else { try { SFX.play('thud'); } catch (e) { /* ignore */ } }
      if (bigHit) { try { SFX.play('bighit'); } catch (e) { /* ignore */ } }

      // Enhanced impact VFX (ring shockwave + spark/ember/smoke bursts).
      this._impactVfx(impact.x, impact.y, bigHit || hasDeaths);

      // Camera shake — bigger for a deep plunge / a kill.
      const strongShake = bigHit || hasDeaths;
      this.cameras.main.shake(
        strongShake ? 360 : 180,
        bigHit ? 0.018 : (hasDeaths ? 0.012 : 0.006)
      );
      // Big-plunge white screen flash (skipped under reduced motion).
      if (bigHit) this._bigFlash();

      // Carve terrain.
      if (res.crater) {
        applyCrater(this.heights, res.crater);
        this._redrawTerrain();
      }
    }

    // Castle destruction (7.5): mirror destroyed block indices and puff them.
    for (const ch of (res.castleHits || [])) {
      if (ch && ch.id != null) this._applyCastleHit(ch.id, ch.blocks);
    }

    // Per-position popup stagger: if two numbers land on the same victim, the
    // second rises 120 ms later so they don't overlap.
    const popupStagger = new Map(); // id -> count

    // Apply blast hits (hp authoritative). hp may be superseded below by a
    // matching castleHits entry (both carry the same final hp).
    for (const h of (res.hits || [])) {
      const t = this._trebs.get(h.id);
      if (!t) continue;
      t.p.hp = h.hp;
      this._drawHp(t);
      if (!t.dead) this._flashHit(t);
      const idx = popupStagger.get(h.id) || 0;
      popupStagger.set(h.id, idx + 1);
      this._damagePopup(h.id, h.dmg, false, bigHit, idx * 120);
    }

    // Apply castle-damage hp + popups (stone-white). hp here is the owner's
    // final hp after all of this shot's damage (same value as any hits[].hp).
    for (const ch of (res.castleHits || [])) {
      if (!ch || ch.id == null) continue;
      const t = this._trebs.get(ch.id);
      if (t) {
        t.p.hp = ch.hp;
        this._drawHp(t);
      }
      if (ch.dmg > 0) {
        const idx = popupStagger.get(ch.id) || 0;
        popupStagger.set(ch.id, idx + 1);
        this._damagePopup(ch.id, ch.dmg, true, bigHit, idx * 120);
      }
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
        this._explode(t.container.x, t.container.y - 16, true);
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

  // Floating damage popup (7.2). `victimId` locates the position; `stone` =
  // pale stone-white (castle damage) vs red (blast); `big` adds 1px + flash
  // for plunge >= 1.25; `delayMs` staggers same-position numbers.
  _damagePopup(victimId, dmg, stone, big, delayMs) {
    const pos = this._victimPos(victimId);
    if (!pos) return;
    const start = () => {
      if (!this.scene || !this.add) return;
      const baseSize = big ? 18 : 16;
      const color = stone ? '#e6e6ee' : '#ff5a4a';
      const txt = this.add.text(pos.x, pos.y, '-' + Math.max(0, Math.round(dmg)), {
        fontFamily: '"Press Start 2P", monospace',
        fontSize: baseSize + 'px',
        color,
        stroke: '#000000',
        strokeThickness: 6,
      });
      txt.setOrigin(0.5, 1);
      txt.setDepth(92);
      txt.setResolution(3);
      if (big) {
        // Brief white flash on a big hit.
        txt.setTintFill(0xffffff);
        this.time.delayedCall(110, () => { if (txt && txt.active) txt.clearTint(); });
      }
      this.tweens.add({
        targets: txt,
        y: pos.y - 28,
        alpha: 0,
        duration: 900,
        ease: 'Quad.easeOut',
        onComplete: () => txt.destroy(),
      });
    };
    if (delayMs > 0) this.time.delayedCall(delayMs, start);
    else start();
  }

  // Where to float a popup for a given player id — above their trebuchet, or
  // the authoritative player record if the treb was already removed.
  _victimPos(id) {
    const t = this._trebs.get(id);
    if (t && t.container) {
      return { x: t.container.x, y: t.container.y - 32 };
    }
    const p = (this.players || []).find((q) => q.id === id);
    if (p) return { x: p.x, y: p.y - 32 };
    return null;
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
    // Long notes (e.g. '<LONGNAME> WINS!') shrink to 16px so they don't crowd
    // the 960px stage.
    const fontSize = (text && text.length > 16) ? '16px' : '20px';
    const t = this.add.text(WORLD_W / 2, WORLD_H * 0.34, text, {
      fontFamily: '"Press Start 2P", monospace',
      fontSize,
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 6
    });
    t.setOrigin(0.5, 0.5);
    t.setResolution(3);
    t.setDepth(90);
    this.tweens.add({
      targets: t,
      y: t.y - 28,
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
      // Local hotseat: there's no single "you", so always show the named
      // winner ("<NAME> WINS!") rather than "YOU WIN!".
      youWin = !this._local && (winnerId === net.you);
    }

    try { SFX.play(youWin ? 'win' : 'lose'); } catch (e) { /* ignore */ }

    // Local hotseat: REMATCH is always offered (no host concept).
    const isHost = this._local ? true : (this._hostId === net.you);

    // Brief in-canvas banner, then hand off to the HTML game-over panel.
    this._note(draw ? 'DRAW!' : (youWin ? 'YOU WIN!' : winnerName + ' WINS!'));
    this.time.delayedCall(900, () => {
      document.dispatchEvent(new CustomEvent('ui:gameover', {
        detail: { winnerName, youWin, draw, isHost }
      }));
    });
  }

  // -- util ---------------------------------------------------------------
  // Convert a team colorIdx to a '#rrggbb' CSS string for Phaser text color.
  _hexColor(colorIdx) {
    const c = TEAM_COLORS[colorIdx] != null ? TEAM_COLORS[colorIdx] : 0xffffff;
    return '#' + (c & 0xffffff).toString(16).padStart(6, '0');
  }

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
