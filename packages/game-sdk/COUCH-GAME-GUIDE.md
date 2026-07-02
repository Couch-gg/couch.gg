# Build a couch.gg game

This is the complete, authoritative contract for building a game that runs on
**couch.gg**. It is written to be handed to a coding agent (Claude, Cursor,
ChatGPT) verbatim: paste it in and say "make my game couch.gg-ready following
this guide." Every code block is runnable as written. Every limit and behaviour
below is taken from the platform source, not aspiration.

If you only read one section, read **2 (sandbox)** and **13 (pitfalls)** — that
is where games break.

---

## 1. What couch.gg is, and what it does for your game

couch.gg is a "big screen + phones" party-games platform. One shared screen (a
TV, laptop, or beamer) shows the lobby and the running game. Players join by
scanning a QR code or opening a link; their phones become the controllers. No
accounts, no installs.

The platform provides all of this **for you**:

- **The lobby**: a room code, QR/link onboarding, and a live roster of 1–8
  players.
- **Phone controllers**: the platform renders the controller UI on each player's
  phone from the controls you declare in your manifest. You never write phone
  code.
- **The input relay**: taps/holds/slider drags/selects from every phone are
  ordered, rate-limited, and delivered to your game as a single stream.
- **The catalog**: once published, your game appears in the in-app game picker
  alongside the built-ins.

**Your game only renders and reacts.** It runs on the big screen inside a
sandboxed iframe, receives a roster + an ordered input stream from the SDK, draws
whatever it wants, and calls `couch.gameOver(scores)` when it is done. You write
no networking, no controller UI, no matchmaking.

---

## 2. How your game runs: the sandboxed iframe (read this)

The big screen embeds your game like this (from `GameHostStage.tsx`):

```html
<iframe src="YOUR_ENTRY_URL"
        sandbox="allow-scripts"
        allow="autoplay"
        referrerPolicy="no-referrer"></iframe>
```

`sandbox="allow-scripts"` and **no** `allow-same-origin`. This is deliberate and
non-negotiable, and it has hard consequences:

1. **Your origin is opaque ("null").** The browser treats your document as
   having no real origin.

2. **`localStorage`, `sessionStorage`, and `document.cookie` THROW.** Accessing
   them raises a `SecurityError` in an opaque-origin frame. Do not touch them.
   Keep all state in memory (plain JS variables). If you have a library that
   probes storage, guard it in `try/catch` or configure it to use memory.

3. **No pop-ups, no `alert`/`confirm`/`prompt`, no top-level navigation.** The
   sandbox blocks them. `window.open` does nothing.

4. **Your asset/JSON fetches send `Origin: null`.** When your game does
   `fetch('./couch.game.json')` or loads any same-host asset over HTTP, the
   request carries `Origin: null` because the frame origin is opaque. **Your host
   MUST answer with `Access-Control-Allow-Origin: *`** or the browser blocks the
   response. This is the single most common reason a game loads blank. It bit the
   platform's own test harness (see `serve-fixture.mjs`), which is why the fix is
   baked into this guide.

   One-line CORS configs for common static hosts:

   - **GitHub Pages** — works by default; it already sends
     `Access-Control-Allow-Origin: *` on static assets. Nothing to do.
   - **Netlify** — add a file named `_headers` at your publish root:

     ```
     /*
       Access-Control-Allow-Origin: *
     ```

   - **Vercel** — add `vercel.json`:

     ```json
     {
       "headers": [
         {
           "source": "/(.*)",
           "headers": [
             { "key": "Access-Control-Allow-Origin", "value": "*" }
           ]
         }
       ]
     }
     ```

   - **Cloudflare Pages** — add a `_headers` file (same syntax as Netlify above).

   You can avoid the fetch entirely by inlining the manifest as a JS object and
   passing it straight to `CouchSDK.init({ manifest })` — the SDK never fetches
   it for you. The starter template fetches it (with the CORS note) to keep one
   source of truth, but inlining is a valid choice.

5. **Autoplay audio is allowed** (`allow="autoplay"`), but start muted or on the
   first input to respect browser policies.

---

## 3. Quick start (~10 lines)

Hot-link the production SDK and initialise. This is a complete, working game
skeleton:

```html
<!doctype html>
<html>
<body>
  <script src="https://couch-gg.vercel.app/sdk/v1/couch-sdk.js"></script>
  <script>
    async function main() {
      const manifest = await (await fetch('./couch.game.json')).json();
      const couch = await CouchSDK.init({
        manifest,
        onInput(input) {
          // input = { seq, at, playerId, control, action, value }
          console.log(input.playerId, 'pressed', input.control);
        },
        onPlayersChanged(players) {
          console.log('roster:', players.map((p) => p.name));
        }
      });
      // ... render your game using couch.players, couch.seed, etc.
    }
    main();
  </script>
</body>
</html>
```

`CouchSDK.init` **resolves when the platform host has finished the handshake**
(embedded) or **immediately with the built-in dev simulator** (when you open the
file directly at top level). It never rejects — the host owns timeout UX.

The SDK global is `CouchSDK` (an IIFE bundle). The URL
`https://couch-gg.vercel.app/sdk/v1/couch-sdk.js` is stable.

---

## 4. Full SDK reference

Signatures below are lifted from `packages/game-sdk/src/index.ts` and
`src/protocol.ts`.

### 4.1 `CouchSDK.init(options)`

```ts
CouchSDK.init(options: CouchInitOptions): Promise<CouchGame>

interface CouchInitOptions {
  manifest: CouchManifest;                              // required; passed in, never fetched by the SDK
  onInput?: (input: CouchInputEnvelope) => void;        // same as on('input')
  onPlayersChanged?: (players: CouchPlayer[]) => void;  // same as on('playersChanged')
  onPause?: (payload: { reason: string }) => void;      // same as on('pause')
  onResume?: () => void;                                // same as on('resume')
}
```

The convenience callbacks are exactly equivalent to subscribing via `couch.on(...)`.

### 4.2 The `CouchGame` handle

Every property is read-only. Every value is set by the host at init (or by the
dev simulator when standalone).

```ts
interface CouchGame {
  readonly players: CouchPlayer[];   // current roster (live; re-read it, don't cache)
  readonly seed: string;             // deterministic per-session seed — derive ALL randomness from it
  readonly mode: 'live' | 'dev' | 'test';
  readonly latencyTier: 'local' | 'remote';
  readonly locale: string;           // BCP-47 hint, e.g. 'en-US'
  readonly reducedMotion: boolean;   // true if the player prefers reduced motion — honour it
  readonly manifest: CouchManifest;  // the manifest the host echoed back (may be enriched)
  readonly lastSeq: number;          // highest input seq seen so far, or -1 before any input

  on<E>(event: E, cb: (payload) => void): () => void;  // returns an unsubscribe fn
  gameOver(scores: CouchScore[] | Record<string, number>): void;  // call ONCE
}
```

- `mode`:
  - `'live'` — running in a real couch on the big screen.
  - `'test'` — running in the `/dev` test harness (same host bridge, but the
    platform skips the real finish/probe side effects).
  - `'dev'` — running standalone (you opened the file at top level); the built-in
    simulator is active.
- `latencyTier` — see section 6. Treat `'remote'` as a design constraint.
- `lastSeq` — the highest `seq` your game has received. Useful for reconnection /
  replay checks. `-1` means no input yet.

### 4.3 Events (`couch.on(name, cb)`)

`on` returns an unsubscribe function. Event names and payloads:

| Event            | Payload                        | When |
|------------------|--------------------------------|------|
| `input`          | `CouchInputEnvelope`           | A player used a control. |
| `playersChanged` | `CouchPlayer[]` (full roster)  | Any join/leave/rename/connect change. |
| `pause`          | `{ reason: string }`           | Host tab hidden (`reason: 'host-hidden'`). |
| `resume`         | `void`                         | Host tab visible again. |
| `abort`          | `{ reason: string }`           | Session torn down (`reason: 'host-unmounted'`). |

```ts
const off = couch.on('input', (e) => { /* ... */ });
// later: off();
```

Note: `pause`/`resume`/`abort` have no convenience-callback slot except pause and
resume — subscribe to `abort` explicitly via `on('abort', ...)` if you need it.

### 4.4 Types

```ts
interface CouchPlayer {
  id: string;         // stable per-lobby id — key ALL your player state off this
  name: string;
  colorIdx: number;   // 0-based palette index the host assigned; use for colours
  connected: boolean; // false while their phone is reconnecting
}

interface CouchInputEnvelope {
  seq: number;        // monotonic per-lobby sequence — host guarantees strict order
  at: number;         // host-clock timestamp in MILLISECONDS
  playerId: string;   // authoritative; derived server-side from the player's token
  control: string;    // matches a manifest controllerLayout.controls[].control
  action: 'press' | 'release' | 'change';
  value?: unknown;    // per-control payload (see section 5)
}

interface CouchScore { playerId: string; score: number; }
```

### 4.5 `gameOver`

```ts
couch.gameOver([{ playerId: 'p1', score: 30 }, { playerId: 'p2', score: 12 }]);
// or the record form:
couch.gameOver({ p1: 30, p2: 12 });
```

- Both forms are accepted; the record form is normalised to the array form
  (`playerId` string, `score` number).
- **Call it exactly once.** A second call logs a warning and is ignored.
- After this, the platform shows your winner screen for ~5 seconds, then returns
  to the catalog (section 9).

---

## 5. The input model

### 5.1 Declare → render → receive

1. You **declare** controls in `couch.game.json` under
   `controllerLayout.controls` (kind must be `'generic-buttons'`).
2. The platform **renders** the matching control on every player's phone. You
   write no phone code.
3. When a player uses a control, you **receive** a `CouchInputEnvelope` via
   `onInput` / `on('input')`.

### 5.2 What the phone emits per control type

Verified against `GenericController.tsx` (the real phone UI). `value` on the
envelope is exactly the `data` object shown:

| Type     | `action` sequence you receive | `value` payload |
|----------|-------------------------------|-----------------|
| `button` | `press` then `release`        | `undefined` |
| `hold`   | `press`, then repeated `change`, then `release` | `change` → `{ progress }` (0–1); `release` → `{ heldMs }` |
| `slider` | repeated `change` while dragging, plus a final `change` on release | `{ value }` (a number, snapped to `min`/`max`/`step`) |
| `select` | `change` on each tap          | `{ value }` (the chosen option string) |

Cadence details (so you know how often events arrive):

- **hold**: `change` fires about every **120 ms** while held; on release you get
  one `release` with total `{ heldMs }`.
- **slider**: `change` is coalesced to at most one per **~100 ms** while
  dragging; a final `change` with the released value is always sent on release,
  even if it was coalesced away. So the last value is authoritative.
- **button**: `press` on pointer-down, `release` on pointer-up/leave.
- **select**: one `change` per tap with the picked option.

The dev simulator emits the **same** shapes, so what you test locally matches
production.

### 5.3 Ordering and timestamps

- `seq` is a **strict monotonic per-lobby** counter. The host guarantees order.
  Use it to break ties or to ignore stale inputs; `couch.lastSeq` tracks the
  latest.
- `at` is a **millisecond** timestamp on the host clock. (The wire format inside
  the platform is an ISO string, but the SDK hands you a number — do not
  re-parse it.)
- `playerId` is authoritative and server-derived. Never trust a client-supplied
  player id; use the envelope's `playerId`.

---

## 6. Local vs remote (latencyTier) — and the remote contract

`couch.latencyTier` tells you how the lobby is wired:

| Tier      | How inputs travel | Typical latency | Design implication |
|-----------|-------------------|-----------------|--------------------|
| `local`   | Same server instance, socket broadcast | ~50 ms | Real-time reflexes are fine. |
| `remote`  | Persisted input log + client poll across serverless instances | up to ~750 ms + RTT | **No twitch gameplay.** Turn-based / discrete only. |

Remote couches exist because the production deployment (Vercel serverless) has no
cross-instance socket adapter — inputs are written to a persisted, ordered log and
other instances **poll** for them. That poll window is why remote latency is high
and variable.

### The `supportsRemote: true` contract

If you set `supportsRemote: true` in your manifest, you are promising your game is
**deterministic** from the seed plus the ordered input stream. Concretely:

- **Deterministic from `couch.seed` + ordered inputs.** Given the same seed and
  the same sequence of inputs, every screen computes the same state. (In a remote
  couch, more than one screen may be rendering.)
- **Discrete / turn-based inputs only.** No reliance on sub-second input timing.
- **No `Math.random()` for anything score-relevant.** Seed a PRNG from
  `couch.seed` instead. `Math.random()` is fine for purely cosmetic effects that
  never affect the outcome.
- **No wall-clock dependence for game logic.** Do not branch on `Date.now()` or
  animation-frame timing for anything that determines the result. Use `seq`
  ordering and the seed.

If your game needs twitch timing, **omit `supportsRemote`** (or set it `false`).
The platform will then refuse to select your game in a remote lobby (it throws
"Dieses Spiel unterstützt Remote Couch nicht"), which is the correct outcome —
better than a game that plays unfairly over a 750 ms link.

---

## 7. `couch.game.json` — the manifest schema

Every rule below is enforced by `validateExternalManifestInput`
(`packages/game-runtime/src/external-manifest.ts`). Types are **strict**: a
numeric string is a type error, not a number. Strings are trimmed.

### 7.1 Fields

| Field | Type | Rule |
|-------|------|------|
| `id` | string | Must match `^[a-z0-9][a-z0-9-]{2,31}$` (3–32 chars, lowercase alphanumeric + hyphen, starts alphanumeric). Not a reserved id (see 7.3). |
| `title` | string | 1–40 chars after trim. |
| `description` | string | 1–200 chars after trim. |
| `minPlayers` | integer | ≥ 1. |
| `maxPlayers` | integer | ≤ 8. And `minPlayers ≤ maxPlayers`. |
| `controllerLayout.kind` | string | Must be exactly `'generic-buttons'`. |
| `controllerLayout.controls` | array | 1–12 controls. |
| `controls[].control` | string | Matches `^[a-z0-9._-]{1,32}$`. Unique within the layout. |
| `controls[].type` | string | One of `button` \| `hold` \| `slider` \| `select`. |
| `controls[].label` | string | 1–16 chars after trim. |
| `controls[].min` / `max` | number | **Required for `slider`.** `min < max`. |
| `controls[].step` | number | Optional for `slider`; if present, `> 0`. |
| `controls[].options` | string[] | **Required for `select`.** 2–8 entries, each 1–16 chars. |
| `aspectRatio` | string | `'16:9'` or `'4:3'`. |
| `estimatedDurationMinutes` | integer | 1–60. |
| `thumbnail.kind` | string | Must be `'css'`. |
| `thumbnail.gradient` | string | 1–120 chars (a CSS gradient string). |
| `thumbnail.icon` | string | 1–40 chars (an icon name). |
| `thumbnail.accent` | string | Optional. |
| `entryUrl` | string | See 7.2. |
| `sdkProtocol` | number | Must be exactly `1`. |
| `supportsRemote` | boolean | Optional; must be a boolean if present. See section 6. |
| `author` | object | Optional. `{ name: string (1–40), url?: string (https, ≤200 chars) }`. |

### 7.2 `entryUrl` rules

- Non-empty string, **≤ 512 characters**.
- Must be a valid URL.
- Must use **`https`** (plain `http` is allowed **only** for `localhost` in dev
  mode).
- **No username or password** in the URL.
- **No hash fragment** (`#...`).
- **No private / loopback / link-local IPv4 literal**: `10.x`, `127.x`,
  `172.16–31.x`, `192.168.x`, `169.254.x` are all rejected. Use a real hostname.
- **No IPv6 address literal** (`[::1]` etc.) — public IPv6 must use a hostname.

### 7.3 Reserved ids

Your `id` may not be any of these (built-in games + reserved route/API segments):

```
trebuchet, tank-duel, quiz-rush, kart-chaos,
dev, admin, api, games, sdk, couch, screen, lobby,
s, c, l, j, new, test
```

### 7.4 Complete annotated example

```json
{
  "id": "tap-race",
  "title": "Tap Race",
  "description": "First to 30 taps wins. Mash your button faster than everyone else.",
  "minPlayers": 1,
  "maxPlayers": 8,
  "controllerLayout": {
    "kind": "generic-buttons",
    "controls": [
      { "control": "tap", "type": "button", "label": "TAP!" }
    ]
  },
  "aspectRatio": "16:9",
  "estimatedDurationMinutes": 2,
  "thumbnail": {
    "kind": "css",
    "gradient": "linear-gradient(160deg,#12324d,#2d8fbe)",
    "icon": "zap"
  },
  "entryUrl": "https://your-host.example.com/index.html",
  "sdkProtocol": 1,
  "supportsRemote": true,
  "author": { "name": "Your Name", "url": "https://your-site.example.com" }
}
```

`origin`, `status`, and `publishedAt` are stamped by the server on publish — do
**not** include them yourself.

---

## 8. Player lifecycle

- **1–8 players**, bounded by your `minPlayers`/`maxPlayers`. The platform will
  not start below `minPlayers` and will not admit above `maxPlayers`.
- Players **join and leave mid-game**. You are notified via `playersChanged`
  (full roster) every time the roster changes. Re-read `couch.players` or use the
  payload — do not assume the roster you saw at init is final.
- A phone that drops shows `connected: false` before it is removed; you get a
  `playersChanged`. Design so a briefly-disconnected player is not instantly
  eliminated.
- **`pause` / `resume`**: the host fires `pause` (`reason: 'host-hidden'`) when
  the big-screen tab is backgrounded and `resume` when it returns. Pause your
  animation loop and timers so nothing advances while nobody can see it.
- **`abort`** (`reason: 'host-unmounted'`) fires when the session is torn down
  (lobby closed, game switched). Stop everything; do not call `gameOver` after an
  abort.

Design guidance: key every bit of per-player state off `player.id` (never array
index — indices shift when someone leaves). Handle a player count of 1 gracefully
(solo play against the clock or a target), since `minPlayers` can be 1.

---

## 9. Game over (design for the 5-second window)

When your game ends, call `couch.gameOver(scores)` once. Then:

- The platform records the scores and, within milliseconds, flips the lobby to
  its ended state.
- Your game's own screen (whatever you drew — winner, final scores, celebration)
  **stays visible for ~5 seconds** (`GAME_OVER_LINGER_MS = 5000` in
  `LobbyRoute.tsx`), then the screen returns to the catalog.

So: **draw your winner/results screen before or at the moment you call
`gameOver`.** You have a ~5-second window to show it. Do not rely on any input
after `gameOver` — the controllers move on. Highest `score` wins by convention
(the platform sorts descending to name a winner in its own activity log), so make
"more is better" true for your scoring.

---

## 10. Rate & size limits (exact numbers)

From `rate-limit.ts`, `lobbies.ts`, and `GameHostStage.tsx`:

- **Per-player input rate**: token bucket, capacity **20** (burst), refill **10
  tokens/second**. Inputs beyond this from one player are silently dropped
  (not an error) — the controller stream stays healthy.
- **Per-lobby aggregate input rate**: capacity **60** (burst), refill **30
  tokens/second** across all players.
- **Input `value` size**: the `data` payload is JSON-encoded and capped at
  **1024 bytes**; larger is rejected with a 413. Keep control values tiny (a
  number, a short string).
- **Inbound message size (game → host)**: messages you post to the host are
  capped at **8192 bytes** (serialized); oversized messages are dropped.
- **Inbound message rate (game → host)**: **60 messages per rolling second**;
  beyond that they are dropped.
- **Handshake / ready timeout**: **15 seconds**. If the host does not receive
  `couch:ready` within 15 s of embedding you, it shows a "This game didn't
  respond" overlay and reports a probe failure. `CouchSDK.init` sends `ready`
  automatically the moment the handshake completes, so just make sure `init()`
  runs promptly on load.

These are per serverless instance; do not treat them as a hard global quota, but
do design well within them. For a mash game, sending one `press` per tap is far
under 10/s per player in practice.

---

## 11. Test locally

Two levels, no account needed.

### 11.1 Open the file directly → built-in dev simulator

Open your `index.html` directly (double-click, or `file://`, or any static
server) so it runs **at the top level** (not inside an iframe). Because
`window.self === window.top`, the SDK boots the **dev simulator**: a bottom
overlay with fake phones, add/remove-player buttons, pause/resume, and a seed
box. `CouchSDK.init` resolves immediately with `mode: 'dev'`.

- The simulator seeds **2 fake players** and renders one fake phone per player
  with your declared controls.
- Player 1 also takes **keyboard** input: number keys `1`–`9` press the Nth
  button/hold control, `Space` holds the first hold control, `Arrow Up/Down`
  nudge the first slider.
- Calling `couch.gameOver(scores)` shows a game-over toast in the simulator.

This is the fastest loop and the one your coding agent should use to iterate.

### 11.2 The real-platform harness at `/dev`

Go to **https://couch-gg.vercel.app/dev**. Paste your manifest JSON. The page
validates it live against the real validator, then embeds your `entryUrl` in the
**real** `GameHostStage` with the **real** `GenericController` (no mocks). You can
drive fake inputs, watch the handshake succeed, and see your `gameOver` scores.
This is also where you publish (section 12).

(For local development against a locally-running platform, the same `/dev` route
exists and `http://localhost` entry URLs are permitted there.)

---

## 12. Publish

Publishing is REST + a management token. No accounts.

### 12.1 Via the `/dev` page

1. Host your game somewhere static and public over HTTPS with CORS `*`
   (section 2).
2. Put the public `entryUrl` in your manifest.
3. Open **https://couch-gg.vercel.app/dev**, paste the manifest, run the test so
   the handshake goes green (this sends an honest `attestation.handshakeOk` with
   your submit), then click publish.
4. On success you get a **management token, shown exactly once**. Copy it now —
   it is never displayed again and is not recoverable. It is the only credential
   that lets you update or delete your game.

The platform runs an automated server-side **probe** of your `entryUrl` at submit
time: it must return a 2xx HTML response within 5 s or the submit is rejected
("entryUrl is not reachable or is not an HTML page"). If it passes, your game is
**auto-published** — it appears in the catalog immediately.

### 12.2 Manage it later with `curl`

The production API base is `https://couch-gg.vercel.app/api/realtime`. The token
goes in the `x-management-token` header.

Update (re-validates the whole manifest; the `id` must stay the same):

```bash
curl -X PATCH https://couch-gg.vercel.app/api/realtime/games/YOUR_ID \
  -H 'Content-Type: application/json' \
  -H 'x-management-token: YOUR_TOKEN' \
  -d '{ "manifest": { /* full manifest JSON */ } }'
```

Delete:

```bash
curl -X DELETE https://couch-gg.vercel.app/api/realtime/games/YOUR_ID \
  -H 'x-management-token: YOUR_TOKEN'
```

Notes:
- Changing `entryUrl` on update resets your probe status to unverified; it is
  re-checked on the next real load.
- The `id` cannot be changed on update (returns 422).

### 12.3 Staying published: probe & report auto-hide

Two automated mechanisms can hide a game from the catalog (from
`games-registry.ts`):

- **Community reports**: at **3 reports**, the game auto-hides.
- **First-load probes**: a real TV reports whether your game handshook on load.
  **3 consecutive probe failures** mark the game failed and hide it from the
  catalog (URL-rot defence). A single **ok** probe resets the fail counter and
  marks it healthy again.

So the practical rule: keep your `entryUrl` live and make sure `init()` reaches
`ready` (no 15 s timeout). A game that loads reliably stays listed.

---

## 13. Pre-publish checklist + common pitfalls

### Checklist

- [ ] `index.html` loads the SDK from
      `https://couch-gg.vercel.app/sdk/v1/couch-sdk.js`.
- [ ] `CouchSDK.init({ manifest, ... })` runs immediately on load (so `ready`
      fires well within 15 s).
- [ ] The manifest passes the validator (test it at `/dev`).
- [ ] Your host sends `Access-Control-Allow-Origin: *` (or you inline the
      manifest).
- [ ] No `localStorage` / `cookie` / `alert` / `window.open` anywhere.
- [ ] All per-player state keyed off `player.id`.
- [ ] `playersChanged` handled (join/leave mid-game).
- [ ] A winner/results screen is drawn, and it reads well for ~5 s after
      `gameOver`.
- [ ] `gameOver(scores)` called exactly once, higher score = better.
- [ ] If `supportsRemote: true`: no `Math.random()` for score logic, no
      wall-clock branching, deterministic from `couch.seed` + ordered inputs.
- [ ] `reducedMotion` honoured (skip big animations when true).

### Pitfalls (symptom → cause → fix)

- **Game loads blank; console shows a CORS error on `couch.game.json` or an
  asset.**
  Cause: the sandbox frame's fetch sends `Origin: null` and your host didn't send
  `Access-Control-Allow-Origin: *`.
  Fix: add the wildcard CORS header (section 2), or inline the manifest and skip
  the fetch.

- **Game throws immediately, often `SecurityError`.**
  Cause: something touched `localStorage` / `sessionStorage` / `document.cookie`
  in the opaque-origin sandbox.
  Fix: remove all storage access; keep state in memory. Guard any third-party lib
  that probes storage.

- **"This game didn't respond" overlay after ~15 s.**
  Cause: `couch:ready` never sent — usually `CouchSDK.init` never ran, threw
  before completing, or the script 404'd.
  Fix: ensure the SDK `<script>` loads, `init()` is called on load, and no error
  is thrown before it resolves.

- **Phones show the platform's generic controller, but not what I expected /
  nothing happens on tap.**
  Cause: the phone controller is generated from your manifest's
  `controllerLayout.controls`, and your game must react to those control names.
  If a phone tap does nothing, either the control name in your `onInput` handler
  doesn't match the manifest, or you're expecting the wrong `action` (e.g. acting
  on `release` when a `button` also sends `press`).
  Fix: match `input.control` to your declared `control` names and handle the
  right `action` (see section 5.2).

- **Game feels laggy / unfair for some players.**
  Cause: it's a `remote` lobby (`couch.latencyTier === 'remote'`) but the game
  assumes local latency.
  Fix: either make the game deterministic and turn-based and set
  `supportsRemote: true`, or omit `supportsRemote` so it's local-only.

- **Winner screen flashes and disappears.**
  Cause: you drew results *after* a delay, past the ~5 s linger.
  Fix: draw the results screen at the moment you call `gameOver`; you have ~5 s
  before the catalog returns.

- **Randomness differs between screens in a remote couch.**
  Cause: `Math.random()` or `Date.now()` used for game logic.
  Fix: seed a PRNG from `couch.seed`; order by `seq`; never branch game logic on
  the wall clock.
