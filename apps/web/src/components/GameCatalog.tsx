import * as LucideIcons from 'lucide-react';
import { Check, Flag } from 'lucide-react';
import { useState } from 'react';
import type { ExternalGameManifest, GameManifest } from '@couch/types';
import { reportGame } from '../gamesApi.js';

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

  const handleReport = (event: React.MouseEvent, id: string) => {
    event.stopPropagation();
    if (reportedIds[id]) return;
    setReportedIds((prev) => ({ ...prev, [id]: true }));
    reportGame(id).catch(() => {
      // Best-effort — the icon stays swapped even if the request failed silently.
    });
  };

  return (
    <div className={rootClass}>
      {sortedGames.map((game) => {
        const isSelected = game.id === currentGameId;
        const isComingSoon = !!game.comingSoon;
        const isExternal = game.origin === 'external';
        const externalGame = isExternal ? (game as ExternalGameManifest) : undefined;
        const supportsRemote = !!externalGame?.supportsRemote;
        const isRemoteBlocked = !!remoteMode && isExternal && !supportsRemote;
        const isDisabled = isComingSoon || isRemoteBlocked || !selectable;
        const author = externalGame?.author;

        const cardClass = [
          'game-card',
          isSelected ? 'selected' : null,
          isComingSoon ? 'coming-soon' : null,
          isRemoteBlocked ? 'coming-soon' : null
        ]
          .filter(Boolean)
          .join(' ');

        const IconComponent = (LucideIcons as Record<string, unknown>)[game.thumbnail.icon] as
          | React.ComponentType<{ size?: number; color?: string }>
          | undefined;
        const ResolvedIcon = IconComponent ?? (LucideIcons.Gamepad2 as React.ComponentType<{ size?: number; color?: string }>);
        const isReported = !!reportedIds[game.id];

        return (
          <button
            key={game.id}
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
                onClick={(event) => handleReport(event, game.id)}
              >
                {isReported ? <Check size={14} /> : <Flag size={14} />}
              </button>
            )}
            <div className="game-card-thumb" style={{ background: game.thumbnail.gradient }}>
              <span className="game-card-icon">
                <ResolvedIcon size={26} color={game.thumbnail.accent ?? '#fff'} />
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
      })}
    </div>
  );
}
