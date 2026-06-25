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
      { control: 'trebuchet.aim', type: 'button', label: 'Aim' },
      { control: 'trebuchet.charge', type: 'hold', label: 'Charge' },
      { control: 'trebuchet.fire', type: 'button', label: 'Fire' }
    ]
  },
  aspectRatio: '16:9',
  estimatedDurationMinutes: 8,
  status: 'internal',
  thumbnail: {
    kind: 'css',
    gradient: 'linear-gradient(160deg, #2a1b3d 0%, #5a2c42 60%, #e8554d 135%)',
    icon: 'Castle',
    accent: '#f1cf6a'
  }
};

export const TANK_DUEL_MANIFEST: GameManifest = {
  id: 'tank-duel',
  title: 'Tank Duel',
  description: 'Lob shells across a destructible battlefield and out-aim your rivals in a 2-4 player artillery showdown.',
  minPlayers: 2,
  maxPlayers: 4,
  controllerLayout: {
    kind: 'generic-buttons',
    controls: []
  },
  aspectRatio: '16:9',
  estimatedDurationMinutes: 6,
  status: 'internal',
  comingSoon: true,
  thumbnail: {
    kind: 'css',
    gradient: 'linear-gradient(160deg, #0f2a2e 0%, #14524f 70%, #62d5d5 140%)',
    icon: 'Crosshair',
    accent: '#62d5d5'
  }
};

export const QUIZ_RUSH_MANIFEST: GameManifest = {
  id: 'quiz-rush',
  title: 'Quiz Rush',
  description: 'Race the buzzer in a fast trivia sprint for 2-8 players. Be quick, be right, take the lead.',
  minPlayers: 2,
  maxPlayers: 8,
  controllerLayout: {
    kind: 'generic-buttons',
    controls: []
  },
  aspectRatio: '16:9',
  estimatedDurationMinutes: 10,
  status: 'internal',
  comingSoon: true,
  thumbnail: {
    kind: 'css',
    gradient: 'linear-gradient(160deg, #241640 0%, #4a2d7a 70%, #d47cff 140%)',
    icon: 'Brain',
    accent: '#d47cff'
  }
};

export const KART_CHAOS_MANIFEST: GameManifest = {
  id: 'kart-chaos',
  title: 'Kart Chaos',
  description: 'Drift, bump, and boost through chaotic circuits in a 2-4 player couch kart scramble.',
  minPlayers: 2,
  maxPlayers: 4,
  controllerLayout: {
    kind: 'generic-buttons',
    controls: []
  },
  aspectRatio: '16:9',
  estimatedDurationMinutes: 5,
  status: 'internal',
  comingSoon: true,
  thumbnail: {
    kind: 'css',
    gradient: 'linear-gradient(160deg, #3a1f10 0%, #8a4a1f 70%, #ff935c 140%)',
    icon: 'Car',
    accent: '#ff935c'
  }
};

export const GAME_MANIFESTS = [
  TREBUCHET_MANIFEST,
  TANK_DUEL_MANIFEST,
  QUIZ_RUSH_MANIFEST,
  KART_CHAOS_MANIFEST
] satisfies GameManifest[];

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

export function isPlayableGame(id: GameId): boolean {
  const manifest = GAME_MANIFESTS.find((game) => game.id === id);
  return Boolean(manifest) && !manifest!.comingSoon;
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
