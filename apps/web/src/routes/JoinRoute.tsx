import { Gamepad2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Lobby } from '@couch/types';
import { fetchLobby } from '../api.js';
import { QrPanel } from '../components/QrPanel.js';
import { isPhone } from '../device.js';

/**
 * Invite-link confirmation for `/j/:slug`. Opened from a shared link, it asks the visitor to confirm
 * joining the room. On a phone it leads straight into the controller; on desktop it shows a QR so the
 * link can be scanned onto a phone instead. It never renders the desktop attract home.
 */
export function JoinRoute({ slug, navigate }: { slug: string; navigate: (to: string) => void }) {
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Best-effort lookup to show the room name / player count and detect a dead invite.
  useEffect(() => {
    let active = true;
    setNotFound(false);
    void fetchLobby(slug)
      .then((next) => {
        if (active) setLobby(next);
      })
      .catch(() => {
        if (active) setNotFound(true);
      });
    return () => {
      active = false;
    };
  }, [slug]);

  if (notFound) {
    return (
      <main className="join-confirm-shell">
        <section className="join-confirm-card">
          <h1 className="join-confirm-title">Room not found</h1>
          <div className="join-confirm-room">{slug}</div>
          <div className="join-confirm-actions">
            <button className="primary-btn" onClick={() => navigate('/')}>
              Home
            </button>
          </div>
        </section>
      </main>
    );
  }

  const playerCount = lobby?.players.length ?? 0;

  return (
    <main className="join-confirm-shell">
      <section className="join-confirm-card">
        <h1 className="join-confirm-title">Join this room?</h1>
        <div className="join-confirm-room">{slug}</div>
        {lobby ? (
          <p className="muted">
            {playerCount} {playerCount === 1 ? 'player' : 'players'} in the room
          </p>
        ) : null}
        {isPhone() ? (
          <div className="join-confirm-actions">
            <button className="primary-btn" onClick={() => navigate(`/c/${slug}`)}>
              <Gamepad2 size={18} /> Join
            </button>
            <button className="ghost-btn" onClick={() => navigate('/')}>
              Not now
            </button>
          </div>
        ) : (
          <div className="join-confirm-actions">
            <p className="muted">Open on your phone to join</p>
            <QrPanel value={`${window.location.origin}/j/${slug}`} label="Scan to join" />
          </div>
        )}
      </section>
    </main>
  );
}
