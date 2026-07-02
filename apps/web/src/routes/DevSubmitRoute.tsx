import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  ExternalGameManifest,
  ExternalGameSnapshot,
  GameInputEnvelope,
  InputAction,
  Lobby,
  Player
} from '@couch/types';
import { validateExternalManifestInput, type ExternalManifestInput } from '@couch/game-runtime';
import { GameHostStage, type GameHostStageHandle, type GameHostEvent } from '../components/GameHostStage.js';
import { GenericController } from '../components/GenericController.js';
import { deleteGame, submitGame, updateGame } from '../gamesApi.js';

// Minimal creator surface: validate a manifest, test it against the REAL
// platform components (GameHostStage + GenericController — no mocks), then
// publish/manage it. Pure REST + local composition: no socket import, no
// screen registration (the brief's explicit boundary for this route).

const EXAMPLE_MANIFEST = `// Paste your manifest JSON below (comments are stripped before parsing).
// This is a valid example, shaped like the tap-race fixture — replace
// entryUrl with your own hosted game and edit the rest to match.
{
  "id": "my-game",
  "title": "My Game",
  "description": "A short description of what makes this game fun.",
  "minPlayers": 1,
  "maxPlayers": 8,
  "controllerLayout": {
    "kind": "generic-buttons",
    "controls": [
      { "control": "tap", "type": "button", "label": "TAP!" }
    ]
  },
  "aspectRatio": "16:9",
  "estimatedDurationMinutes": 2,
  "thumbnail": {
    "kind": "css",
    "gradient": "linear-gradient(160deg,#12324d,#2d8fbe)",
    "icon": "zap"
  },
  "entryUrl": "https://your-host.example.com/index.html",
  "sdkProtocol": 1,
  "supportsRemote": true
}`;

const FAKE_PLAYERS: Array<{ id: string; name: string; colorIdx: number }> = [
  { id: 'dev-alex', name: 'Alex', colorIdx: 0 },
  { id: 'dev-bea', name: 'Bea', colorIdx: 1 }
];

/** Strip `//` line comments so the prefilled placeholder can carry guidance. */
function stripLineComments(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

function buildFakeLobby(manifest: ExternalGameManifest): Lobby {
  const now = new Date().toISOString();
  const players: Player[] = FAKE_PLAYERS.map((p) => ({
    id: p.id,
    name: p.name,
    joinedAt: now,
    isHost: p.id === FAKE_PLAYERS[0].id,
    connected: true,
    colorIdx: p.colorIdx
  }));
  const snapshot: ExternalGameSnapshot = { kind: 'external', seed: 'dev-seed' };
  return {
    id: 'dev-lobby',
    slug: 'DEV',
    name: 'Dev Test Lobby',
    hostPlayerId: players[0]?.id ?? null,
    createdAt: now,
    expiresAt: now,
    currentGameId: manifest.id,
    state: 'playing',
    players,
    activity: [],
    chat: [],
    gameSession: {
      id: 'dev-session',
      lobbyId: 'dev-lobby',
      gameId: manifest.id,
      state: 'running',
      startedAt: now,
      endedAt: null,
      snapshot
    },
    lastEvent: null,
    mode: 'local'
  };
}

type ManifestValidation =
  | { status: 'empty' }
  | { status: 'parse-error'; message: string }
  | { status: 'invalid'; errors: string[] }
  | { status: 'valid'; value: ExternalManifestInput };

type HandshakeStatus = 'idle' | 'waiting' | 'ready' | 'error';

export function DevSubmitRoute({ navigate }: { navigate: (to: string) => void }) {
  const [manifestText, setManifestText] = useState(EXAMPLE_MANIFEST);
  const [testing, setTesting] = useState(false);
  const [handshake, setHandshake] = useState<HandshakeStatus>('idle');
  const [handshakeError, setHandshakeError] = useState<string | null>(null);
  const [gameOverScores, setGameOverScores] = useState<Array<{ playerId: string; score: number }> | null>(null);

  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [published, setPublished] = useState<{ id: string; managementToken: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const [manageOpen, setManageOpen] = useState(false);
  const [manageId, setManageId] = useState('');
  const [manageToken, setManageToken] = useState('');
  const [manageBusy, setManageBusy] = useState(false);
  const [manageResult, setManageResult] = useState<string | null>(null);

  const stageRef = useRef<GameHostStageHandle | null>(null);
  const seqRef = useRef(0);

  const allowHttpLocalhost =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  const validation = useMemo<ManifestValidation>(() => {
    const trimmed = manifestText.trim();
    if (!trimmed) return { status: 'empty' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripLineComments(manifestText));
    } catch (err) {
      return { status: 'parse-error', message: err instanceof Error ? err.message : 'Invalid JSON' };
    }
    const result = validateExternalManifestInput(parsed, { allowHttpLocalhost });
    if (!result.ok) return { status: 'invalid', errors: result.errors };
    return { status: 'valid', value: result.value };
  }, [manifestText, allowHttpLocalhost]);

  const isValid = validation.status === 'valid';

  // The full ExternalGameManifest the test harness / publish step needs —
  // stamps the fields the server would stamp on publish (origin/status/
  // publishedAt) so the REAL GameHostStage/GenericController can render it
  // exactly as they would in production.
  const testManifest: ExternalGameManifest | null = useMemo(() => {
    if (validation.status !== 'valid') return null;
    const now = new Date().toISOString();
    return {
      ...validation.value,
      status: 'submitted',
      origin: 'external',
      publishedAt: now
    };
  }, [validation]);

  const fakeLobby = useMemo(() => (testManifest ? buildFakeLobby(testManifest) : null), [testManifest]);

  const startTest = () => {
    if (!isValid) return;
    seqRef.current = 0;
    setHandshake('waiting');
    setHandshakeError(null);
    setGameOverScores(null);
    setTesting(true);
  };

  const stopTest = () => {
    setTesting(false);
    setHandshake('idle');
    setHandshakeError(null);
    setGameOverScores(null);
  };

  const onStageEvent = useCallback((event: GameHostEvent) => {
    if (event.kind === 'ready') {
      setHandshake('ready');
    } else if (event.kind === 'error') {
      setHandshake('error');
      setHandshakeError(typeof event.detail === 'string' ? event.detail : 'Game reported an error');
    } else if (event.kind === 'gameOver') {
      const detail = event.detail as { scores?: Array<{ playerId: string; score: number }> } | undefined;
      setGameOverScores(detail?.scores ?? []);
    }
  }, []);

  const sendFakeInput = useCallback((playerId: string, control: string, action: InputAction, data?: unknown) => {
    seqRef.current += 1;
    const envelope: GameInputEnvelope = {
      seq: seqRef.current,
      at: new Date().toISOString(),
      playerId,
      control,
      action,
      value: data
    };
    stageRef.current?.forwardInput(envelope);
  }, []);

  const publish = async () => {
    if (validation.status !== 'valid') return;
    setPublishing(true);
    setPublishError(null);
    try {
      const result = await submitGame(validation.value, { handshakeOk: handshake === 'ready' });
      setPublished({ id: result.game.id, managementToken: result.managementToken });
      setManageId(result.game.id);
      setManageToken(result.managementToken);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : 'Publish failed');
    } finally {
      setPublishing(false);
    }
  };

  const copyToken = async () => {
    if (!published) return;
    try {
      await navigator.clipboard?.writeText(published.managementToken);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable; the token is still selectable text.
    }
  };

  const manageUpdate = async () => {
    setManageBusy(true);
    setManageResult(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripLineComments(manifestText));
      } catch (err) {
        throw new Error(err instanceof Error ? `Manifest is not valid JSON: ${err.message}` : 'Manifest is not valid JSON');
      }
      const game = await updateGame(manageId.trim(), manageToken.trim(), parsed);
      setManageResult(`Updated "${game.title}" (${game.id}).`);
    } catch (err) {
      setManageResult(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setManageBusy(false);
    }
  };

  const manageDelete = async () => {
    setManageBusy(true);
    setManageResult(null);
    try {
      await deleteGame(manageId.trim(), manageToken.trim());
      setManageResult('Unpublished. The game no longer appears in the catalog.');
    } catch (err) {
      setManageResult(err instanceof Error ? err.message : 'Unpublish failed');
    } finally {
      setManageBusy(false);
    }
  };

  const handshakeLine =
    handshake === 'waiting'
      ? 'Waiting for handshake…'
      : handshake === 'ready'
        ? '✓ Game ready (handshake OK)'
        : handshake === 'error'
          ? `Handshake error: ${handshakeError ?? 'unknown'}`
          : null;

  return (
    <main className="dev-shell">
      <header className="dev-header">
        <div className="brand-row small">
          <span className="brand-mark">c</span>
          <span>couch.gg</span>
        </div>
        <h1 className="dev-title">Publish a game</h1>
        <p className="dev-sub">
          Validate your manifest, test it against the real platform, then publish it to every couch's catalog.
        </p>
      </header>

      <section className="dev-section">
        <h2 className="dev-section-title">1. Manifest</h2>
        <textarea
          className="dev-textarea"
          value={manifestText}
          onChange={(e) => setManifestText(e.target.value)}
          spellCheck={false}
          rows={20}
          aria-label="Game manifest JSON"
        />
        {validation.status === 'empty' && <p className="dev-hint">Paste a manifest to get started.</p>}
        {validation.status === 'parse-error' && <p className="error-line">JSON parse error: {validation.message}</p>}
        {validation.status === 'invalid' && (
          <ul className="dev-error-list">
            {validation.errors.map((err) => (
              <li key={err}>{err}</li>
            ))}
          </ul>
        )}
        {validation.status === 'valid' && <p className="dev-valid-line">Manifest valid</p>}
      </section>

      <section className="dev-section">
        <h2 className="dev-section-title">2. Test harness</h2>
        <div className="dev-actions">
          <button className="primary-btn" onClick={startTest} disabled={!isValid || testing}>
            Test game
          </button>
          {testing && (
            <button className="ghost-btn" onClick={stopTest}>
              Stop
            </button>
          )}
        </div>

        {testing && testManifest && fakeLobby && (
          <div className="dev-test-harness">
            <div className="dev-test-stage">
              <GameHostStage
                ref={stageRef}
                manifest={testManifest}
                lobby={fakeLobby}
                mode="test"
                onEvent={onStageEvent}
              />
            </div>
            <div className="dev-test-controllers">
              {FAKE_PLAYERS.map((p) => (
                <div className="dev-fake-phone" key={p.id}>
                  <div className="dev-fake-phone-label">{p.name}</div>
                  <GenericController
                    layout={testManifest.controllerLayout}
                    enabled
                    onEvent={(control, action, data) => sendFakeInput(p.id, control, action, data)}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {testing && handshakeLine && (
          <p className={handshake === 'error' ? 'error-line' : handshake === 'ready' ? 'dev-valid-line' : 'dev-hint'}>
            {handshakeLine}
          </p>
        )}
        {testing && gameOverScores && (
          <div className="dev-scores">
            <strong>Game over — reported scores:</strong>
            <ul>
              {gameOverScores.map((s) => (
                <li key={s.playerId}>
                  {s.playerId}: {s.score}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="dev-section">
        <h2 className="dev-section-title">3. Publish</h2>
        {!published ? (
          <>
            <div className="dev-actions">
              <button className="primary-btn" onClick={publish} disabled={!isValid || publishing}>
                {publishing ? 'Publishing…' : 'Publish game'}
              </button>
            </div>
            {publishError && <p className="error-line">{publishError}</p>}
          </>
        ) : (
          <div className="dev-publish-success">
            <p className="dev-valid-line">Published! Your game is live in every couch's catalog.</p>
            <div className="dev-token-box">
              <span className="dev-token-value">{published.managementToken}</span>
              <button className="ghost-btn compact" onClick={() => void copyToken()}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="error-line">Shown once — cannot be recovered. Save it now.</p>
            <p className="dev-hint">Game id: {published.id}</p>
            <div className="dev-actions">
              <button className="ghost-btn" onClick={() => navigate('/')}>
                See it in the catalog
              </button>
              <a className="ghost-btn" href="/COUCH-GAME-GUIDE.md" target="_blank" rel="noreferrer">
                Read the creator guide
              </a>
            </div>
          </div>
        )}
      </section>

      <section className="dev-section dev-manage-section">
        <button className="text-btn dev-manage-toggle" onClick={() => setManageOpen((v) => !v)}>
          {manageOpen ? 'Hide manage' : 'Manage a published game'}
        </button>
        {manageOpen && (
          <div className="dev-manage-body">
            <label className="control-label">
              <span>Game id</span>
              <input value={manageId} onChange={(e) => setManageId(e.target.value)} placeholder="my-game" />
            </label>
            <label className="control-label">
              <span>Management token</span>
              <input
                value={manageToken}
                onChange={(e) => setManageToken(e.target.value)}
                placeholder="paste the token shown at submit"
              />
            </label>
            <p className="dev-hint">Update uses the manifest textarea above as the new manifest content.</p>
            <div className="dev-actions">
              <button
                className="primary-btn"
                onClick={() => void manageUpdate()}
                disabled={manageBusy || !manageId.trim() || !manageToken.trim()}
              >
                Update
              </button>
              <button
                className="ghost-btn"
                onClick={() => void manageDelete()}
                disabled={manageBusy || !manageId.trim() || !manageToken.trim()}
              >
                Unpublish
              </button>
            </div>
            {manageResult && <p className="dev-hint">{manageResult}</p>}
          </div>
        )}
      </section>
    </main>
  );
}
