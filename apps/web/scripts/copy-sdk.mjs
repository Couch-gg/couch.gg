// Copies the built @couch/game-sdk IIFE bundle into apps/web/public so the host
// can serve it at a stable, hot-linkable URL (/sdk/v1/couch-sdk.js) for creators.
//
// The runtime SDK is NOT bundled into the host app — the host only imports the
// protocol *types*. Creators <script src="…/sdk/v1/couch-sdk.js"> the IIFE build,
// which exposes the `CouchSDK` global. This script runs before `dev`/`build`
// (wired in package.json) so the file is always fresh.
//
// Paths are resolved relative to THIS script's location, not the cwd, so it works
// regardless of where pnpm invokes it from.

import { mkdir, copyFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
// scripts/ -> apps/web -> apps -> <repo root>
const repoRoot = resolve(scriptDir, '..', '..', '..');

const source = resolve(repoRoot, 'packages', 'game-sdk', 'dist', 'couch-sdk.iife.js');
const destDir = resolve(scriptDir, '..', 'public', 'sdk', 'v1');
const dest = resolve(destDir, 'couch-sdk.js');

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
}

main().catch((err) => {
  console.error('[copy-sdk] Unexpected failure:', err);
  process.exit(1);
});
