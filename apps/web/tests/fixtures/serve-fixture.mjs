// Tiny zero-dependency static server for the external-game e2e fixtures.
//
// Serves apps/web/tests/fixtures/ (the "tap-race" fixture game + manifest) on
// http://127.0.0.1:4180, plus a special route that serves the built
// @couch/game-sdk IIFE bundle at /tap-race/couch-sdk.js by reading it straight
// off disk from packages/game-sdk/dist — mirroring copy-sdk.mjs's approach
// (paths resolved relative to THIS script, not the cwd; clear error if the
// SDK hasn't been built yet).
//
// This is the Wave-2D e2e enabler referenced by apps/realtime/src/external-games.ts.

import { createServer } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
// apps/web/tests/fixtures/serve-fixture.mjs -> apps/web/tests/fixtures -> ... -> <repo root>
const repoRoot = resolve(scriptDir, '..', '..', '..', '..');

const fixturesRoot = scriptDir;
const sdkSource = resolve(repoRoot, 'packages', 'game-sdk', 'dist', 'couch-sdk.iife.js');

const PORT = Number(process.env.FIXTURE_PORT) || 4180;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

async function readSdkBundle() {
  try {
    await access(sdkSource);
  } catch {
    throw new Error(
      `[serve-fixture] SDK bundle not found:\n  ${sdkSource}\n` +
        `Run \`pnpm build:packages\` first to build @couch/game-sdk.`
    );
  }
  return readFile(sdkSource);
}

function send(res, status, body, contentType) {
  res.writeHead(status, {
    'Content-Type': contentType ?? 'text/plain; charset=utf-8',
    // The fixture game runs in a sandboxed iframe with `allow-scripts` only (no
    // `allow-same-origin`, per GameHostStage), so its fetches carry an opaque
    // `Origin: null`. Without a wildcard CORS header, the browser blocks the
    // game's own `fetch('./couch.game.json')` — this bit us in manual testing.
    // No secrets are ever served here, so `*` is safe.
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    const pathname = decodeURIComponent(url.pathname);

    // Special route: serve the built SDK IIFE bundle read live from disk.
    if (pathname === '/tap-race/couch-sdk.js') {
      const body = await readSdkBundle();
      send(res, 200, body, CONTENT_TYPES['.js']);
      return;
    }

    // Static file serving, constrained to fixturesRoot to prevent path escape.
    const relative = pathname === '/' ? '/index.html' : pathname;
    const filePath = normalize(join(fixturesRoot, relative));
    if (!filePath.startsWith(fixturesRoot)) {
      send(res, 403, 'Forbidden');
      return;
    }

    const ext = extname(filePath);
    const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
    const body = await readFile(filePath);
    send(res, 200, body, contentType);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      send(res, 404, 'Not found');
      return;
    }
    console.error('[serve-fixture] request failed:', err);
    send(res, 500, err instanceof Error ? err.message : String(err));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[serve-fixture] ready on http://127.0.0.1:${PORT}`);
});
