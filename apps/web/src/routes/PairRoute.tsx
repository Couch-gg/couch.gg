import { Share2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { claimScreen, createLobby, fetchScreen } from '../api.js';
import { isPhone } from '../device.js';

type RemoteStep = 'choose' | 'join';

const REMOTE_SHARE_KEY_PREFIX = 'couch:share-room:';

/**
 * Phone pairing target for `/s/:screenId`. Local scans are zero-choice: they
 * create/claim a room and open the controller. Remote scans keep the phone as a
 * controller too, but ask whether this player is hosting or joining by room number.
 */
export function PairRoute({ screenId, navigate }: { screenId: string; navigate: (to: string) => void }) {
  const phone = isPhone();
  const mode = useMemo(() => new URLSearchParams(window.location.search).get('mode') === 'remote' ? 'remote' : 'local', []);
  const localPairStartedRef = useRef(false);
  const [step, setStep] = useState<RemoteStep>('choose');
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(mode === 'local' && phone);
  const [status, setStatus] = useState(mode === 'local' ? 'Connecting this screen...' : 'Remote Couch');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!phone || mode !== 'local' || localPairStartedRef.current) return;
    localPairStartedRef.current = true;
    void pairLocal();
    // pairLocal is a local flow starter; the ref prevents repeated attempts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, phone]);

  const goToController = (slug: string, shareRoomNumber = false) => {
    if (shareRoomNumber) {
      try {
        window.sessionStorage.setItem(`${REMOTE_SHARE_KEY_PREFIX}${slug}`, '1');
      } catch {
        // Share prompt is helpful, not required.
      }
    }
    navigate(`/c/${slug}`);
  };

  async function pairLocal() {
    setBusy(true);
    setError(null);
    setStatus('Checking the screen...');
    try {
      const screen = await fetchScreen(screenId);
      if (screen.claimedSlug) {
        goToController(screen.claimedSlug);
        return;
      }

      setStatus('Starting a room...');
      const lobby = await createLobby();
      try {
        await claimScreen(screenId, lobby.slug);
        goToController(lobby.slug);
      } catch (err) {
        const latest = await fetchScreen(screenId).catch(() => null);
        if (latest?.claimedSlug) {
          goToController(latest.claimedSlug);
          return;
        }
        throw err;
      }
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'This screen code expired — rescan the TV');
      setStatus('Could not connect this screen');
      setBusy(false);
    }
  }

  const hostRemote = async () => {
    setBusy(true);
    setError(null);
    setStatus('Starting remote room...');
    try {
      const screen = await fetchScreen(screenId);
      if (screen.claimedSlug) {
        goToController(screen.claimedSlug, true);
        return;
      }
      const lobby = await createLobby('remote');
      await claimScreen(screenId, lobby.slug);
      goToController(lobby.slug, true);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Remote room could not be started');
      setBusy(false);
      setStatus('Remote Couch');
    }
  };

  const joinRemote = async (event: FormEvent) => {
    event.preventDefault();
    const slug = joinCode.trim().toUpperCase();
    if (!slug) return;
    setBusy(true);
    setError(null);
    setStatus('Joining remote room...');
    try {
      await claimScreen(screenId, slug);
      goToController(slug);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Room could not be joined');
      setBusy(false);
      setStatus('Remote Couch');
    }
  };

  if (!phone) {
    return (
      <main className="pair-shell">
        <section className="pair-card">
          <h1 className="pair-title">This link is for phones</h1>
          <p className="pair-sub">Use this device as a screen instead: open couch.gg here, then scan its QR code with a phone.</p>
          <button className="primary-btn wide" onClick={() => navigate('/')}>
            Open screen mode
          </button>
        </section>
      </main>
    );
  }

  if (mode === 'local') {
    return (
      <main className="pair-shell">
        <section className="pair-card">
          <h1 className="pair-title">{status}</h1>
          <p className="pair-sub">Keep this page open. Your controller will appear automatically.</p>
          {error ? <p className="error-line">{error}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="pair-shell">
      <section className="pair-card">
        <div className="brand-row small">
          <span className="brand-mark">c</span>
          <span>couch.gg</span>
        </div>
        <h1 className="pair-title">{status}</h1>
        <p className="pair-sub">Use this phone as the controller for the screen you just scanned.</p>

        {step === 'choose' ? (
          <div className="pair-actions">
            <button className="primary-btn wide" onClick={hostRemote} disabled={busy}>
              <Share2 size={18} /> {busy ? 'Starting...' : 'Host Game'}
            </button>
            <button className="ghost-btn wide" onClick={() => setStep('join')} disabled={busy}>
              Join Game
            </button>
          </div>
        ) : (
          <form className="pair-join-form remote" onSubmit={joinRemote}>
            <label className="control-label">
              <span>Enter Room Number</span>
              <input
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                placeholder="ABC123"
                aria-label="Room number"
                autoFocus
                inputMode="text"
              />
            </label>
            <div className="pair-actions">
              <button className="primary-btn wide" type="submit" disabled={busy || !joinCode.trim()}>
                {busy ? 'Joining...' : 'Join Game'}
              </button>
              <button className="ghost-btn wide" type="button" onClick={() => setStep('choose')} disabled={busy}>
                Back
              </button>
            </div>
          </form>
        )}
        {error ? <p className="error-line">{error}</p> : null}
      </section>
    </main>
  );
}
