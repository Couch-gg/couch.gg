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

Fluid Compute is enabled in vercel.json. For a reliable production multiplayer
room, connect the Vercel Redis marketplace resource so REDIS_URL is available
to the project. Without Redis, local development still works, but a production
deployment can split TV and phone connections across different Function
instances.

Useful production checks:

~~~bash
vercel build --prod
vercel deploy --prebuilt --prod
curl https://couch-gg.vercel.app/api/realtime/health
PLAYWRIGHT_BASE_URL=https://couch-gg.vercel.app pnpm exec playwright test
~~~

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
