# couch.gg game starter — Tap Race

A tiny, complete couch.gg game: a tap-race where the first player to 30 taps
wins. Use it as the skeleton for your own game.

> **The fast path: hand [`COUCH-GAME-GUIDE.md`](https://couch-gg.vercel.app/COUCH-GAME-GUIDE.md)
> to your coding agent** (Claude, Cursor, ChatGPT) along with this folder, and
> say "turn this into my game following the guide." The guide is the full,
> source-accurate contract; this template is a working starting point.

## What's here

- `index.html` — the game. Loads the SDK, reads the manifest, counts taps, draws
  a winner screen, calls `couch.gameOver`. ~150 lines, commented.
- `couch.game.json` — the manifest. Valid per the platform validator; edit it.

## 1. Copy it, open it, play it in the simulator

Grab this folder (e.g. with [degit](https://github.com/Rich-Harris/degit)):

```bash
npx degit Couch-gg/couch.gg/templates/couch-game-starter my-game
cd my-game
```

Then just **open `index.html` directly** — double-click it, or run any static
server and visit it at the top level. Because it isn't inside an iframe, the SDK
boots the **built-in dev simulator**: a panel at the bottom with fake phones,
add/remove-player buttons, and pause/resume.

- Tap a fake phone's `TAP!` button — the count goes up.
- Player 1 also responds to the **keyboard**: press `1` to tap.
- First to 30 taps triggers the winner screen and a game-over toast.

No account, no server, no build step.

## 2. Edit and test

- Change `WIN_TAPS` in `index.html`, add controls, redraw — re-open the file to
  see it in the simulator.
- Add controls by editing `controllerLayout.controls` in `couch.game.json`
  (types: `button`, `hold`, `slider`, `select`). The simulator renders them
  automatically; handle their inputs in `onInput`. See the guide's input model
  section for the exact payload each control type emits.
- When ready, paste your manifest into **https://couch-gg.vercel.app/dev** to
  validate it against the real platform and test your hosted game end-to-end.

## 3. Deploy static + publish

1. **Host `index.html` + `couch.game.json` on any static HTTPS host.** GitHub
   Pages, Netlify, Vercel, and Cloudflare Pages all work.

   Your game runs in a sandboxed iframe with an opaque origin, so its
   `fetch('./couch.game.json')` sends `Origin: null`. **Your host must send
   `Access-Control-Allow-Origin: *`** or the fetch is blocked:
   - **GitHub Pages**: works by default, nothing to do.
   - **Netlify / Cloudflare Pages**: add a `_headers` file with
     `/*` then an indented `Access-Control-Allow-Origin: *`.
   - **Vercel**: add a `vercel.json` `headers` rule setting
     `Access-Control-Allow-Origin: *` for `/(.*)`.

   (Full config snippets are in the guide.)

2. **Set `entryUrl`** in `couch.game.json` to your hosted `index.html` URL (https,
   no hash, ≤512 chars), and change `id` to something unique.

3. **Publish at https://couch-gg.vercel.app/dev**: paste the manifest, run the
   test until the handshake is green, publish. You'll get a **management token
   shown once** — save it; it's the only way to update or delete your game later.

That's it — your game is in the catalog.
