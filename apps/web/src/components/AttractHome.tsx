import { useEffect, useRef, useState } from 'react';
import { fetchScreen, registerScreen } from '../api.js';
import { createSocket, emitAck } from '../socket.js';
import { AttractStage } from './AttractStage.js';
import { QrPanel } from './QrPanel.js';

// The audio engine is served from public/ at /js/sfx.js (not bundled from src/), so it is loaded via
// a runtime dynamic import. `new Function` keeps Vite from rewriting the specifier — the same pattern
// TrebuchetStage uses for its public modules. It is a shared singleton across the app.
interface SfxModule {
  musicScene: (scene: 'menu' | 'game' | 'none') => void;
}

let sfxPromise: Promise<SfxModule | null> | null = null;

function loadSfx(): Promise<SfxModule | null> {
  if (sfxPromise) return sfxPromise;
  sfxPromise = (async () => {
    try {
      if (typeof window === 'undefined') return null;
      const importer = new Function('p', 'return import(p)') as (p: string) => Promise<any>;
      const mod = await importer('/js/sfx.js');
      return (mod?.SFX ?? mod?.default ?? null) as SfxModule | null;
    } catch {
      // Audio is optional — a load failure must never break the landing screen.
      return null;
    }
  })();
  return sfxPromise;
}

const SCREEN_KEY = 'couch:screenId';
// Register again this often while showing the QR code: that keeps the screen
// id alive on the server (it expires 10 minutes after the last registration).
const REREGISTER_MS = 4 * 60 * 1000;

/**
 * Desktop / TV "attract" home. Registers a short-lived screen, shows a QR a phone can scan,
 * and navigates into the lobby once a phone claims this screen. Resilient to socket/REST
 * failures — a backend hiccup degrades to REST polling, it never breaks the render.
 */
export function AttractHome({ navigate }: { navigate: (to: string) => void }) {
  const [screenId, setScreenId] = useState('');
  const claimedRef = useRef(false);

  // Select the calm "menu" music bed while on the attract screen. It only becomes audible after a
  // user gesture (the engine unlocks audio itself); we just request the scene.
  useEffect(() => {
    void loadSfx().then((sfx) => {
      try {
        sfx?.musicScene('menu');
      } catch {
        // never block render on audio
      }
    });
  }, []);

  useEffect(() => {
    let active = true;
    const socket = createSocket();
    let pollTimer: number | null = null;
    let refreshTimer: number | null = null;
    let registering = false;

    const goToLobby = (slug: string | null | undefined) => {
      if (claimedRef.current || !slug) return;
      claimedRef.current = true;
      navigate(`/l/${slug}`);
    };

    const applyScreen = (id: string, claimedSlug: string | null | undefined) => {
      if (!active) return;
      try {
        window.sessionStorage.setItem(SCREEN_KEY, id);
      } catch {
        // sessionStorage may be unavailable (private mode); reuse is best-effort.
      }
      setScreenId(id);
      if (claimedSlug) goToLobby(claimedSlug);
    };

    // Register this TV's screen, or the one it already shows again: that
    // keeps it alive on the server, and puts this socket (back) into the
    // screen's room for the instant screen:claimed push. Without a usable id
    // (none yet, or it expired) a REST registration is the fallback, so a QR
    // code still appears when the socket can't connect.
    const register = async (needsId: boolean) => {
      if (registering || claimedRef.current) return;
      registering = true;
      let stored: string | null = null;
      try {
        stored = window.sessionStorage.getItem(SCREEN_KEY);
      } catch {
        stored = null;
      }
      try {
        const res = await emitAck<{ ok: true; screen: { id: string; expiresAt: string; claimedSlug: string | null } }>(
          socket,
          'screen:register',
          { screenId: stored ?? undefined }
        );
        applyScreen(res.screen.id, res.screen.claimedSlug);
      } catch {
        if (!needsId) return;
        try {
          const screen = await registerScreen();
          applyScreen(screen.id, screen.claimedSlug);
        } catch {
          // Both paths failed; leave the "Connecting…" hint in place.
        }
      } finally {
        registering = false;
      }
    };

    socket.on('screen:claimed', (p: { screenId: string; slug: string }) => goToLobby(p.slug));
    // A reconnected socket is in no room: register again to rejoin it.
    socket.on('connect', () => void register(false));

    void register(true);
    refreshTimer = window.setInterval(() => void register(false), REREGISTER_MS);

    // REST poll fallback in case the realtime push never lands (e.g. socket dropped).
    pollTimer = window.setInterval(() => {
      let id: string | null = null;
      try {
        id = window.sessionStorage.getItem(SCREEN_KEY);
      } catch {
        id = null;
      }
      if (!id || claimedRef.current) return;
      void fetchScreen(id)
        .then((screen) => {
          // The QR code shows a dead id (the TV sat unscanned past its
          // lifetime): get a live one, or a phone's claim would fail.
          if (screen.expired) void register(true);
          else goToLobby(screen.claimedSlug);
        })
        .catch(() => {
          // Swallow poll errors — the next tick retries.
        });
    }, 2500);

    return () => {
      active = false;
      if (pollTimer != null) window.clearInterval(pollTimer);
      if (refreshTimer != null) window.clearInterval(refreshTimer);
      socket.disconnect();
    };
  }, [navigate]);

  const localPairUrl = screenId ? `${window.location.origin}/s/${screenId}?mode=local` : '';
  const remotePairUrl = screenId ? `${window.location.origin}/s/${screenId}?mode=remote` : '';

  return (
    <main className="attract-shell">
      <AttractStage className="attract-stage" />
      <div className="attract-overlay">
        <div className="attract-brand">couch.gg</div>
        {screenId ? (
          <>
            <div className="attract-qr-grid">
              <div className="attract-choice">
                <h2>Local Couch</h2>
                <QrPanel value={localPairUrl} variant="attract" label="Same screen" />
              </div>
              <div className="attract-choice">
                <h2>Remote Couch</h2>
                <QrPanel value={remotePairUrl} variant="attract" label="Host or join" />
              </div>
            </div>
            {/* Display the host the screen is actually served from — couch.gg
                itself is a parked domain, so the typeable address must be the
                real one (couch-gg.vercel.app today; auto-corrects if a proper
                domain is connected later). */}
            <div className="attract-footer">Made a game? {window.location.host}/dev</div>
          </>
        ) : (
          <div className="attract-hint">Connecting…</div>
        )}
      </div>
      <div className="crt-overlay" aria-hidden />
    </main>
  );
}
