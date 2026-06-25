import { useEffect, useState } from 'react';
import type { Lobby } from '@couch/types';
import { fetchLobby } from '../api.js';
import { QrPanel } from '../components/QrPanel.js';
import { isPhone } from '../device.js';

/**
 * Invite target for `/j/:slug`. Phones are controllers only and auto-open the
 * controller after the room exists. Desktop/laptop stays screen-oriented and
 * shows a QR so the link can be scanned onto a phone instead.
 */
export function JoinRoute({ slug, navigate }: { slug: string; navigate: (to: string) => void }) {
  const phone = isPhone();
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

  useEffect(() => {
    if (!phone || !lobby || notFound) return;
    navigate(`/c/${slug}`);
  }, [lobby, navigate, notFound, phone, slug]);

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

  if (phone) {
    return (
      <main className="join-confirm-shell">
        <section className="join-confirm-card">
          <h1 className="join-confirm-title">Opening controller...</h1>
          <div className="join-confirm-room">{slug}</div>
          <p className="muted">Checking the room and connecting this phone.</p>
        </section>
      </main>
    );
  }

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
        <div className="join-confirm-actions">
          <p className="muted">Open on your phone to join</p>
          <QrPanel value={`${window.location.origin}/j/${slug}`} label="Scan to join" />
        </div>
      </section>
    </main>
  );
}
