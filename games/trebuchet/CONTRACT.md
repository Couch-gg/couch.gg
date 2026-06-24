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
public/js/local.js           [Agent SHELL — local hotseat driver]
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

## 6. Local hotseat mode — `public/js/local.js`

Lets 2–4 players share one keyboard and take turns on a single screen, with **no
server round-trip**. The online path is unchanged; local mode is purely additive.

### Driver — `public/js/local.js`
`startLocalGame(net, names)` builds a `LocalGame` that **impersonates the server
entirely client-side**. It mirrors `server/game.js` exactly (random seed,
`generateTerrain` + `placePlayers`, `PLAYER_HP`, random first turn, wind
`uniform[-WIND_MAX,WIND_MAX]` rounded to 1 decimal, `fire` clamping →
`simulateShot` → `applyCrater` → damage/alive → `settlePlayers`, deaths/winner/
draw, next-alive rotation, `TURN_MS` timeout that skips the turn) and **emits the
exact same message shapes** the server sends (`start`, `shot`, `turn`, and the
terminal `left` on a final timeout) with identical fields (`turnEndsAt` epoch ms,
`winner`/`draw`, `result.{impact,crater,hits[].hp,deaths,settled}`). Player ids
are `local_0`..`local_3`, `colorIdx` = index. `names` are sanitized (trim, strip
control chars, cap `NAME_MAX_LEN`, uppercase) with defaults `PLAYER 1`..`PLAYER 4`.
The `start` payload also carries `local: true` (online never sets it). Also
exports `isLocalActive()` and `getLocalGame()`.

### `net.send` interception hook — `public/js/net.js`
`net.local` defaults to `null` (online untouched). `startLocalGame` sets
`net.local = { handle(obj) }`. `net.send(obj)` routes **only** `{t:'fire'}` /
`{t:'rematch'}` to `net.local.handle()` instead of the WebSocket when `net.local`
is set; every other message and all online play go to the socket as before. The
driver delivers server-shaped frames back through `net.emit(type, payload)` (a
thin public wrapper over the internal `_emit`), so they flow through the same
listener path the socket uses — the Game scene and UI need no special casing.

### `net.you` convention (the key trick)
Before emitting any message that establishes whose turn it is (`start`, `shot`
with `next`, `turn`), the driver sets `net.you = <current turn player id>`. The
existing Game scene already treats `net.you` as "you" and unlocks input for it, so
the active hotseat player can aim/fire. Online behavior is unaffected (the server
still owns `net.you` via the `joined` handshake there).

### Scene + UI awareness (minimal)
- `scenes/game.js`: when `payload.local === true`, the turn banner reads
  `"<NAME>'S TURN"` (flashing, tinted with the player's team color) instead of
  `YOUR TURN`, and the `ui:gameover` detail uses `youWin:false` + `isHost:true`
  so the panel shows `"<NAME> WINS!"` / `DRAW` with REMATCH. Everything else
  (aiming, firing, animations, craters, hp, settle, deaths) runs unchanged.
- `ui.js`: a third menu option **LOCAL GAME** opens a setup panel (2–4 name rows
  via ADD/REMOVE, START, BACK). While local mode is active the connection-lost
  banner is suppressed (a ws drop must not interrupt a local game) and the
  game-over panel always offers REMATCH + LEAVE (LEAVE reloads, as online).

## Game flow summary

1. Page load → Boot bakes textures → HTML MENU over a black/ambient canvas.
2. CREATE ⇒ server makes room ⇒ `joined` + `lobby` ⇒ LOBBY screen with invite link
   (`/?room=CODE`). Friends open link ⇒ name prefilled menu ⇒ JOIN ⇒ everyone's `lobby`
   updates.
3. Host START ⇒ server `start` ⇒ UI hides, Game scene builds world from seed.
4. Turns: aim with arrows, SPACE to fire ⇒ server simulates ⇒ `shot` broadcast ⇒ all clients
   animate identical outcome. Wind changes every turn. Terrain is destroyed; trebuchets fall.
5. Last alive wins ⇒ game-over panel ⇒ host REMATCH (new terrain) or LEAVE.

Alternatively: **LOCAL GAME** ⇒ name 2–4 players ⇒ `local.js` drives an entirely
client-side hotseat match (same physics, same screens) where each player aims and
fires on their turn; REMATCH gives a fresh battlefield. See §6.

---

## 7. V2 — SIEGE UPDATE (binding spec; supersedes earlier sections where it conflicts)

Five gameplay changes. Message field names below are exact. All new tuning constants
live in `shared/constants.js` (owner: Agent SIM).

### 7.1 Trebuchet-realistic arcs (no flat shots)
- New constants: `ELEV_MIN = 50`, `ELEV_MAX = 85` (degrees of ELEVATION above horizon).
- Valid launch angles (existing 0=right/90=up/180=left convention):
  `[ELEV_MIN..ELEV_MAX]` shooting right, `[180-ELEV_MAX .. 180-ELEV_MIN]` shooting left.
  `ANGLE_MIN/ANGLE_MAX` are dead; sim + server + local driver clamp INVALID angles to the
  nearest valid bound (NaN -> ELEV_MIN rightward).
- Client aiming: LEFT/RIGHT arrows sweep the aim through `50..85` (right side) and
  `95..130` (left side) in 1° steps (Shift = 5°), SNAPPING across the 86..94 gap (85 -> 95
  and back). HUD shows direction + elevation, e.g. `ARC ► 62`.
- `SPEED_MAX = 280` (slight raise so max-power 50° lobs can still cross the map).
  Sim test: full-power 50° shot from flat ground travels > 380 px horizontally.

### 7.2 Plunging-fire damage (arc height matters) + damage numbers
- `simulateShot` tracks vertical velocity at impact (`vyImpact`, positive = falling).
- Damage multiplier `plunge = clamp(0.55 + 0.95 * (vyImpact / PLUNGE_VY_REF), 0.55, 1.5)`
  with `PLUNGE_VY_REF = 270`. Player damage becomes
  `round(DMG_MAX * (1 - dist/DMG_RADIUS) * plunge)`, min 1 when within radius.
  Sim tests: multiplier monotonic in vyImpact; an 85° full-power lob deals measurably more
  damage than a 50° full-power shot landing at the same distance from the target.
- `simulateShot` result gains `plunge` (the multiplier, 2 decimals) so clients can show it.
- CLIENT: floating damage popups at impact — for every entry in `hits` (red `-N`) and
  `castleHits` (pale stone-white `-N`), a small pixel-font number rises ~14 px and fades
  over ~900 ms at the victim's position (stagger by 120 ms if same position). Big hits
  (plunge >= 1.25) render 1 px larger with a brief white flash.

### 7.3 Hold-to-charge firing
- Power is no longer set with UP/DOWN. Hold SPACE *or* hold pointer-down on the FIRE
  button: power charges `POWER_MIN -> POWER_MAX` linearly over `CHARGE_TIME_MS = 1800`,
  shown as a charge bar (inside/beside the FIRE button AND a thin vertical meter next to
  the readout). Release fires with the charged power; reaching full charge AUTO-FIRES.
- Charging only starts when it's your turn, nothing animating, game not over. If the turn
  ends while charging (timeout), cancel silently. Keyboard repeat of Space must not
  retrigger after release-fire (guard until next keyup).
- The `fire` message is UNCHANGED (`{t:'fire', angle, power}`) — charging is client UX.
  The headless bot is unaffected protocol-wise but must aim within the new elevation
  bounds (Agent SRV updates `scripts/headless-player.js`: elevation search 50..85, both
  directions, correction logic preserved).

### 7.4 Trebuchet throw animation + improved sprite
- Agent ART redraws the trebuchet (26x26, 4 team variants) with a clearer silhouette:
  heavy A-frame, long arm, hanging counterweight box, visible sling, team banner.
- New frame keys (replace `_loaded`/`_fire`): `treb_<i>_idle` (arm cocked back, sling
  loaded), `treb_<i>_swing` (arm vertical, counterweight dropping), `treb_<i>_release`
  (arm forward-high, sling open, counterweight down). Old keys `treb_<i>_loaded` /
  `treb_<i>_fire` are REMOVED — Agent CLIENT must reference only the new keys.
- CLIENT fire sequence on every `shot`: shooter plays idle -> swing (90 ms) -> release
  (held ~360 ms) -> idle; the projectile + whoosh start AT the swing->release boundary
  (delay the trajectory animation by 90 ms). SFX 'fire' plays at release, not at message
  arrival. A small dust puff at the trebuchet on release is welcome but optional.

### 7.5 Castles (destructible forts; masonry hits score damage)
- New sim export: `buildCastles(heights, positions) -> castles`, deterministic, called by
  server, online client, and local driver right after `placePlayers` (same order). For
  player i at `(x, y)`: two flanking towers on the pad edges, each `3 px wide` columns of
  stone from the pad surface up `CASTLE_TOWER_H = 16` px, topped with 1-px crenellations,
  at offsets `x - 11..x - 9` and `x + 9..x + 11`. Castle representation:
  `castles[i] = { id: <playerId set by caller> , blocks: [{ x, y, w:1, h:1 }...] }` as a
  flat ordered list of 1x1 logical stone cells (order MUST be deterministic; block index
  identifies a cell forever).
- `simulateShot` gains a `castles` argument. Collision: a projectile within
  `PROJ_RADIUS + 0.5` of an intact block terminates there (castle impact). Block checks
  run before player-circle checks (walls protect), after the same 0.15 s arming delay.
- Destruction on ANY impact (terrain, player, or castle): every intact block whose center
  lies within `CRATER_R` of the impact is destroyed. Additionally, after `applyCrater`,
  any block left floating (its column's terrain surface dropped below the block's bottom
  edge by > 2 px AND no intact block directly beneath) collapses and counts as destroyed.
- Scoring: for each castle owner losing `n` blocks this shot, the owner takes
  `castleDmg = min(CASTLE_DMG_CAP, ceil(n * CASTLE_DMG_PER_BLOCK))` hp with
  `CASTLE_DMG_PER_BLOCK = 0.75`, `CASTLE_DMG_CAP = 12` (self-hits included — don't smash
  your own walls). This is how "hitting the castle scores points": it bleeds the owner.
- Result/message additions (server `shot` AND local driver, identical):
  `result.castleHits = [{ id, dmg, hp, blocks: [blockIndex...] }]` — `hp` is the owner's
  hp AFTER all of this shot's damage; when a player takes both blast and castle damage,
  `hits[].hp` and `castleHits[].hp` are both that same final value. `result.hits` stays
  blast-only. Deaths may result from castle damage alone — `deaths` covers both sources.
- State/authority: server (and local driver) keep authoritative castle state; clients
  mirror destroyed indices from `result.castleHits[].blocks` (like craters). On `start`
  (and rematch) everyone rebuilds castles fresh from the seed-derived positions.
- CLIENT rendering: stone pixel blocks (2-3 gray shades, slight per-block variation seeded
  by index) drawn UNDER trebuchets/HP bars; destroyed blocks vanish with a tiny gray
  debris puff. No castle texture work for Agent ART beyond (optional) a 1x1-scaled stone
  tile helper — the scene may draw blocks with Graphics directly.
- Sim tests: determinism (same inputs -> same castles), side shot into a tower terminates
  on the wall and shields the player behind it, castle damage applied and capped, floating
  blocks collapse after a crater bite under a tower.

### V2 file ownership
- Agent SIM: shared/constants.js, shared/sim.js, shared/sim.test.js
- Agent ART: public/js/sprites.js
- Agent CLIENT: public/js/scenes/game.js (charge input, popups, castle render, swing sync,
  HUD `ARC`), plus a one-line controls hint if ui.js has one (do not restructure ui.js)
- Agent SRV: server/game.js, public/js/local.js (exact parity), scripts/headless-player.js

---

## 8. V3 — MOBILE, AUDIO & EFFECTS (binding spec)

Four concerns: real touch controls + responsive layout for phones, reliable audio
when deployed (HTTPS/iOS), subtle background music, and richer SFX/VFX. File
ownership for this wave is disjoint:

- AUDIO  -> public/js/sfx.js
- ART    -> public/js/sprites.js
- GAME   -> public/js/scenes/game.js
- SHELL  -> public/index.html, public/css/style.css, public/js/ui.js

Everyone codes against the APIs/keys defined here, not against each other's code.

### 8.1 Audio engine (sfx.js) — owner AUDIO
Keep the existing surface working: `export const SFX = { play(name) }` + default
export. play() and EVERY new method must NEVER throw (wrap internals; no-op when
WebAudio is unavailable/suspended/muted).

DEPLOY/iOS UNLOCK HARDENING (this is "make sure there is sound when deployed"):
- The gesture-unlock listeners must NOT be removed until `ctx.state === 'running'`
  (today they self-remove after the first gesture even if resume() didn't take —
  the bug). Re-attempt resume on every gesture until running.
- Gesture set: `pointerdown, pointerup, touchstart, touchend, mousedown, keydown`
  (capture phase). On a successful unlock, also play one silent 1-frame buffer
  (iOS requires an actual buffer play to fully unlock output).
- Page visibility: when `document.hidden`, suspend the context / pause music; on
  visible, resume IF unlocked and not muted.

EXPANDED play(name) NAMES — existing: `click, fire, explode, death, yourturn,
win, lose, tick`. ADD: `aim` (tiny tick when the arc changes — keep very quiet),
`charge_full` (ping when charge hits max), `whistle` (descending pitch as a
projectile falls), `thud` (terrain hit, no damage — dull), `hit` (direct player
hit accent), `bighit` (heavy plunging hit), `crumble` (castle stone shatter —
noisy, gravelly). Unknown names stay a silent no-op.

SUSTAINED CHARGE TONE:
- `SFX.startCharge()` starts a quiet rising oscillator (a "winding up" whine).
- `SFX.setChargeLevel(p01)` optional: nudge its pitch with charge fraction 0..1.
- `SFX.stopCharge()` stops it cleanly (short release). Safe to call any time,
  idempotent, never throws, no-op if locked/muted.

BACKGROUND MUSIC (subtle, synthesized, zero assets):
- A separate music GainNode (~0.12, well under SFX) so it sits behind effects.
- `SFX.musicScene('menu' | 'game' | 'none')` selects/cross-changes the bed and is
  the primary control. `menu` = calm; `game` = slightly more driving but still
  subtle; `none` = fade out. Loop must be seamless and quiet (slow pad +
  sparse minor-key arpeggio, 8-bit timbres). Music starts only after unlock.
- `SFX.startMusic()/stopMusic()` low-level helpers allowed but musicScene is the
  contract the rest of the game calls.

MUTE:
- `SFX.toggleMute() -> boolean` (returns new muted state), `SFX.setMuted(bool)`,
  `SFX.isMuted() -> boolean`. Mutes ALL audio (master gain 0 / restore).
- Persist in `localStorage['treb.muted']` ('1'/'0'); read on load; default UNMUTED.

### 8.2 VFX + touch textures (sprites.js) — owner ART
Additive ONLY — keep every existing texture and key unchanged. Bake these new
keys at runtime (transparent bg, NEAREST, same approach as existing):
- `fx_spark` 3x3 hot spark (white core -> yellow).
- `fx_ember` 2x2 orange ember.
- `fx_smoke` 8x8 soft gray puff (a few alpha shades, rounded).
- `fx_debris` 3x3 stony chunk (2-3 grays) — terrain/castle debris.
- `fx_ring` 16x16 hollow shockwave ring: a 1px-thick white circle outline,
  fully transparent center (GAME scales + fades it).
- `fx_trail` 2x2 pale warm dot — projectile trail.
- `ui_arc_l` 14x14 chunky LEFT curved/elevation arrow (white).
- `ui_arc_r` 14x14 chunky RIGHT arrow (white, mirror of ui_arc_l).
- `ui_fire` 16x16 bold fire/burst glyph (white, GAME tints).
All transparent bg, NEAREST filter. GAME uses these as Phaser particle/sprite
textures and tints them per team/heat.

### 8.3 Touch controls, mobile HUD & VFX wiring (scenes/game.js) — owner GAME
TOUCH DETECTION: `const TOUCH = this.sys.game.device.input.touch ||
(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)`.

TOUCH CONTROLS (only render/enable when TOUCH; desktop keyboard path stays EXACTLY
as today — arrows aim, SPACE charges, existing FIRE button works):
- Arc pads bottom-LEFT: two buttons using `ui_arc_l` / `ui_arc_r`, each with a
  hit area >= 22x22 logical px, HOLD-TO-REPEAT sweeping the aim through the
  elevation bands (reuse the existing sweep + `_snapAim`); throttle `SFX.play('aim')`.
- Fire pad bottom-RIGHT: large button (>= 34x34 logical) using `ui_fire`; press-
  hold to charge via the existing charge path (`_beginCharge('pointer')`), shows a
  charge fill, release to fire. `SFX.startCharge()` on begin, `SFX.setChargeLevel`
  as it ramps, `SFX.stopCharge()` on release; `SFX.play('charge_full')` at max.
- DRAG-TO-AIM: a drag on the battlefield (anywhere NOT on a pad/HUD) sets the arc
  from the angle between the active trebuchet and the pointer, clamped into the
  valid elevation bands; live HUD update. Tap on a pad must not be hijacked by drag.
- Hit-test pads/fire BEFORE drag-aim so controls win. Keep all controls inside
  480x270; bump HUD font/elements up slightly when TOUCH for legibility.
- The existing `_canCharge()`/turn-end cancel/turn-epoch/online+local parity and
  scene shutdown listener removal MUST keep working; add cleanup for any new
  input handlers, tweens, emitters, and the charge tone (`SFX.stopCharge()` on
  shutdown / turn change).

VFX (apply on BOTH touch and desktop):
- Charge glow: a heat glow / pulsing aura on the active trebuchet that grows with
  charge fraction; clear on fire/cancel.
- Projectile trail: a faint `fx_trail`/`fx_smoke` emitter following the rock; stop
  + tidy on impact. Play `SFX.play('whistle')` once when the rock starts falling
  (vy turns positive / passes apex).
- Enhanced impact: expanding `fx_ring` shockwave (scale up + fade), a burst of
  `fx_spark` + `fx_ember`, and `fx_smoke`; keep the existing boom anim + camera
  shake. Direct player hit adds `SFX.play('hit')`; terrain-only (no damage) plays
  `SFX.play('thud')`.
- Big plunge (`result.plunge >= 1.25`): brief white screen flash (short, subtle),
  stronger shake, `SFX.play('bighit')`.
- Castle destruction: for destroyed blocks, spawn a few `fx_debris` chunks with
  gravity/spin that fade; `SFX.play('crumble')` once per shot that breaks masonry.
- Keep existing damage popups. Call `SFX.musicScene('game')` in create().
- Respect prefers-reduced-motion: if `matchMedia('(prefers-reduced-motion: reduce)')`
  matches, skip the screen flash and heavy particle bursts (keep core readout).

### 8.4 Responsive shell + controls chrome (index.html, css, ui.js) — owner SHELL
- Inputs: `font-size >= 16px` on coarse pointers (prevent iOS focus-zoom); tap
  targets (buttons) >= 44px min-height on coarse pointers; honor
  `env(safe-area-inset-*)` padding so notches/home-bars don't cover UI.
- Landscape phone: the #stage should use the full available viewport (it already
  caps to 16:9 — ensure no wasted clipping and that menu panels fit without
  scroll on a ~360x640..844 device in landscape).
- Portrait phone (coarse pointer + portrait orientation): show a tasteful
  `#rotate-hint` overlay ("ROTATE YOUR DEVICE" + landscape glyph) over the stage;
  it must auto-hide when the device is landscape (CSS media/orientation), and must
  NOT permanently block interaction (purely an advisory; the game still loads).
- Sound toggle: a persistent `#btn-mute` button pinned top-right of the stage
  (respecting safe-area), pointer-events auto, visible on ALL screens including
  during gameplay. Wire to `SFX.toggleMute()`; reflect muted/unmuted in its label
  (e.g. SND / MUTE or a speaker glyph). Seed its initial state from
  `SFX.isMuted()`.
- Music scene: call `SFX.musicScene('menu')` whenever the menu/lobby/local/
  gameover screens are shown (the game scene owns 'game'). ui.js already imports
  SFX for clicks — extend that import.
- Preserve all existing retro styling and desktop behavior; this is additive +
  responsive hardening, not a redesign.
