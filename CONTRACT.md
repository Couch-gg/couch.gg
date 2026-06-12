# TREBUCHET — Module Contract

Multiplayer retro artillery game (MS-DOS "Artillery" / Scorched Earth style) with trebuchets.
Browser client (Phaser 3, pixel art, 480×270 internal resolution) + Node.js server (Express + ws).
Turn-based. Server-authoritative: server simulates every shot with the shared deterministic sim
and broadcasts the full result; clients only animate and mirror state.

This document is the binding interface spec. Every module MUST follow it exactly.
All numeric tuning lives in `shared/constants.js` — import it, never hardcode duplicates.

## Conventions

- Plain JavaScript ES modules everywhere (package.json has `"type": "module"`). NO TypeScript,
  NO build step, NO bundler. Must work in current Chrome AND Safari (no Chrome-only APIs;
  use `navigator.clipboard` with a `document.execCommand('copy')` fallback; WebAudio via
  `window.AudioContext || window.webkitAudioContext`).
- Coordinates: origin top-left, x right, y down. Angle in degrees: 0 = right, 90 = straight up,
  180 = left. Velocity from angle: `vx = cos(rad)*speed`, `vy = -sin(rad)*speed`.
- Phaser is loaded as a global script (`window.Phaser`) from `/vendor/phaser.min.js`.
  Client game files must NOT `import` phaser — use the global.
- The browser can import shared modules: `/shared/constants.js`, `/shared/sim.js`
  (server serves the `shared/` dir at URL path `/shared`).
- IDs: player id is a short random string the server assigns (e.g. 8 hex chars). Room code is
  `ROOM_CODE_LEN` chars from `ROOM_CODE_ALPHABET`.

## File layout & ownership

```
package.json                 [scaffold — done]
shared/constants.js          [scaffold — done]
shared/sim.js                [Agent SIM]
shared/sim.test.js           [Agent SIM]
server/index.js              [Agent SERVER]
server/rooms.js              [Agent SERVER]
server/game.js               [Agent SERVER]
public/index.html            [Agent SHELL]
public/css/style.css         [Agent SHELL]
public/js/net.js             [Agent SHELL]
public/js/ui.js              [Agent SHELL]
public/js/main.js            [Agent GAME]
public/js/scenes/boot.js     [Agent GAME]
public/js/scenes/game.js     [Agent GAME]
public/js/sprites.js         [Agent ART]
public/js/sfx.js             [Agent ART]
```

Each agent writes ONLY its own files.

---

## 1. shared/sim.js — deterministic simulation (pure, no DOM, no Phaser, no Node APIs)

All functions pure/deterministic (PRNG only via `mulberry32` from constants). Exports:

```js
generateTerrain(seed) -> Float64Array(WORLD_W)
```
Heightmap: `heights[x]` = y of terrain surface at column x (terrain is solid from heights[x]
down to WORLD_H). Values clamped to [TERRAIN_MIN_Y, TERRAIN_MAX_Y]. Generate rolling hills with
character (midpoint displacement or layered value noise), smoothed — classic artillery profile.
Same seed ⇒ identical array.

```js
placePlayers(heights, n, seed) -> [{ x, y }]   // n positions, left to right
```
Evenly spaced across the map with small seeded jitter, margin ≥ 40 px from edges. Flatten a
13 px wide pad in `heights` around each x (mutates heights — clients and server both call this
after generateTerrain, same order, so state stays identical). `y = heights[x]` after flattening.

```js
simulateShot({ shooterId, x, y, angle, power, wind, heights, players }) -> result
```
- Spawn projectile at `(x, y - MUZZLE_DY)`; speed = `power/100 * SPEED_MAX`.
- Integrate with fixed `DT`: `vx += wind*DT; vy += GRAVITY*DT; x += vx*DT; y += vy*DT`.
- Record a trajectory sample every `TRAJ_SAMPLE_EVERY` steps (and the final point).
- Terminate on: terrain hit (`y >= heights[round(x)]` while x in [0, WORLD_W)), player hit
  (distance to any ALIVE player's circle center `(p.x, p.y + PLAYER_HIT_DY)` ≤
  `PLAYER_HIT_R + PROJ_RADIUS` — including the shooter, self-hits allowed; ignore hits during
  the first 0.15 s of flight so the projectile can leave the shooter's own circle), leaving
  the map sideways (x < -60 or x > WORLD_W + 60), falling below bottom (y > WORLD_H + 20), or
  exceeding MAX_FLIGHT_T. Arcing above the top (y < 0) is allowed and common.
- `players`: array `{ id, x, y, hp, alive }`. Only alive players collide/take damage.
- Returns:
```js
{
  trajectory: [[x, y], ...],          // rounded to 2 decimals is fine
  impact: { x, y } | null,            // null if flew off the map / timed out
  crater: { x, y, r: CRATER_R } | null, // null iff impact is null
  hits: [{ id, dmg }],                // all alive players within DMG_RADIUS of impact;
                                      // dmg = round(DMG_MAX * (1 - dist/DMG_RADIUS)), min 1 if hit
}
```
`simulateShot` does NOT mutate heights or players.

```js
applyCrater(heights, crater) -> void  // mutates heights
```
Circular bite: for each column within `crater.r` of `crater.x`, the crater removes terrain
down to `crater.y + sqrt(r² - dx²)` (i.e. new height = max(current, that value)), clamped to
TERRAIN_FLOOR_Y. Columns outside [0, WORLD_W) ignored.

```js
settlePlayers(heights, players) -> [{ id, y }]
```
For each alive player whose `y < heights[round(x)]`, drop them to `y = heights[round(x)]`.
Returns ONLY the players that moved (their new y). Mutates the player objects' y.

### shared/sim.test.js
Node script (`npm test`) with plain asserts: determinism (same seed twice ⇒ identical terrain),
different seeds differ, bounds respected, 45°/power-100 shot with no wind travels > 300 px
horizontally from a flat-terrain launch, wind shifts impact in wind direction, crater lowers
terrain, damage decreases with distance, settlePlayers drops a floating player. Exit code 0 on
success, non-zero with a clear message on failure.

---

## 2. Server — `server/index.js`, `server/rooms.js`, `server/game.js`

### index.js
- Express app + `http.createServer` + `ws.WebSocketServer` on path `/ws` (same port).
- Static: `public/` at `/`, `shared/` at `/shared`,
  `node_modules/phaser/dist/phaser.min.js` at `/vendor/phaser.min.js`.
- `PORT` env var, default 3000. On listen, print local URL and LAN URLs (scan
  `os.networkInterfaces()` for IPv4 non-internal) so the user can invite players on the LAN:
  `http://<ip>:<port>`.
- JSON messages both directions: `ws.send(JSON.stringify(msg))`; parse with try/catch, ignore
  malformed. Heartbeat: ping/pong every 30 s, terminate dead sockets.

### rooms.js — lobby management
- `createRoom(hostSocket, name)` / `joinRoom(code, socket, name)` / leave handling.
- Room: `{ code, hostId, players: Map<id, player>, state: 'lobby'|'playing'|'over', game }`.
  Player: `{ id, name, colorIdx, socket }`. colorIdx = lowest free index 0–3.
- Names: trim, strip control chars, cap at NAME_MAX_LEN, default `PLAYER`. Uppercase them.
- Codes: random from ROOM_CODE_ALPHABET, unique among active rooms. Case-insensitive on join.
- Reject join: unknown code, room full (MAX_PLAYERS), game already 'playing' ⇒ `error` msg.
- Empty room ⇒ delete. Host leaves ⇒ promote oldest remaining player to host.

### game.js — turn engine (one instance per room)
- `start`: `seed = (Math.random()*2**31)|0`, `generateTerrain`, `placePlayers` (join order),
  players get PLAYER_HP, alive=true. Random first turn among players, wind =
  uniform in [-WIND_MAX, WIND_MAX] rounded to 1 decimal. Turn timer TURN_MS.
- `fire` (only from the player whose turn it is, only while 'playing'): clamp angle to
  [ANGLE_MIN, ANGLE_MAX], power to [POWER_MIN, POWER_MAX]. Run `simulateShot` with the room's
  authoritative heights/players and current wind. Apply: `applyCrater`, subtract `dmg` (clamp
  hp ≥ 0, `alive = hp > 0`), `settlePlayers`. Compute deaths this shot, winner (last alive) or
  draw (all dead). Advance turn to next alive player (skip dead), new wind, reset timer.
  Broadcast ONE `shot` message (schema below) to the whole room. If game over: state='over',
  stop timer.
- Turn timeout: skip to next alive player, broadcast `turn` with `skipped`.
- Player disconnect while playing: mark dead, remove from room, broadcast `left`; if it was
  their turn advance turn; if only one alive remains ⇒ game over (winner field on `left`).
- `rematch` (host only, state 'over'): fresh seed/terrain/positions/hp, same players,
  broadcast a new `start`.
- Client animation pacing: server should not start the turn timer countdown unfairly —
  acceptable simplification: timer starts immediately; TURN_MS is generous.

### WebSocket protocol

Client → Server:
```js
{ t: 'create', name }
{ t: 'join', code, name }
{ t: 'start' }                  // host, lobby, ≥ MIN_PLAYERS
{ t: 'fire', angle, power }     // numbers
{ t: 'rematch' }                // host, state 'over'
```

Server → Client:
```js
{ t: 'joined', code, you }                    // once, on successful create/join; you = your id
{ t: 'lobby', code, hostId, players: [{ id, name, colorIdx }] }   // on every lobby change
{ t: 'start', seed, players: [{ id, name, colorIdx, x, y, hp }],  // game begins (also rematch)
  turn, wind, turnEndsAt }                    // turnEndsAt = epoch ms
{ t: 'shot', shooterId, angle, power, wind,
  trajectory: [[x,y],...],
  result: { impact, crater, hits: [{ id, dmg, hp }], deaths: [id], settled: [{ id, y }] },
  next: { turn, wind, turnEndsAt } | null,    // null when game over
  winner: id | null, draw: boolean }
{ t: 'turn', turn, wind, turnEndsAt, skipped: id | null }   // timeout skip
{ t: 'left', id, name, next: { turn, wind, turnEndsAt } | null, winner: id | null }
{ t: 'error', msg }                           // human-readable, shown as toast
```
`hits[].hp` is the player's hp AFTER damage. The server is the only authority on hp/turns.

---

## 3. Frontend shell — `public/index.html`, `public/css/style.css`, `public/js/net.js`, `public/js/ui.js`

### index.html
- `<canvas>`-hosting `<div id="game">` plus an HTML overlay `<div id="ui">` for menu/lobby/
  game-over panels (HTML gives crisp retro text + real inputs).
- Loads: Google font `Press Start 2P` (with `monospace` fallback), `/vendor/phaser.min.js`
  (plain script tag), then `<script type="module" src="/js/main.js">`.
- Title "TREBUCHET". Dark page.

### style.css — retro CRT look
- Black/very dark background; centered 16:9 stage; `image-rendering: pixelated` on canvas.
- All UI text `'Press Start 2P', monospace`, uppercase, chunky borders (no rounded corners),
  high-contrast retro palette matching TEAM_COLORS vibe. Subtle CRT scanline overlay
  (repeating-linear-gradient, ~0.08 opacity, pointer-events none) over the stage.
- Buttons: pixel-style (solid bg, 2-3px borders, hover invert). Inputs: dark bg, light text.

### net.js
```js
export const net = new Net();   // singleton
net.connect();                  // ws(s)://location.host/ws — wss when https
net.send(obj);                  // JSON-encodes; queues until open
net.on(type, fn); net.off(type, fn);   // type = message .t, plus 'open' and 'close'
net.you;                        // your player id (set automatically from 'joined')
net.code;                       // current room code (from 'joined')
```
Simple event-emitter; multiple listeners per type. On 'close', emit so UI can show a banner.
No auto-reconnect needed (v1: refresh to rejoin).

### ui.js
```js
export function initUI(net)
```
Owns the `#ui` overlay. Screens:
- **MENU**: big title, name input (persist last name in localStorage), CREATE GAME button,
  room-code input + JOIN button. If URL has `?room=CODE`, prefill code and highlight join.
  On create/join click: `net.send({t:'create'|'join', ...})`.
- **LOBBY** (shown on `lobby` msg while not in game): room code huge, invite link
  `location.origin + '/?room=' + code` with COPY button (clipboard + fallback), player list
  with team color swatches and (HOST) tag, host sees START GAME (disabled until ≥ MIN_PLAYERS:
  show "NEED 2+ PLAYERS"), others see "WAITING FOR HOST…".
- On `start` msg: hide the overlay entirely (game scene takes over).
- **GAME OVER panel**: shown when it receives DOM event `ui:gameover` on `document`
  (CustomEvent, `detail: { winnerName, youWin, draw, isHost }` — dispatched by the game
  scene). Shows WINNER banner ("<NAME> WINS!" / "DRAW!" / "YOU WIN!"), host gets REMATCH
  button (`net.send({t:'rematch'})`), everyone gets LEAVE (reload page). Panel hides on next
  `start`.
- `error` msg ⇒ toast (auto-hide ~4 s). `close` event ⇒ persistent "CONNECTION LOST — RELOAD"
  banner.
- Import and call `SFX.play('click')` from `/js/sfx.js` on button clicks (wrapped in
  try/catch so missing audio never breaks UI).

---

## 4. Game client — `public/js/main.js`, `public/js/scenes/boot.js`, `public/js/scenes/game.js`

### main.js
- Creates the Phaser game: `{ type: Phaser.AUTO, parent: 'game', width: WORLD_W,
  height: WORLD_H, pixelArt: true, scale: { mode: Phaser.Scale.FIT, autoCenter:
  Phaser.Scale.CENTER_BOTH } }`, scenes `[Boot, Game]`.
- Creates/initializes net + UI: `net.connect(); initUI(net);`
- On net `start` message: `game.scene.start('Game', startPayload)` — including when a Game
  scene is already running (rematch ⇒ restart scene with new payload).

### boot.js
- Calls `bakeTextures(this)` from sprites.js, then sits idle (menu is HTML; Boot just shows a
  subtle animated retro background or simply a black screen). No scene transition logic —
  main.js starts 'Game' when the server says so.

### game.js — Scene key 'Game'. The heart of the client.
On `init(data)` receive the `start` payload. Build local state:
- `heights = generateTerrain(data.seed)` then `placePlayers(heights, players.length, data.seed)`
  (imported from `/shared/sim.js`) — but POSITIONS come from the payload (authoritative);
  calling placePlayers is required to reproduce the flattened pads in `heights`.
- Draw: sky (vertical gradient, retro dusk palette), a few drifting `cloud_*` sprites,
  distant mountain silhouette (seeded, darker), terrain rendered from `heights` (redrawable —
  use a Graphics object or RenderTexture; terrain fill with a dirt color + lighter 2px grass
  cap line). Redraw terrain after every crater.
- Trebuchets: sprite `treb_<colorIdx>_idle` at each player position, origin bottom-center,
  `flipX` so they face map center. Name label + HP bar above each (HP bar = tiny Graphics,
  team-colored fill over dark bg).
- HUD (in-canvas, top): wind indicator centered (pixel arrow, length/direction ∝ wind, text
  like `WIND ◄ 12`), turn banner (`YOUR TURN` flashing / `RED'S TURN`), turn countdown (s).
  Bottom-left: `ANGLE 45  POWER 70` readout for your aim. Keep HUD inside 480×270, chunky.
- Aiming (only when it's your turn and no shot is animating): ←/→ angle ±1 (Shift ⇒ ±5),
  ↑/↓ power ±1 (Shift ⇒ ±5), clamped to constants. Show a short aim line from your trebuchet
  (direction = angle, length ∝ power). SPACE or click on a FIRE button region ⇒
  `net.send({t:'fire', angle, power})`, lock input until the shot resolves. Remember
  angle/power between turns. (Angle > 90 means shooting left — that's how you aim left.)
- On `shot` message (ALL clients, including shooter): play fire animation on shooter's
  trebuchet (`treb_<c>_fire` frame briefly, SFX 'fire'), then animate the `rock` sprite along
  `trajectory` (each sample = 1/60 s; step through time-based, slight rotation). Camera
  follows nothing (fixed view). On impact: explosion animation `boom_0..4` (~80 ms/frame) at
  impact, SFX 'explode', small camera shake, `applyCrater(heights, crater)` + terrain redraw,
  apply `hits` (update hp bars, flash hit trebuchet white), tween `settled` players down,
  deaths ⇒ bigger boom + remove trebuchet + SFX 'death'. Then if `next`: update turn/wind/
  timer, unlock input if it's now your turn (SFX 'yourturn' when it becomes your turn).
  If `winner`/`draw`: SFX 'win'/'lose', then dispatch
  `document.dispatchEvent(new CustomEvent('ui:gameover', { detail: { winnerName, youWin,
  draw, isHost } }))` (isHost: compare net.you against hostId from the latest `lobby` msg —
  track it via a net listener).
- On `turn` (timeout skip): brief "TIME UP" note, update turn/wind/timer.
- On `left`: remove that trebuchet (small poof), toast-style in-canvas note "<NAME> LEFT",
  handle `next`/`winner` same as in `shot`.
- All net listeners registered in `create()` MUST be removed in scene `shutdown` (rematch
  restarts the scene — avoid double handlers).
- SFX via `import { SFX } from '../sfx.js'` (path from scenes dir: `../sfx.js`).

---

## 5. Art & sound — `public/js/sprites.js`, `public/js/sfx.js`

### sprites.js
```js
export function bakeTextures(scene)   // creates all textures via canvas, no external files
export const SPRITES_READY = true     // (sanity import marker)
```
Pixel art defined as string-grid arrays + palette maps, drawn to canvases
(`scene.textures.addCanvas` or createCanvas+context), 1 grid cell = 1 texture pixel.
Required texture keys (exact):
- `treb_<i>_idle`, `treb_<i>_loaded`, `treb_<i>_fire` for i = 0..3 — trebuchet, 26×26,
  RECOGNIZABLE: A-frame support, long throwing arm with counterweight box on the short end,
  sling. `idle`: arm cocked down-back. `loaded` may equal idle art. `fire`: arm swung up/over.
  Team color (TEAM_COLORS[i]) used for a banner/flag pixel accent + counterweight; wood tones
  for the frame. Drawn facing RIGHT (game flips with flipX as needed).
- `rock` — 5×5 round stone, gray shades.
- `boom_0`..`boom_4` — 32×32 explosion frames: white-hot core → orange/red ring → gray smoke
  dissipating. Chunky retro explosion.
- `cloud_0`, `cloud_1`, `cloud_2` — wispy pixel clouds, ~44×14, pale, slightly transparent.
- `wind_arrow` — 16×7 left-pointing chunky arrow, white (game flips/tints it).
All textures must have transparent backgrounds. After baking each canvas call
`scene.textures.get(key).setFilter(Phaser.Textures.FilterMode.NEAREST)` (or rely on pixelArt).

### sfx.js — WebAudio synth, zero asset files
```js
export const SFX = {
  play(name),   // 'click' | 'fire' | 'explode' | 'death' | 'yourturn' | 'win' | 'lose' | 'tick'
}
```
- Lazy AudioContext (`window.AudioContext || window.webkitAudioContext`) created/resumed on
  first user gesture (install a one-time pointerdown/keydown listener at module load).
- Retro bleeps/noise: 'fire' = low thunk + whoosh (noise sweep), 'explode' = noise burst with
  lowpass decay, 'click' = short square blip, 'yourturn' = two ascending square notes,
  'win' = little ascending arpeggio, 'lose' = descending, 'death' = deeper boom, 'tick' =
  tiny blip (used by countdown last 5 s).
- `play()` must never throw (wrap internals; no-op if context unavailable/suspended).
- Keep volumes modest (master gain ~0.25).

---

## Game flow summary

1. Page load → Boot bakes textures → HTML MENU over a black/ambient canvas.
2. CREATE ⇒ server makes room ⇒ `joined` + `lobby` ⇒ LOBBY screen with invite link
   (`/?room=CODE`). Friends open link ⇒ name prefilled menu ⇒ JOIN ⇒ everyone's `lobby`
   updates.
3. Host START ⇒ server `start` ⇒ UI hides, Game scene builds world from seed.
4. Turns: aim with arrows, SPACE to fire ⇒ server simulates ⇒ `shot` broadcast ⇒ all clients
   animate identical outcome. Wind changes every turn. Terrain is destroyed; trebuchets fall.
5. Last alive wins ⇒ game-over panel ⇒ host REMATCH (new terrain) or LEAVE.
