// Cross-platform build driver: runs the ESM vite build, then the IIFE vite build
// (with COUCH_SDK_FORMAT=iife), then emits type declarations via tsc. Using a
// Node script avoids shell-specific env-var syntax differences (Windows vs POSIX)
// and keeps zero extra dependencies (no cross-env).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Run a command, inheriting stdio; exit the whole build on first failure. */
function run(cmd, args, extraEnv = {}) {
  const result = spawnSync(cmd, args, {
    cwd: pkgDir,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...extraEnv }
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// 1) ESM bundle (clears dist).
run('vite', ['build']);
// 2) IIFE bundle (keeps ESM output; exposes clean global CouchSDK).
run('vite', ['build'], { COUCH_SDK_FORMAT: 'iife' });
// 3) Type declarations into dist/types.
run('tsc', ['-p', 'tsconfig.json', '--emitDeclarationOnly']);
