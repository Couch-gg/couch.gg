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

export type GameOrigin = 'builtin' | 'external';
export type InputAction = 'press' | 'release' | 'change';

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
    // Widened to string so external (creator-authored) manifests can name their
    // own controls. ControllerControl is kept exported for built-in back-compat.
    control: string;
    type: 'slider' | 'button' | 'hold' | 'select';
    label: string;
    min?: number;
    max?: number;
    step?: number;
    options?: string[];
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
  // Populated in a later wave; optional so existing apps compile unchanged.
  mode?: 'local' | 'remote';
  inputLog?: GameInputEnvelope[];
}

// One relayed controller input for an external game. Ordered by monotonic `seq`
// per lobby; external games are deterministic from `seed` + this ordered log.
export interface GameInputEnvelope {
  seq: number;
  at: string;                 // ISO
  playerId: PlayerId;
  control: string;
  action: InputAction;
  value?: unknown;            // value payload capped ≤1KB by the server
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
  origin?: GameOrigin;         // absent ⇒ builtin
  featured?: boolean;          // admin-curated catalog boost (games registry)
}

// Snapshot kind for external (creator-hosted, iframe-sandboxed) games. The
// platform holds no authoritative state — only the seed and reported scores.
export interface ExternalGameSnapshot {
  kind: 'external';
  seed: string;
  scores?: Array<{ playerId: PlayerId; score: number }>;
}

// A published external game manifest. The server composes this by stamping
// origin/status/publishedAt onto the creator-supplied fields.
export interface ExternalGameManifest extends GameManifest {
  origin: 'external';
  entryUrl: string;
  supportsRemote?: boolean;
  sdkProtocol: 1;
  author?: { name: string; url?: string };
  publishedAt: string;
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
