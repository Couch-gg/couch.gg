import type { GameManifest, GameId } from '@couch/types';

export const TREBUCHET_MANIFEST: GameManifest = {
  id: 'trebuchet',
  title: 'Trebuchet',
  description: 'Turn-based siege artillery for 2-4 couch players. Aim high, read the wind, break the castles.',
  minPlayers: 2,
  maxPlayers: 4,
  controllerLayout: {
    kind: 'trebuchet-aim-fire',
    controls: [
      { control: 'angle', type: 'slider', label: 'Angle', min: 50, max: 130, step: 1 },
      { control: 'power', type: 'slider', label: 'Power', min: 10, max: 100, step: 1 },
      { control: 'fire', type: 'hold', label: 'Fire' }
    ]
  },
  aspectRatio: '16:9',
  estimatedDurationMinutes: 8,
  status: 'internal'
};

export const GAME_MANIFESTS = [TREBUCHET_MANIFEST] satisfies GameManifest[];

export function getGameManifest(id: GameId): GameManifest {
  const manifest = GAME_MANIFESTS.find((game) => game.id === id);
  if (!manifest) {
    throw new Error(`Unknown game: ${id}`);
  }
  return manifest;
}

export function getDefaultGameId(): GameId {
  return 'trebuchet';
}

export function sanitizePlayerName(raw: unknown): string {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 18);
  return name || 'Player';
}

export function createRoomName(slug: string): string {
  return `Couch ${slug.toUpperCase()}`;
}

export function randomSlug(length = 6): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export function createId(prefix: string): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef?.randomUUID) {
    return `${prefix}_${cryptoRef.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}
