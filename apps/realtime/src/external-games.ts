// Ops escape hatch for registering external (iframe-hosted) games before the
// durable registry (a later wave) exists. `EXTERNAL_GAMES_JSON` is a JSON array
// of creator-supplied manifest inputs; each entry is validated with the shared
// dependency-free validator, then stamped with the server-owned fields
// (origin/status/publishedAt) to produce a full ExternalGameManifest. Invalid
// entries are logged and skipped so one bad entry never blocks the rest.
//
// This is also the Wave-2 demo/e2e enabler: a static-hosted fixture game can be
// registered via env and played end-to-end without the registry.
//
// Thumbnail values the catalog may not render (an unknown icon, a gradient with
// url()) were accepted before the thumbnail rules existed, so an entry that only
// breaks those is cleaned up (logged) instead of disappearing from the catalog.

import { GAME_MANIFESTS, sanitizeThumbnail, validateExternalManifestInput } from '@couch/game-runtime';
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
    const result = validateExternalManifestInput(withSafeThumbnail(entry, i, warn), { allowHttpLocalhost });
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

// The entry with its thumbnail values swapped for ones the catalog renders
// (see sanitizeThumbnail). Anything that isn't a thumbnail object is left for
// the validator to reject as before.
function withSafeThumbnail(entry: unknown, i: number, warn: (message: string) => void): unknown {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry;
  const thumbnail = (entry as { thumbnail?: unknown }).thumbnail;
  if (typeof thumbnail !== 'object' || thumbnail === null || Array.isArray(thumbnail)) return entry;
  const raw = thumbnail as Record<string, unknown>;
  const safe = sanitizeThumbnail(raw);
  const changed = (['icon', 'gradient', 'accent'] as const).filter((field) => {
    const value = raw[field];
    return value !== undefined && (typeof value === 'string' ? value.trim() : value) !== safe[field];
  });
  if (changed.length === 0) return entry;
  warn(`EXTERNAL_GAMES_JSON entry ${i}: thumbnail ${changed.join(', ')} not allowed, using the fallback`);
  return { ...entry, thumbnail: { ...safe, kind: raw.kind } };
}

// Merge the built-in manifests with the env-registered external ones. Built-ins
// always win an id collision (the validator already blocks reserved built-in
// ids, so this is only belt-and-suspenders).
export function mergeCatalog(externals: ExternalGameManifest[]): GameManifest[] {
  const builtinIds = new Set(GAME_MANIFESTS.map((game) => game.id));
  const extra = externals.filter((game) => !builtinIds.has(game.id));
  return [...GAME_MANIFESTS, ...extra];
}
