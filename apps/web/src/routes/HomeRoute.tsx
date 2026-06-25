import { Play } from 'lucide-react';
import { useState } from 'react';
import { createLobby } from '../api.js';
import { AttractHome } from '../components/AttractHome.js';
import { isPhone } from '../device.js';

export function HomeRoute({ navigate }: { navigate: (to: string) => void }) {
  if (isPhone()) return <ScanPrompt navigate={navigate} />;
  return <AttractHome navigate={navigate} />;
}

/**
 * Phone landing for the bare "/" route. The primary path is to scan a TV's on-screen code, so the
 * card leads with that instruction. Create/join are escape hatches for when no TV is around — the
 * phone then acts as the host controller.
 */
function ScanPrompt({ navigate }: { navigate: (to: string) => void }) {
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      const lobby = await createLobby();
      navigate(`/c/${lobby.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Konnte Lobby nicht erstellen');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="scan-prompt">
      <section className="scan-prompt-card">
        <div className="brand-row small">
          <span className="brand-mark">c</span>
          <span>couch.gg</span>
        </div>
        <h1 className="scan-prompt-title">Scan a TV to begin</h1>
        <p className="scan-prompt-body">
          Open couch.gg on your TV or computer and scan the code on screen to play together.
        </p>
        <div className="scan-prompt-actions">
          <button className="primary-btn" onClick={onCreate} disabled={busy}>
            <Play size={18} /> {busy ? 'Erstelle...' : 'Create a room'}
          </button>
          <form
            className="join-strip"
            onSubmit={(event) => {
              event.preventDefault();
              const code = joinCode.trim().toUpperCase();
              if (code) navigate(`/c/${code}`);
            }}
          >
            <input
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value)}
              placeholder="Room code"
              aria-label="Room code"
            />
            <button type="submit">Join</button>
          </form>
          {error ? <p className="error-line">{error}</p> : null}
        </div>
      </section>
    </main>
  );
}
