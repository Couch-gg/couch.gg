export type PlayerId = string;
export type LobbyId = string;
export type LobbySlug = string;
export type PlayerToken = string;
export type DeviceId = string;
export type GameId = 'trebuchet';

export type LobbyState = 'waiting' | 'playing' | 'ended';
export type GameSessionState = 'ready' | 'running' | 'finished';
export type DeviceRole = 'screen' | 'controller';

export type ControllerControl =
  | 'angle'
  | 'power'
  | 'fire'
  | 'start'
  | 'rematch'
  | 'select-game';

export type ControllerLayoutKind = 'trebuchet-aim-fire' | 'generic-buttons';

export interface ControllerLayout {
  kind: ControllerLayoutKind;
  controls: Array<{
    control: ControllerControl;
    type: 'slider' | 'button' | 'hold' | 'select';
    label: string;
    min?: number;
    max?: number;
    step?: number;
  }>;
}

export interface Player {
  id: PlayerId;
  name: string;
  joinedAt: string;
  isHost: boolean;
  connected: boolean;
  colorIdx: number;
}

export interface Lobby {
  id: LobbyId;
  slug: LobbySlug;
  name: string;
  hostPlayerId: PlayerId | null;
  createdAt: string;
  expiresAt: string;
  currentGameId: GameId | null;
  state: LobbyState;
  players: Player[];
  activity: ActivityMessage[];
  gameSession: GameSession | null;
}

export interface GameSession<TSnapshot = unknown> {
  id: string;
  lobbyId: LobbyId;
  gameId: GameId;
  state: GameSessionState;
  startedAt: string | null;
  endedAt: string | null;
  snapshot: TSnapshot;
}

export interface GameManifest {
  id: GameId;
  title: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  controllerLayout: ControllerLayout;
  aspectRatio: '16:9' | '4:3';
  estimatedDurationMinutes: number;
  status: 'internal' | 'submitted' | 'published';
}

export interface ControllerEvent<TValue = unknown> {
  playerId: PlayerId;
  type: 'button' | 'axis' | 'text' | 'gesture' | 'game';
  control: ControllerControl | string;
  value: TValue;
  timestamp: number;
}

export interface ActivityMessage {
  id: string;
  at: string;
  text: string;
}

export interface CreateLobbyResponse {
  lobby: Lobby;
}

export interface JoinLobbyResponse {
  lobby: Lobby;
  player: Player;
  playerToken: PlayerToken;
}

export interface PublicConfig {
  realtimeUrl: string;
}
