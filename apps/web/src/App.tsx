import { useEffect, useMemo, useState } from 'react';
import { ControllerRoute } from './routes/ControllerRoute.js';
import { HomeRoute } from './routes/HomeRoute.js';
import { LobbyRoute } from './routes/LobbyRoute.js';
import { TrebuchetStandaloneRoute } from './routes/TrebuchetStandaloneRoute.js';

interface Route {
  kind: 'home' | 'lobby' | 'controller' | 'trebuchet';
  slug?: string;
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
    return { kind: 'home' };
  }, [path]);

  if (route.kind === 'lobby') return <LobbyRoute slug={route.slug!} navigate={navigate} />;
  if (route.kind === 'controller') return <ControllerRoute slug={route.slug!} navigate={navigate} />;
  if (route.kind === 'trebuchet') return <TrebuchetStandaloneRoute navigate={navigate} />;
  return <HomeRoute navigate={navigate} />;
}
