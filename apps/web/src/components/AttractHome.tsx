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

    const register = async () => {
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
        // Socket path failed — fall back to a REST registration so the QR still appears.
        try {
          const screen = await registerScreen();
          applyScreen(screen.id, screen.claimedSlug);
        } catch {
          // Both paths failed; leave the "Connecting…" hint in place.
        }
      }
    };

    socket.on('screen:claimed', (p: { screenId: string; slug: string }) => goToLobby(p.slug));

    void register();

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
        .then((screen) => goToLobby(screen.claimedSlug))
        .catch(() => {
          // Swallow poll errors — the next tick retries.
        });
    }, 2500);

    return () => {
      active = false;
      if (pollTimer != null) window.clearInterval(pollTimer);
      socket.disconnect();
    };
  }, [navigate]);

  const pairUrl = screenId ? `${window.location.origin}/s/${screenId}` : '';

  return (
    <main className="attract-shell">
      <AttractStage className="attract-stage" />
      <div className="attract-overlay">
        <div className="attract-brand">couch.gg</div>
        {pairUrl ? (
          <QrPanel value={pairUrl} variant="attract" label="Scan to start" />
        ) : (
          <div className="attract-hint">Connecting…</div>
        )}
        <div className="attract-hint">Scan with your phone to start a couch session</div>
      </div>
      <div className="crt-overlay" aria-hidden />
    </main>
  );
}
