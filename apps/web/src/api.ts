import type { ChatMessage, ClaimScreenResponse, CreateLobbyResponse, GameManifest, JoinLobbyResponse, Lobby, PostChatResponse, RegisterScreenResponse, ScreenRecordPublic, ScreenStatusResponse } from '@couch/types';

const isBrowser = typeof window !== 'undefined';
const isLocalDevHost =
  isBrowser &&
  ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname);

const fallbackRealtimeUrl = !isBrowser
  ? 'http://localhost:4100'
  : isLocalDevHost
    ? `${window.location.protocol}//${window.location.hostname}:4100`
    : window.location.origin;

export const REALTIME_URL = import.meta.env.VITE_REALTIME_URL || fallbackRealtimeUrl;
export const REALTIME_API_PREFIX = import.meta.env.VITE_REALTIME_API_PREFIX || (isLocalDevHost ? '/api' : '/api/realtime');
export const REALTIME_SOCKET_PATH = import.meta.env.VITE_REALTIME_SOCKET_PATH || (isLocalDevHost ? '/socket.io' : '/api/realtime/socket.io');

export async function createLobby(): Promise<Lobby> {
  const response = await fetch(`${REALTIME_URL}${REALTIME_API_PREFIX}/lobbies`, { method: 'POST' });
  if (!response.ok) throw new Error('Lobby konnte nicht erstellt werden');
  const body = (await response.json()) as CreateLobbyResponse;
  return body.lobby;
}

export async function fetchLobby(slug: string): Promise<Lobby> {
  const response = await fetch(`${REALTIME_URL}${REALTIME_API_PREFIX}/lobbies/${slug}`);
  if (!response.ok) throw new Error('Lobby nicht gefunden');
  const body = (await response.json()) as { lobby: Lobby };
  return body.lobby;
}

export async function fetchGames(): Promise<GameManifest[]> {
  const response = await fetch(`${REALTIME_URL}${REALTIME_API_PREFIX}/games`);
  if (!response.ok) throw new Error('Spiele konnten nicht geladen werden');
  const body = (await response.json()) as { games: GameManifest[] };
  return body.games;
}

export type { JoinLobbyResponse };

export async function registerScreen(): Promise<ScreenRecordPublic> {
  const response = await fetch(`${REALTIME_URL}${REALTIME_API_PREFIX}/screens`, { method: 'POST' });
  if (!response.ok) throw new Error('Screen konnte nicht registriert werden');
  const body = (await response.json()) as RegisterScreenResponse;
  return body.screen;
}

export async function fetchScreen(id: string): Promise<ScreenRecordPublic & { expired: boolean }> {
  const response = await fetch(`${REALTIME_URL}${REALTIME_API_PREFIX}/screens/${id}`);
  if (!response.ok) throw new Error('Screen nicht gefunden');
  const body = (await response.json()) as ScreenStatusResponse;
  return body.screen;
}

export async function claimScreen(id: string, slug: string): Promise<ScreenRecordPublic> {
  const response = await fetch(`${REALTIME_URL}${REALTIME_API_PREFIX}/screens/${id}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug })
  });
  if (!response.ok) throw new Error('Screen konnte nicht verbunden werden');
  const body = (await response.json()) as ClaimScreenResponse;
  return body.screen;
}

export async function sendChat(slug: string, playerToken: string, text: string): Promise<ChatMessage> {
  const response = await fetch(`${REALTIME_URL}${REALTIME_API_PREFIX}/lobbies/${slug}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerToken, text })
  });
  if (!response.ok) throw new Error('Nachricht konnte nicht gesendet werden');
  const body = (await response.json()) as PostChatResponse;
  return body.message;
}
