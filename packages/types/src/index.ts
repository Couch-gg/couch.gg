export type PlayerId = string;
export type LobbyId = string;
export type LobbySlug = string;
export type PlayerToken = string;
export type DeviceId = string;
export type GameId = string;
export type ScreenId = string;

export type LobbyState = 'waiting' | 'playing' | 'ended';
export type GameSessionState = 'ready' | 'running' | 'finished';
export type DeviceRole = 'screen' | 'controller';

export type ControllerControl =
  | 'angle'
  | 'power'
  | 'fire'
  | 'trebuchet.aim'
  | 'trebuchet.charge'
  | 'trebuchet.fire'
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
  chat: ChatMessage[];
  gameSession: GameSession | null;
  lastEvent: GameEventEnvelope | null;
}

export interface GameEventEnvelope {
  seq: number;       // monotonic per lobby; clients replay only seq > last-seen
  at: string;        // ISO
  event: unknown;    // the TrebuchetEvent (client casts)
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

export interface GameThumbnail {
  kind: 'css';
  gradient: string;
  icon: string;
  accent?: string;
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
  thumbnail: GameThumbnail;
  comingSoon?: boolean;
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

export interface ChatMessage {
  id: string;
  at: string;                  // ISO timestamp
  playerId: PlayerId | null;   // null = system message
  name: string;                // denormalized sender display name
  colorIdx: number;            // sender color index, for bubble tint
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

export interface RenamePlayerResponse {
  lobby: Lobby;
  player: Player;
}

export interface PublicConfig {
  realtimeUrl: string;
}

export interface ScreenRecordPublic {
  id: ScreenId;
  expiresAt: string;               // ISO
  claimedSlug: LobbySlug | null;
}

export interface RegisterScreenResponse {
  screen: ScreenRecordPublic;
}

export interface ScreenStatusResponse {
  screen: ScreenRecordPublic & { expired: boolean };
}

export interface ClaimScreenResponse {
  screen: ScreenRecordPublic;
}

export interface PostChatResponse {
  message: ChatMessage;
}
