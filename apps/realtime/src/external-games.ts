// Ops escape hatch for registering external (iframe-hosted) games before the
// durable registry (a later wave) exists. `EXTERNAL_GAMES_JSON` is a JSON array
// of creator-supplied manifest inputs; each entry is validated with the shared
// dependency-free validator, then stamped with the server-owned fields
// (origin/status/publishedAt) to produce a full ExternalGameManifest. Invalid
// entries are logged and skipped so one bad entry never blocks the rest.
//
// This is also the Wave-2 demo/e2e enabler: a static-hosted fixture game can be
// registered via env and played end-to-end without the registry.

import { GAME_MANIFESTS, validateExternalManifestInput } from '@couch/game-runtime';
import type { ExternalGameManifest, GameManifest } from '@couch/types';

export interface ParseExternalGamesOptions {
  // When false (e.g. on Vercel, where process.env.VERCEL is set) http localhost
  // entryUrls are rejected. In local dev they are allowed for the fixture server.
  allowHttpLocalhost?: boolean;
  // Injectable so tests can assert deterministic publishedAt / silence logging.
  now?: () => string;
  onWarn?: (message: string) => void;
}

// Parse and validate the EXTERNAL_GAMES_JSON env value into published external
// manifests. Never throws: malformed JSON yields an empty list (logged), and
// individual invalid entries are skipped (logged).
export function parseExternalGamesJson(
  raw: string | undefined | null,
  opts: ParseExternalGamesOptions = {}
): ExternalGameManifest[] {
  const allowHttpLocalhost = opts.allowHttpLocalhost === true;
  const nowIso = opts.now ?? (() => new Date().toISOString());
  const warn = opts.onWarn ?? ((message: string) => console.warn(message));

  const trimmed = (raw ?? '').trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    warn(`EXTERNAL_GAMES_JSON is not valid JSON, ignoring: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  if (!Array.isArray(parsed)) {
    warn('EXTERNAL_GAMES_JSON must be a JSON array of manifest objects, ignoring');
    return [];
  }

  const publishedAt = nowIso();
  const out: ExternalGameManifest[] = [];
  const seenIds = new Set<string>();

  parsed.forEach((entry, i) => {
    const result = validateExternalManifestInput(entry, { allowHttpLocalhost });
    if (!result.ok) {
      warn(`EXTERNAL_GAMES_JSON entry ${i} is invalid, skipping: ${result.errors.join('; ')}`);
      return;
    }
    if (seenIds.has(result.value.id)) {
      warn(`EXTERNAL_GAMES_JSON entry ${i} duplicates id "${result.value.id}", skipping`);
      return;
    }
    seenIds.add(result.value.id);

    const manifest: ExternalGameManifest = {
      ...result.value,
      origin: 'external',
      status: 'published',
      publishedAt
    };
    out.push(manifest);
  });

  return out;
}

// Merge the built-in manifests with the env-registered external ones. Built-ins
// always win an id collision (the validator already blocks reserved built-in
// ids, so this is only belt-and-suspenders).
export function mergeCatalog(externals: ExternalGameManifest[]): GameManifest[] {
  const builtinIds = new Set(GAME_MANIFESTS.map((game) => game.id));
  const extra = externals.filter((game) => !builtinIds.has(game.id));
  return [...GAME_MANIFESTS, ...extra];
}
