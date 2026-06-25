import { useEffect, useState } from 'react';
import { claimScreen, createLobby, fetchScreen } from '../api.js';
import { isPhone } from '../device.js';

/**
 * Phone pairing target for `/s/:screenId`. Phones are controllers only: a fresh
 * screen scan creates and claims a room, while an already-claimed screen sends
 * the phone straight into that room.
 */
export function PairRoute({ screenId, navigate }: { screenId: string; navigate: (to: string) => void }) {
  const phone = isPhone();
  const [status, setStatus] = useState('Connecting this screen...');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!phone) return;
    let active = true;

    const goToController = (slug: string) => {
      if (!active) return;
      navigate(`/c/${slug}`);
    };

    const pair = async () => {
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
          return;
        } catch (err) {
          // If two phones scan the fresh QR at the same time, the other phone may
          // claim first. In that case, re-read the screen and join the winner.
          const latest = await fetchScreen(screenId).catch(() => null);
          if (latest?.claimedSlug) {
            goToController(latest.claimedSlug);
            return;
          }
          throw err;
        }
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error && err.message ? err.message : 'This screen code expired — rescan the TV');
        setStatus('Could not connect this screen');
      }
    };

    void pair();
    return () => {
      active = false;
    };
  }, [navigate, phone, screenId]);

  return (
    <main className="pair-shell">
      <section className="pair-card">
        <h1 className="pair-title">{phone ? status : 'This link is for phones'}</h1>
        <p className="pair-sub">
          {phone
            ? 'Keep this page open. Your controller will appear automatically.'
            : 'Use this device as a screen instead: open couch.gg here, then scan its QR code with a phone.'}
        </p>
        {!phone ? (
          <button className="primary-btn wide" onClick={() => navigate('/')}>
            Open screen mode
          </button>
        ) : null}
        {error ? <p className="error-line">{error}</p> : null}
      </section>
    </main>
  );
}
