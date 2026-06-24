# TREBUCHET

A modern remake of the classic MS-DOS **Artillery** game — in the browser, multiplayer,
and with trebuchets instead of cannons. Classic retro pixel graphics, destructible
terrain, wind, and turn-based sieging for 2–4 players.

![genre](https://img.shields.io/badge/genre-artillery-orange) ![players](https://img.shields.io/badge/players-2--4-blue) ![engine](https://img.shields.io/badge/engine-Phaser%203-purple)

## Quick start

```bash
npm install
npm start
```

Then open **http://localhost:3000** in Chrome or Safari.

## Inviting players

1. Click **CREATE GAME** — you get a 4-letter room code and an invite link.
2. Send the invite link (e.g. `http://<your-ip>:3000/?room=ABCD`) to your friends.
   The server prints your LAN URLs on startup — anyone on your network can join
   with those. (For internet play, host the server on any Node-capable box or
   tunnel the port, e.g. with `ngrok http 3000`.)
3. When 2–4 players are in the lobby, the host clicks **START GAME**.

## Local hotseat (one keyboard, no network)

Want to play with friends on the same machine? From the menu click **LOCAL
GAME**, set 2–4 player names (use **+ PLAYER / − PLAYER** to size the roster),
and hit **START**. Players share one keyboard and take turns — the turn banner
names whoever is up (tinted in their team color), and input unlocks for the
active player automatically.

It runs **entirely in your browser** (no server round-trip; a dropped connection
won't interrupt a local game) and uses the **exact same physics, terrain, wind,
and damage model** as online play — it just simulates each shot client-side
instead of on the server. After a game, **REMATCH** rolls a fresh battlefield with
the same players.

## How to play

Turn-based siege duel. Last trebuchet standing wins.

**Desktop (keyboard):**

| Input | Action |
|---|---|
| ← / → | Sweep your launch arc (hold **Shift** for ±5°) |
| **Hold** Space or the FIRE button | Charge the throw — longer hold = more power |
| Release | Launch! (full charge fires automatically) |

**Phone / touch:** play in **landscape**. Drag on the battlefield to aim, or tap
the ◄ ► pads (bottom-left) to fine-tune your arc; **hold the FIRE pad**
(bottom-right) to charge and release to launch. A sound toggle sits in the
top-right corner.

- Trebuchets only **lob**: the arc stays between 50° and 85° above the horizon —
  sweep past vertical to switch sides. No flat shots; this is a siege engine.
- **Plunging fire hits harder**: the faster your stone is *falling* on impact,
  the more damage it deals (up to ~1.5×). High mortar arcs crush; shallow lobs
  glance. Damage numbers pop up at every impact.
- Each trebuchet is guarded by a **stone castle**. Walls block incoming shots —
  but smashed masonry wounds its owner (capped per shot), so chipping the fort
  is progress. Lob *over* the walls for direct hits.
- **Wind** changes every turn (top of the screen) and bends your shot — read it.
- Impacts carve **craters**; undermined towers collapse, and trebuchets fall when
  the ground beneath them is destroyed. Self-damage is very possible. **60 s** per
  turn.
- After a game the host can hit **REMATCH** for a fresh battlefield.

## Tech

- **Client:** [Phaser 3](https://phaser.io) (WebGL/Canvas, `pixelArt` rendering at
  480×270), plain ES modules, no build step. All pixel art is generated at runtime
  from hand-authored pixel grids; all sound is synthesized with WebAudio — zero
  binary assets.
- **Server:** Node.js + Express + [ws](https://github.com/websockets/ws).
  Server-authoritative: every shot is simulated on the server with the shared
  deterministic physics module ([shared/sim.js](shared/sim.js)) and the result is
  broadcast; clients only animate. Terrain is generated from a shared seed, so
  every client renders an identical battlefield.
- **Tests:** `npm test` runs the deterministic-simulation test suite.

```
server/   Express + WebSocket server, rooms, turn engine
shared/   deterministic sim + game constants (used by server AND browser)
public/   client: Phaser scenes, pixel-art baker, WebAudio sfx, menu/lobby UI,
          local hotseat driver (public/js/local.js)
scripts/  dev utilities: headless protocol bot, TCP proxy for local testing
```

### Dev utilities

- `node scripts/headless-player.js <ROOM> [name]` — a headless WebSocket player
  that joins a room and plays with simple self-correcting aim. Handy for testing
  multiplayer without a second human.
- `node scripts/tcp-proxy.js` — forwards port 3001 → 3000 so a second local
  browser profile/preview can be pointed at the same server.

## Browser support

Chrome, Safari, Firefox, Edge (current versions). No Chrome-only APIs are used;
clipboard and WebAudio have Safari-compatible fallbacks.
