import { Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { claimScreen, createLobby, fetchLobby } from '../api.js';
import { isPhone } from '../device.js';

const ACTIVE_SLUG_KEY = 'couch:activeSlug';

function tokenKey(slug: string): string {
  return `couch:player-token:${slug}`;
}

/**
 * Phone pairing target for `/s/:screenId`. The phone arrives here after scanning a TV's attract QR.
 * It can attach the TV to a room the phone is already in, or create/join a fresh room — in every
 * case it claims the scanned screen so the TV jumps into the lobby.
 */
export function PairRoute({ screenId, navigate }: { screenId: string; navigate: (to: string) => void }) {
  const [attachSlug, setAttachSlug] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Detect an existing membership so the phone can stay in its lobby while pairing the TV.
  useEffect(() => {
    let active = true;
    const detect = async () => {
      let storedSlug: string | null = null;
      try {
        storedSlug = window.localStorage.getItem(ACTIVE_SLUG_KEY);
      } catch {
        storedSlug = null;
      }
      if (!storedSlug) return;
      let token: string | null = null;
      try {
        token = window.localStorage.getItem(tokenKey(storedSlug));
      } catch {
        token = null;
      }
      if (!token) return;
      try {
        await fetchLobby(storedSlug);
        if (active) setAttachSlug(storedSlug);
      } catch {
        // The remembered lobby no longer exists — fall back to create/join only.
      }
    };
    void detect();
    return () => {
      active = false;
    };
  }, []);

  const claimFailMessage = (err: unknown): string => {
    if (err instanceof Error && err.message) return err.message;
    return 'This screen code expired — rescan the TV';
  };

  const onAttach = async () => {
    if (!attachSlug) return;
    setBusy(true);
    setError(null);
    try {
      await claimScreen(screenId, attachSlug);
      navigate(`/c/${attachSlug}`);
    } catch (err) {
      setError(claimFailMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      const lobby = await createLobby();
      await claimScreen(screenId, lobby.slug);
      navigate(`/c/${lobby.slug}`);
    } catch (err) {
      setError(claimFailMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onJoin = async (event: React.FormEvent) => {
    event.preventDefault();
    const slug = joinCode.trim().toUpperCase();
    if (!slug) return;
    setBusy(true);
    setError(null);
    try {
      await claimScreen(screenId, slug);
      navigate(`/c/${slug}`);
    } catch (err) {
      setError(claimFailMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="pair-shell">
      <section className="pair-card">
        {!isPhone() ? <p className="muted">Tip: open this link on your phone.</p> : null}
        <h1 className="pair-title">Connect this screen</h1>

        {attachSlug ? (
          <div className="pair-attach">
            <p>Attach this TV to your room {attachSlug}</p>
            <button className="primary-btn wide" onClick={onAttach} disabled={busy}>
              {busy ? 'Verbinde...' : `Attach to ${attachSlug}`}
            </button>
          </div>
        ) : null}

        <h2 className="pair-sub">{attachSlug ? 'or start fresh' : 'Start a session'}</h2>
        <button className="primary-btn wide" onClick={onCreate} disabled={busy}>
          <Play size={18} /> {busy ? 'Erstelle...' : 'Create a room'}
        </button>
        <form className="pair-join-form" onSubmit={onJoin}>
          <input
            value={joinCode}
            onChange={(event) => setJoinCode(event.target.value)}
            placeholder="Room code"
            aria-label="Room code"
          />
          <button type="submit" disabled={busy}>
            Join
          </button>
        </form>
        {error ? <p className="error-line">{error}</p> : null}
      </section>
    </main>
  );
}
