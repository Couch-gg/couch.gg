import type { GameManifest } from '@couch/types';
import { REALTIME_API_PREFIX, REALTIME_URL } from './api.js';

export async function submitGame(
  manifest: unknown,
  attestation?: { handshakeOk: boolean }
): Promise<{ game: GameManifest; managementToken: string }> {
  const response = await fetch(`${REALTIME_URL}${REALTIME_API_PREFIX}/games`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest, attestation })
  });
  if (!response.ok) throw new Error(await errorMessage(response, 'Spiel konnte nicht eingereicht werden'));
  return (await response.json()) as { game: GameManifest; managementToken: string };
}

export async function updateGame(id: string, managementToken: string, manifest: unknown): Promise<GameManifest> {
  const response = await fetch(`${REALTIME_URL}${REALTIME_API_PREFIX}/games/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-management-token': managementToken },
    body: JSON.stringify({ manifest })
  });
  if (!response.ok) throw new Error(await errorMessage(response, 'Spiel konnte nicht aktualisiert werden'));
  const body = (await response.json()) as { game: GameManifest };
  return body.game;
}

export async function deleteGame(id: string, managementToken: string): Promise<void> {
  const response = await fetch(`${REALTIME_URL}${REALTIME_API_PREFIX}/games/${id}`, {
    method: 'DELETE',
    headers: { 'x-management-token': managementToken }
  });
  if (!response.ok) throw new Error(await errorMessage(response, 'Spiel konnte nicht gelöscht werden'));
}

export async function reportGame(id: string): Promise<{ ok: boolean; hidden: boolean }> {
  const response = await fetch(`${REALTIME_URL}${REALTIME_API_PREFIX}/games/${id}/report`, { method: 'POST' });
  if (!response.ok) throw new Error(await errorMessage(response, 'Meldung konnte nicht gesendet werden'));
  return (await response.json()) as { ok: boolean; hidden: boolean };
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    return body.error || body.message || fallback;
  } catch {
    return fallback;
  }
}
