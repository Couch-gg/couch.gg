import { Check, Flag, Zap } from 'lucide-react';
import { Component, useState, type ErrorInfo, type MouseEvent, type ReactNode } from 'react';
import { sanitizeThumbnail } from '@couch/game-runtime';
import type { ExternalGameManifest, GameManifest } from '@couch/types';
import { reportGame } from '../gamesApi.js';
import { catalogIcon } from './catalogIcons.js';

interface GameCatalogProps {
  games: GameManifest[];
  currentGameId?: string | null;
  selectable?: boolean;
  onSelect?: (id: string) => void;
  className?: string;
  remoteMode?: boolean;
}

export function GameCatalog({ games, currentGameId, selectable, onSelect, className, remoteMode }: GameCatalogProps) {
  const rootClass = ['game-catalog', className ?? null].filter(Boolean).join(' ');
  const [reportedIds, setReportedIds] = useState<Record<string, boolean>>({});

  const sortedGames = [...games].sort((a, b) => {
    const aComingSoon = !!a.comingSoon;
    const bComingSoon = !!b.comingSoon;
    if (aComingSoon !== bComingSoon) return aComingSoon ? 1 : -1;
    const aFeatured = !!a.featured;
    const bFeatured = !!b.featured;
    if (aFeatured !== bFeatured) return aFeatured ? -1 : 1;
    return 0;
  });

  const handleReport = (event: MouseEvent, id: string) => {
    event.stopPropagation();
    if (reportedIds[id]) return;
    setReportedIds((prev) => ({ ...prev, [id]: true }));
    reportGame(id).catch(() => {
      // Best-effort — the icon stays swapped even if the request failed silently.
    });
  };

  return (
    <div className={rootClass}>
      {sortedGames.map((game) => (
        <CardBoundary key={game.id}>
          <GameCard
            game={game}
            isSelected={game.id === currentGameId}
            selectable={!!selectable}
            remoteMode={!!remoteMode}
            isReported={!!reportedIds[game.id]}
            onSelect={onSelect}
            onReport={handleReport}
          />
        </CardBoundary>
      ))}
      {selectable ? (
        <a className="game-card publish-card" href="/dev" target="_blank" rel="noreferrer">
          <div className="game-card-thumb publish-card-thumb">
            <span className="game-card-icon">
              <Zap size={26} color="#fff" />
            </span>
          </div>
          <div className="game-card-title">Your game here</div>
          <div className="game-card-meta">Build & publish — no account</div>
          <span className="game-card-badge">{window.location.host}/dev</span>
        </a>
      ) : (
        <div className="game-card publish-card">
          <div className="game-card-thumb publish-card-thumb">
            <span className="game-card-icon">
              <Zap size={26} color="#fff" />
            </span>
          </div>
          <div className="game-card-title">Your game here</div>
          <div className="game-card-meta">Build & publish — no account</div>
          <span className="game-card-badge">{window.location.host}/dev</span>
        </div>
      )}
    </div>
  );
}

interface GameCardProps {
  game: GameManifest;
  isSelected: boolean;
  selectable: boolean;
  remoteMode: boolean;
  isReported: boolean;
  onSelect?: (id: string) => void;
  onReport: (event: MouseEvent, id: string) => void;
}

function GameCard({ game, isSelected, selectable, remoteMode, isReported, onSelect, onReport }: GameCardProps) {
  const isComingSoon = !!game.comingSoon;
  const isExternal = game.origin === 'external';
  const externalGame = isExternal ? (game as ExternalGameManifest) : undefined;
  const supportsRemote = !!externalGame?.supportsRemote;
  const isRemoteBlocked = remoteMode && isExternal && !supportsRemote;
  const isDisabled = isComingSoon || isRemoteBlocked || !selectable;
  const author = externalGame?.author;
  // Only an allowed icon, gradient and accent reach the DOM; anything else
  // (e.g. a record published before the thumbnail rules) gets the fallback.
  const thumbnail = sanitizeThumbnail(game.thumbnail);
  const Icon = catalogIcon(thumbnail.icon);

  const cardClass = [
    'game-card',
    isSelected ? 'selected' : null,
    isComingSoon ? 'coming-soon' : null,
    isRemoteBlocked ? 'coming-soon' : null
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      className={cardClass}
      disabled={isDisabled}
      onClick={selectable && !isComingSoon && !isRemoteBlocked ? () => onSelect?.(game.id) : undefined}
    >
      {isExternal && (
        <button
          type="button"
          className="game-card-report"
          title={isReported ? 'Reported' : 'Report game'}
          aria-label={isReported ? 'Reported' : 'Report game'}
          onClick={(event) => onReport(event, game.id)}
        >
          {isReported ? <Check size={14} /> : <Flag size={14} />}
        </button>
      )}
      <div className="game-card-thumb" style={{ background: thumbnail.gradient }}>
        <span className="game-card-icon">
          <Icon size={26} color={thumbnail.accent ?? '#fff'} />
        </span>
      </div>
      <div className="game-card-title">{game.title}</div>
      <div className="game-card-meta">
        {game.minPlayers}–{game.maxPlayers} players · {game.estimatedDurationMinutes} min
        {author?.name ? ` · by ${author.name}` : ''}
      </div>
      <div className="game-card-badges">
        {isExternal && <span className="game-badge community">Community</span>}
        {supportsRemote && <span className="game-badge remote">Remote</span>}
      </div>
      {isRemoteBlocked ? (
        <span className="game-card-badge">Local couch only</span>
      ) : isComingSoon ? (
        <span className="game-card-badge">Coming soon</span>
      ) : null}
    </button>
  );
}

// One card that can't be drawn (a manifest this client doesn't understand)
// must not take the whole catalog down with it, and with it the TV or phone
// lobby: that card is left out and the others render.
class CardBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Game card failed to render', error, info.componentStack);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
