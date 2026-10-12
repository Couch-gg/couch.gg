import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ExternalGameManifest,
  ExternalGameSnapshot,
  GameInputEnvelope,
  InputAction,
  Lobby,
  Player
} from '@couch/types';
import { validateExternalManifestInput, type ExternalManifestInput } from '@couch/game-runtime';
import { checkControllerPatch } from '@couch/game-sdk';
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

// Prepended verbatim to the raw guide so a creator can paste one block straight
// into their coding agent. Kept exact — the plan/spec pins this wording.
const GUIDE_PROMPT_PREFIX =
  'You are building (or retrofitting) a web game to run on couch.gg. Follow this contract exactly:\n\n';

const DEGIT_COMMAND = 'npx degit Couch-gg/couch.gg/templates/couch-game-starter my-game';

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
  const [controllerError, setControllerError] = useState<string | null>(null);

  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [published, setPublished] = useState<{ id: string; managementToken: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Hero: "Copy the guide for your AI". On any failure (fetch or clipboard) we
  // fall back to a readOnly, auto-selected textarea carrying the exact same text
  // so the creator can still Ctrl/Cmd+C it manually.
  const [guideCopied, setGuideCopied] = useState(false);
  const [guideFallback, setGuideFallback] = useState<string | null>(null);
  const guideFallbackRef = useRef<HTMLTextAreaElement | null>(null);
  const [degitCopied, setDegitCopied] = useState(false);

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
    setControllerError(null);
    setTesting(true);
  };

  const stopTest = () => {
    setTesting(false);
    setHandshake('idle');
    setHandshakeError(null);
    setGameOverScores(null);
    setControllerError(null);
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
    } else if (event.kind === 'controller') {
      // No phones here, so nothing reaches the server that would reject a bad
      // couch.setController patch. Check it with the same rules instead, so
      // the creator learns why before a live couch drops it. The line shows
      // the latest patch only: a good one clears an earlier rejection.
      const { playerId, patch } = event.detail as { playerId: string; patch: unknown };
      const checked = checkControllerPatch(patch, testManifest?.controllerLayout.controls.map((c) => c.control) ?? []);
      if (!FAKE_PLAYERS.some((p) => p.id === playerId)) setControllerError(`no player "${playerId}"`);
      else if (!checked.ok) setControllerError(checked.error);
      else setControllerError(null);
    }
  }, [testManifest]);

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

  // Step 1 of the hero: fetch the canonical guide, prepend the agent instruction,
  // and copy the whole block. Any failure (fetch OR clipboard) drops to a
  // select-all textarea carrying identical text so the copy path never dead-ends.
  const copyGuideForAi = useCallback(async () => {
    let text: string;
    try {
      const res = await fetch('/COUCH-GAME-GUIDE.md');
      if (!res.ok) throw new Error(`Guide fetch failed (${res.status})`);
      const md = await res.text();
      text = GUIDE_PROMPT_PREFIX + md;
    } catch {
      // Fetch failed — surface the prefix alone so the creator at least has the
      // framing instruction and a link to the raw guide in the fallback hint.
      setGuideFallback(GUIDE_PROMPT_PREFIX);
      return;
    }
    try {
      if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(text);
      setGuideFallback(null);
      setGuideCopied(true);
      window.setTimeout(() => setGuideCopied(false), 4000);
    } catch {
      setGuideFallback(text);
    }
  }, []);

  const copyDegit = useCallback(async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(DEGIT_COMMAND);
      setDegitCopied(true);
      window.setTimeout(() => setDegitCopied(false), 2000);
    } catch {
      // The command is visible, monospace, and selectable — copy is a convenience.
    }
  }, []);

  // Auto-select the fallback textarea the moment it appears so a single
  // Ctrl/Cmd+C grabs everything.
  useEffect(() => {
    if (guideFallback !== null) guideFallbackRef.current?.select();
  }, [guideFallback]);

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

      {/* Scoped styles for the onboarding hero — styles.css is owned by another
          builder, so the new bits live here and reuse the app's palette vars. */}
      <style>{`
        .dev-hero {
          display: grid;
          gap: 16px;
          margin-bottom: 34px;
        }
        .dev-hero-intro {
          margin: 0;
          color: var(--muted);
          font-size: 15px;
          line-height: 1.55;
        }
        .dev-hero-steps {
          display: grid;
          gap: 14px;
        }
        @media (min-width: 900px) {
          .dev-hero-steps { grid-template-columns: repeat(3, 1fr); }
        }
        .dev-hero-step {
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 18px;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: rgba(248, 237, 207, 0.03);
        }
        .dev-hero-num {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          font-family: "Press Start 2P", monospace;
          font-size: 10px;
          line-height: 1.4;
          color: var(--accent);
          letter-spacing: 0.02em;
        }
        .dev-hero-chip {
          display: inline-grid;
          place-items: center;
          width: 24px;
          height: 24px;
          border-radius: 6px;
          border: 1px solid rgba(241, 207, 106, 0.5);
          background: rgba(241, 207, 106, 0.1);
          color: var(--accent);
        }
        .dev-hero-step h3 {
          margin: 0;
          font-size: 15px;
          font-weight: 800;
          color: var(--text);
        }
        .dev-hero-step p {
          margin: 0;
          color: var(--muted);
          font-size: 13px;
          line-height: 1.5;
        }
        .dev-hero-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          align-items: center;
          margin-top: 2px;
        }
        .dev-copybox {
          display: flex;
          align-items: stretch;
          gap: 8px;
          padding: 8px 10px;
          border: 1px solid var(--line);
          border-radius: 8px;
          background: #0c0e0d;
        }
        .dev-copybox code {
          flex: 1 1 auto;
          overflow-x: auto;
          white-space: nowrap;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 12px;
          color: var(--text);
          align-self: center;
        }
        .dev-guide-fallback {
          display: grid;
          gap: 6px;
          margin-top: 4px;
        }
        .dev-guide-fallback textarea {
          width: 100%;
          min-height: 120px;
          resize: vertical;
          border: 1px solid var(--line);
          border-radius: 8px;
          background: #0c0e0d;
          color: var(--text);
          padding: 10px 12px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 12px;
          line-height: 1.5;
        }
      `}</style>

      <section className="dev-hero" aria-label="How to build a game">
        <p className="dev-hero-intro">
          New here? Build a web game your way — the platform gives you the lobby, QR pairing, phone controllers, and
          input relay. Three steps to your first published game:
        </p>
        <div className="dev-hero-steps">
          <div className="dev-hero-step">
            <span className="dev-hero-num">
              <span className="dev-hero-chip">1</span> Hand the contract to your AI
            </span>
            <h3>Copy the guide, paste it into your coding agent</h3>
            <p>One block: the framing instruction plus the full couch.gg build contract, ready for Claude/Cursor/ChatGPT.</p>
            <div className="dev-hero-actions">
              <button className="primary-btn" onClick={() => void copyGuideForAi()}>
                {guideCopied ? 'Copied — paste it into Claude/Cursor/ChatGPT' : 'Copy the guide for your AI'}
              </button>
              <a className="ghost-btn" href="/guide">
                Read the guide
              </a>
            </div>
            {guideFallback !== null && (
              <div className="dev-guide-fallback">
                <textarea ref={guideFallbackRef} readOnly value={guideFallback} aria-label="Guide text to copy" />
                <p className="dev-hint">Press Ctrl/Cmd+C to copy.</p>
              </div>
            )}
          </div>

          <div className="dev-hero-step">
            <span className="dev-hero-num">
              <span className="dev-hero-chip">2</span> Build &amp; test locally
            </span>
            <h3>Start from the working template</h3>
            <div className="dev-copybox">
              <code>{DEGIT_COMMAND}</code>
              <button className="ghost-btn compact" onClick={() => void copyDegit()} aria-label="Copy the degit command">
                {degitCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p>Open index.html — the SDK boots a simulator with fake phones. No account, no build step.</p>
          </div>

          <div className="dev-hero-step">
            <span className="dev-hero-num">
              <span className="dev-hero-chip">3</span> Test &amp; publish below
            </span>
            <h3>Validate, test, publish</h3>
            <p>
              Paste your manifest below, run the live test until the handshake is green, then publish. You'll get a
              one-time management token.
            </p>
          </div>
        </div>
      </section>

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
        {testing && controllerError && (
          <p className="error-line">
            setController rejected: {controllerError}. A live couch rejects the whole patch.
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
              <a className="ghost-btn" href="/guide">
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
