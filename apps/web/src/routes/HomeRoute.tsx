import { Gamepad2, MonitorUp, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createLobby } from '../api.js';

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

export function HomeRoute({ navigate }: { navigate: (to: string) => void }) {
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Select the calm "menu" music bed while on the landing screen. It only becomes audible after a
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

  const onCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      const lobby = await createLobby();
      navigate(`/l/${lobby.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Konnte Lobby nicht erstellen');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="home-shell">
      <section className="home-primary">
        <div className="brand-row">
          <span className="brand-mark">c</span>
          <span>couch.gg</span>
        </div>
        <h1>Play together on the big screen.</h1>
        <p>
          Create a room, scan the code with phones, and use them as controllers for fast multiplayer games.
        </p>
        <div className="home-actions">
          <button className="primary-btn" onClick={onCreate} disabled={busy}>
            <Play size={18} /> {busy ? 'Erstelle...' : 'Neue Lobby erstellen'}
          </button>
          <button className="ghost-btn" onClick={() => navigate('/games/trebuchet')}>
            <Gamepad2 size={18} /> Trebuchet testen
          </button>
        </div>
        <form
          className="join-strip"
          onSubmit={(event) => {
            event.preventDefault();
            if (joinCode.trim()) navigate(`/l/${joinCode.trim().toUpperCase()}`);
          }}
        >
          <input
            value={joinCode}
            onChange={(event) => setJoinCode(event.target.value)}
            placeholder="Lobby-Code"
            aria-label="Lobby-Code"
          />
          <button type="submit">Beitreten</button>
        </form>
        {error ? <p className="error-line">{error}</p> : null}
      </section>
      <section className="home-game-preview" aria-label="Trebuchet preview">
        <div className="preview-window">
          <div className="preview-sky" />
          <div className="preview-hill" />
          <div className="preview-castle left" />
          <div className="preview-castle right" />
          <div className="preview-shot" />
          <div className="preview-panel">
            <MonitorUp size={18} />
            <span>TV lobby plus phone controllers</span>
          </div>
        </div>
      </section>
    </main>
  );
}
