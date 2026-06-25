import { useEffect, useMemo, useState } from 'react';
import { ControllerRoute } from './routes/ControllerRoute.js';
import { HomeRoute } from './routes/HomeRoute.js';
import { JoinRoute } from './routes/JoinRoute.js';
import { LobbyRoute } from './routes/LobbyRoute.js';
import { PairRoute } from './routes/PairRoute.js';
import { TrebuchetStandaloneRoute } from './routes/TrebuchetStandaloneRoute.js';

interface Route {
  kind: 'home' | 'lobby' | 'controller' | 'trebuchet' | 'pair' | 'join';
  slug?: string;
  screenId?: string;
}

export function App() {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = (to: string) => {
    window.history.pushState({}, '', to);
    setPath(window.location.pathname);
  };

  const route = useMemo<Route>(() => {
    const parts = path.split('/').filter(Boolean);
    if (parts[0] === 'l' && parts[1]) return { kind: 'lobby', slug: parts[1].toUpperCase() };
    if (parts[0] === 'c' && parts[1]) return { kind: 'controller', slug: parts[1].toUpperCase() };
    if (parts[0] === 'games' && parts[1] === 'trebuchet') return { kind: 'trebuchet' };
    // Screen ids are case-sensitive — do NOT uppercase.
    if (parts[0] === 's' && parts[1]) return { kind: 'pair', screenId: parts[1] };
    if (parts[0] === 'j' && parts[1]) return { kind: 'join', slug: parts[1].toUpperCase() };
    return { kind: 'home' };
  }, [path]);

  if (route.kind === 'lobby') return <LobbyRoute slug={route.slug!} navigate={navigate} />;
  if (route.kind === 'controller') return <ControllerRoute slug={route.slug!} navigate={navigate} />;
  if (route.kind === 'trebuchet') return <TrebuchetStandaloneRoute navigate={navigate} />;
  if (route.kind === 'pair') return <PairRoute screenId={route.screenId!} navigate={navigate} />;
  if (route.kind === 'join') return <JoinRoute slug={route.slug!} navigate={navigate} />;
  return <HomeRoute navigate={navigate} />;
}
