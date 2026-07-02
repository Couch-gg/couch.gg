# couch.gg

A browser- and TV-based platform for short multiplayer games you play together in
the same room. The big screen (TV, laptop, beamer) shows the lobby and the running
game; players join by scanning a QR code or opening a shared link, and their phones
become the controllers. Always multiplayer, no account, no app install.

The full product spec lives in [project-spec.md](project-spec.md).

## Repository layout

~~~text
project-spec.md     platform product & implementation spec
apps/web/           Vite/React screen + controller web app
apps/realtime/      in-memory lobby + Socket.IO realtime server
packages/types/     shared platform types
packages/game-runtime/
                    game catalog and runtime helpers
packages/games/trebuchet/
                    Trebuchet direct platform port
games/              original game references
  trebuchet/        original TREBUCHET implementation
~~~

The platform shell now includes lobby creation, QR onboarding, phone controllers,
host start, and Trebuchet as the first real platform game.

## Platform MVP

~~~bash
pnpm install
pnpm dev
~~~

Open http://localhost:5173 on the shared screen. The realtime server runs on
http://localhost:4100. The standalone test route is
http://localhost:5173/games/trebuchet.

Run the verification loop:

~~~bash
pnpm test:unit
pnpm typecheck
pnpm build
pnpm test:e2e
~~~

### Production on Vercel

The web app and realtime endpoint deploy together on Vercel. Vercel routes the
app shell from apps/web/dist and the authoritative realtime server through
/api/realtime/* with WebSocket transport at /api/realtime/socket.io.

Fluid Compute is enabled in vercel.json. Production multiplayer uses the Vercel
Redis marketplace resource through REDIS_URL so TV and phone requests share the
same lobby state across Function instances. Local development still works without
Redis, and the server also has a Vercel Queues snapshot fallback for production
environments where Redis is not configured.

Useful production checks:

~~~bash
vercel build --prod
vercel deploy --prebuilt --prod
curl https://couch-gg.vercel.app/api/realtime/health
PLAYWRIGHT_BASE_URL=https://couch-gg.vercel.app pnpm exec playwright test
~~~

## Publish your own game

Anyone can build a game that runs on couch.gg — you write only the big-screen
render + logic; the platform provides the lobby, QR pairing, phone controllers,
and input relay. Games run in a sandboxed iframe and talk to the platform via the
`@couch/game-sdk`.

- **Full contract for creators (and their coding agents):**
  [`packages/game-sdk/COUCH-GAME-GUIDE.md`](packages/game-sdk/COUCH-GAME-GUIDE.md)
  — also served at https://couch-gg.vercel.app/COUCH-GAME-GUIDE.md.
- **Starter template:** [`templates/couch-game-starter/`](templates/couch-game-starter/)
  — a complete, degit-able example game. Open its `index.html` to try it in the
  built-in dev simulator.
- **Test & publish:** validate your manifest and publish (no account) at
  https://couch-gg.vercel.app/dev.

## Games

### [TREBUCHET](games/trebuchet/) — siege artillery duel
Trebuchets, destructible terrain, castles, wind, and plunging fire. 2–4 players
online (room codes + invite links) or local hotseat on one keyboard. Retro pixel
art, Phaser 3 client, Node + WebSocket server.

```bash
cd games/trebuchet
npm install
npm start
```

Then open http://localhost:3000. See [games/trebuchet/README.md](games/trebuchet/README.md)
for gameplay and details. The integrated platform port lives in
`packages/games/trebuchet` and is exercised by `/games/trebuchet`.
