// Copies the built @couch/game-sdk IIFE bundle into apps/web/public so the host
// can serve it at a stable, hot-linkable URL (/sdk/v1/couch-sdk.js) for creators.
//
// The runtime SDK is NOT bundled into the host app — the host only imports the
// protocol *types*. Creators <script src="…/sdk/v1/couch-sdk.js"> the IIFE build,
// which exposes the `CouchSDK` global. This script runs before `dev`/`build`
// (wired in package.json) so the file is always fresh.
//
// It also copies the built Trebuchet sim (@couch/trebuchet dist/sim.js and
// dist/constants.js) to public/shared/. The original Phaser scenes under
// public/js/ import them from /shared/ in the browser; generating them here keeps
// the TV on the same code the server runs instead of a hand-kept copy.
//
// Paths are resolved relative to THIS script's location, not the cwd, so it works
// regardless of where pnpm invokes it from.

import { mkdir, copyFile, access, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
// scripts/ -> apps/web -> apps -> <repo root>
const repoRoot = resolve(scriptDir, '..', '..', '..');

const source = resolve(repoRoot, 'packages', 'game-sdk', 'dist', 'couch-sdk.iife.js');
const destDir = resolve(scriptDir, '..', 'public', 'sdk', 'v1');
const dest = resolve(destDir, 'couch-sdk.js');

// The creator-facing guide lives next to the SDK source and is served at a
// stable public URL (/COUCH-GAME-GUIDE.md) so creators can hot-link it into
// their coding agent. It is copied to public/ root — NOT public/sdk/ — because
// public/sdk/ is gitignored while the guide copy is a plain public asset.
const guideSource = resolve(repoRoot, 'packages', 'game-sdk', 'COUCH-GAME-GUIDE.md');
const publicDir = resolve(scriptDir, '..', 'public');
const guideDest = resolve(publicDir, 'COUCH-GAME-GUIDE.md');

// tsc emits browser-ready ESM (sim.js imports './constants.js'). public/shared/
// is gitignored; the source of truth is packages/games/trebuchet/src.
const trebuchetDist = resolve(repoRoot, 'packages', 'games', 'trebuchet', 'dist');
const sharedDir = resolve(publicDir, 'shared');
const SHARED_MODULES = ['constants.js', 'sim.js'];

async function main() {
  try {
    await access(source);
  } catch {
    console.error(
      `[copy-sdk] Source SDK bundle not found:\n  ${source}\n` +
        `Run \`pnpm build:packages\` first to build @couch/game-sdk.`
    );
    process.exit(1);
  }

  await mkdir(destDir, { recursive: true });
  await copyFile(source, dest);
  console.log(`[copy-sdk] Copied SDK bundle -> ${dest}`);

  try {
    await access(guideSource);
  } catch {
    console.error(
      `[copy-sdk] Creator guide not found:\n  ${guideSource}\n` +
        `Expected packages/game-sdk/COUCH-GAME-GUIDE.md to exist.`
    );
    process.exit(1);
  }

  await mkdir(publicDir, { recursive: true });
  await copyFile(guideSource, guideDest);
  console.log(`[copy-sdk] Copied creator guide -> ${guideDest}`);

  await mkdir(sharedDir, { recursive: true });
  for (const file of SHARED_MODULES) {
    const from = resolve(trebuchetDist, file);
    try {
      await access(from);
    } catch {
      console.error(
        `[copy-sdk] Built Trebuchet module not found:\n  ${from}\n` +
          `Run \`pnpm build:packages\` first to build @couch/trebuchet.`
      );
      process.exit(1);
    }
    // Drop the sourceMappingURL comment: the map points at ../src/*.ts, which
    // the web server does not serve.
    const code = (await readFile(from, 'utf-8')).replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
    const banner = `// GENERATED from packages/games/trebuchet/src/${file.replace(/\.js$/, '.ts')} by apps/web/scripts/copy-sdk.mjs. Do not edit.\n`;
    await writeFile(resolve(sharedDir, file), banner + code, 'utf-8');
  }
  console.log(`[copy-sdk] Copied Trebuchet sim -> ${sharedDir}`);
}

main().catch((err) => {
  console.error('[copy-sdk] Unexpected failure:', err);
  process.exit(1);
});
