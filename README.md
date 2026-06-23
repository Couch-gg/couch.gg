# couch.gg

A browser- and TV-based platform for short multiplayer games you play together in
the same room. The big screen (TV, laptop, beamer) shows the lobby and the running
game; players join by scanning a QR code or opening a shared link, and their phones
become the controllers. Always multiplayer, no account, no app install.

The full product spec lives in [project-spec.md](project-spec.md).

## Repository layout

```
project-spec.md     platform product & implementation spec
games/              one folder per game
  trebuchet/        TREBUCHET — multiplayer retro artillery/siege duel
```

The platform shell (lobby, QR onboarding, phone controllers, game picker) is
specified in `project-spec.md`; the first game is built and playable today.

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
for gameplay and details.
