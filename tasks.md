# Orchestrator Ledger — Third-Party Game Publishing

Plan: ~/.claude/plans/use-orchestrator-skill-wiggly-hejlsberg.md
Base: 86bb9b3 (origin/main). Branch: claude/thirsty-blackwell-3bfd4e.
Gates: `pnpm build:packages` → `pnpm typecheck` → `pnpm test:unit` → `pnpm build` → `pnpm test:e2e` (waves 2+).

| ID | Task | Wave | Tier | Scope (files) | State | Redos | Notes |
|---|---|---|---|---|---|---|---|
| 1A | Types + external-manifest validator (+tests) | 1 | Opus | packages/types/src/index.ts, packages/game-runtime/src/external-manifest.ts, packages/game-runtime/src/index.ts, packages/game-runtime/tests/**, packages/game-runtime/package.json | PASS | 0 | Verified: diffs match brief; 65 tests green; typecheck 0. Orchestrator trivial fix: IPv6-literal entryUrl rejection (SSRF gap) + 2 tests. Lockfile regen benign (includes in-flight 1B pkg). |
| 1B | @couch/game-sdk package (protocol, init, simulator, tests) | 1 | Opus | packages/game-sdk/** (new) | PASS | 0 | Verified: 9/9 tests, build+typecheck 0, IIFE global clean (17.5kB/5.5kB gz). NOTE: SDK envelope.at = ms number; platform at = ISO string → host converts (pinned in 2B brief). |
| — | W1 GATE | 1 | — | — | GREEN | — | 143 unit tests, typecheck 0. Root chains wired (orchestrator). Committed e22e9a8. |
| 2A | Server thin relay (inputLog, external start/finish, guards, rate-limit, EXTERNAL_GAMES_JSON, catalog(), game:input/game:finish, +tests) | 2 | Opus | apps/realtime/src/lobbies.ts, apps/realtime/src/index.ts, apps/realtime/src/rate-limit.ts (new), apps/realtime/src/external-games.ts (new), apps/realtime/tests/input-relay.test.ts (new), .env.example | PASS | 0 | Verified: recordGameInput/finishExternalGame correct; game:input@225 after saveLobby@224; finish screen-role guarded; catalog() in all 3 payloads; 60 realtime tests. |
| 2B | TV iframe host (GameHostStage, useExternalGameInputs, LobbyRoute wiring, copy-sdk script, web deps) | 2 | Opus | apps/web/src/components/GameHostStage.tsx (new), apps/web/src/hooks/useExternalGameInputs.ts (new), apps/web/src/routes/LobbyRoute.tsx, apps/web/scripts/copy-sdk.mjs (new), apps/web/package.json, .gitignore | PASS | 0 | Verified: guards (identity/shape/8KB/60msg-s), ISO→ms convert, seq-order hook w/ trim fast-forward, trebuchet path untouched, e2e 5/5 (builder-run; re-confirm at gate). Handle: forwardRef {forwardInput}; mode 'test' for /dev. |
| 2C | Generic manifest-driven controller | 2 | Sonnet | apps/web/src/components/GenericController.tsx (new), apps/web/src/routes/ControllerRoute.tsx, apps/web/src/styles.css | PASS | 0 | Verified: exact emit shape; all 4 control types; snapshot guard fixed a latent external-snapshot crash in ControllerRoute; label template resolves "Trebuchet starten". Typecheck flake was 2B in-flight — gate re-run clean. |
| — | W2 GATE (pre-2D) | 2 | — | — | GREEN | — | 176 unit, typecheck 0, build 0, e2e 10/10. Committed 226df54. |
| 2D | Tap-race fixture + e2e thin slice (after 2A-2C) | 2 | Sonnet | apps/web/tests/fixtures/** (new), apps/web/tests/external-game.spec.ts (new), playwright.config.ts | PASS | 0 | Verified 12/12. Found: opaque-origin fetch needs CORS on creator host (→ guide!); instant teardown hid winner screens → orchestrator added 5s GAME-OVER LINGER in LobbyRoute (render-derived, single element position) + winner assert now gating. |
| — | W2 GATE (final) | 2 | — | — | GREEN | — | e2e 12/12 w/ gating winner screen. Committed b536a09. DEMO WORKS: creator-style game plays end-to-end. |
| 3A | Games registry + REST + admin (+tests) | 3 | Opus | apps/realtime/src/persistence.ts, apps/realtime/src/games-registry.ts (new), apps/realtime/src/index.ts, apps/realtime/tests/games-registry.test.ts (new), .env.example | PASS | 0 | Verified: factory precedence correct (disabled on Vercel w/o Redis); timing-safe token+admin; 28 new tests; LIVE REST smoke: full lifecycle green (submit/catalog/admin/takedown/restore/delete). TDZ bug self-fixed in flight (3B caught it). |
| — | W3 GATE | 3 | — | — | GREEN | — | 204 unit, tc 0, build 0, e2e 12/12, REST smoke green. Committed 6401861. |
| 3B | Catalog UI (badges, remote filter, report) + gamesApi + PairRoute remote-mode | 3 | Sonnet | apps/web/src/components/GameCatalog.tsx, apps/web/src/gamesApi.ts (new), apps/web/src/routes/PairRoute.tsx, apps/web/src/api.ts, apps/web/src/routes/{Controller,Lobby}Route.tsx (light: remoteMode prop), apps/web/src/styles.css | PASS | 0 | Verified: diff matches brief; badges/report/remote-block/featured-sort correct; chromium 6/6 by builder. Known wart: nested report button (chip spawned; report is phone-side anyway). Caught 3A's TDZ bug in flight. |
| 4A | /dev submit + test-harness page | 4 | Sonnet | apps/web/src/routes/DevSubmitRoute.tsx (new), apps/web/src/App.tsx, apps/web/src/styles.css | PASS | 0* | Verified: live-browser run (handshake OK, taps round-trip, publish 201+token UI, unpublish); App.tsx wiring minimal; no sockets; 12/12 e2e by builder. Partial from dead 1st attempt was fully correct — kept 100%. |
| 4B | COUCH-GAME-GUIDE.md + starter template | 4 | Opus | packages/game-sdk/COUCH-GAME-GUIDE.md (new, 669 lines), templates/couch-game-starter/** (new), apps/web/scripts/copy-sdk.mjs (guide copy), README.md pointer | PASS | 0* | Verified: orchestrator accuracy audit (rate limits/quick-start/linger/tiers all match source); template validated against real validator; simulator verified headless. Public guide copy gitignored (orchestrator). |
| — | W4 GATE | 4 | — | — | GREEN | — | 204 unit, tc 0, build 0, e2e 12/12. Committed ad86851. |
| 5A | E2E expansion (submit flow, remote 2-TV, dev simulator) | 5 | Sonnet | apps/web/tests/external-game.spec.ts | PASS | 0 | Verified: 18/18 twice, no flake, no project restrictions; fixed latent substring-selector brittleness. |
| — | W5 GATE + LANDED | 5 | — | — | DONE | — | Final gate green (204 unit, 18/18 e2e). PR #9 merged (f029543). PROD VERIFIED: guide+SDK+/dev live; real publish→catalog→delete lifecycle green on couch-gg.vercel.app (Redis registry working). Outstanding: ADMIN_KEY env (user action — secret write blocked by policy). |

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
