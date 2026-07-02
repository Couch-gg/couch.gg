# Orchestrator Ledger — Third-Party Game Publishing

Plan: ~/.claude/plans/use-orchestrator-skill-wiggly-hejlsberg.md
Base: 86bb9b3 (origin/main). Branch: claude/thirsty-blackwell-3bfd4e.
Gates: `pnpm build:packages` → `pnpm typecheck` → `pnpm test:unit` → `pnpm build` → `pnpm test:e2e` (waves 2+).

| ID | Task | Wave | Tier | Scope (files) | State | Redos | Notes |
|---|---|---|---|---|---|---|---|
| 1A | Types + external-manifest validator (+tests) | 1 | Opus | packages/types/src/index.ts, packages/game-runtime/src/external-manifest.ts, packages/game-runtime/src/index.ts, packages/game-runtime/tests/**, packages/game-runtime/package.json | PASS | 0 | Verified: diffs match brief; 65 tests green; typecheck 0. Orchestrator trivial fix: IPv6-literal entryUrl rejection (SSRF gap) + 2 tests. Lockfile regen benign (includes in-flight 1B pkg). |
| 1B | @couch/game-sdk package (protocol, init, simulator, tests) | 1 | Opus | packages/game-sdk/** (new) | IN-FLIGHT | 0 | self-contained types by design; root build:packages wiring = orchestrator |
| 2A | Server thin relay (inputLog, external start/finish, guards, rate-limit, EXTERNAL_GAMES_JSON, catalog(), game:input/game:finish, +tests) | 2 | Opus | apps/realtime/src/lobbies.ts, apps/realtime/src/index.ts, apps/realtime/src/rate-limit.ts (new), apps/realtime/tests/input-relay.test.ts (new), .env.example | QUEUED | 0 | |
| 2B | TV iframe host (GameHostStage, useExternalGameInputs, LobbyRoute wiring, copy-sdk script, web deps) | 2 | Opus | apps/web/src/components/GameHostStage.tsx (new), apps/web/src/hooks/useExternalGameInputs.ts (new), apps/web/src/routes/LobbyRoute.tsx, apps/web/scripts/copy-sdk.mjs (new), apps/web/package.json | QUEUED | 0 | |
| 2C | Generic manifest-driven controller | 2 | Sonnet | apps/web/src/components/GenericController.tsx (new), apps/web/src/routes/ControllerRoute.tsx, apps/web/src/styles.css | QUEUED | 0 | |
| 2D | Tap-race fixture + e2e thin slice (after 2A-2C) | 2 | Sonnet | apps/web/tests/fixtures/** (new), apps/web/tests/external-game.spec.ts (new), playwright.config.ts | QUEUED | 0 | |
| 3A | Games registry + REST + admin (+tests) | 3 | Opus | apps/realtime/src/persistence.ts, apps/realtime/src/games-registry.ts (new), apps/realtime/src/index.ts, apps/realtime/tests/games-registry.test.ts (new) | QUEUED | 0 | |
| 3B | Catalog UI (badges, remote filter, report) + gamesApi + PairRoute remote-mode | 3 | Sonnet | apps/web/src/components/GameCatalog.tsx, apps/web/src/gamesApi.ts (new), apps/web/src/routes/PairRoute.tsx, apps/web/src/api.ts, apps/web/src/styles.css | QUEUED | 0 | |
| 4A | /dev submit + test-harness page | 4 | Sonnet | apps/web/src/routes/DevSubmitRoute.tsx (new), apps/web/src/App.tsx, apps/web/src/gamesApi.ts, apps/web/src/styles.css | QUEUED | 0 | |
| 4B | COUCH-GAME-GUIDE.md + starter template | 4 | Opus | packages/game-sdk/COUCH-GAME-GUIDE.md (new), templates/couch-game-starter/** (new), apps/web/scripts/copy-sdk.mjs (guide copy), README.md pointer | QUEUED | 0 | |
| 5A | E2E expansion (submit flow, remote 2-TV, dev simulator) | 5 | Sonnet | apps/web/tests/external-game.spec.ts | QUEUED | 0 | |

## Wave gates
- W1: build:packages + typecheck + new unit tests green → launch W2
- W2: full `pnpm test` green; DEMO: hand-registered (EXTERNAL_GAMES_JSON) tap-race plays end-to-end → launch W3
- W3: unit+typecheck+build green; submit flow works via REST → launch W4
- W4: build green; /dev handshake harness works; guide reviewed for accuracy vs code → launch W5
- W5: full suite green → commit, PR, deploy, prod verification

## Notes
- (parallel-session caution) verify origin/main hasn't moved before each merge/land.
- 2D depends on 2A (EXTERNAL_GAMES_JSON) + 2B + 2C; launch after those PASS.
- gamesApi.ts created in 3B, extended in 4A (sequential waves — no conflict).
- pnpm via corepack; shims at Roaming\npm + ~/bin already on PATH (prior session note).
