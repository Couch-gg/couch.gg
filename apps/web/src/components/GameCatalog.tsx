import * as LucideIcons from 'lucide-react';
import type { GameManifest } from '@couch/types';

interface GameCatalogProps {
  games: GameManifest[];
  currentGameId?: string | null;
  selectable?: boolean;
  onSelect?: (id: string) => void;
  className?: string;
}

export function GameCatalog({ games, currentGameId, selectable, onSelect, className }: GameCatalogProps) {
  const rootClass = ['game-catalog', className ?? null].filter(Boolean).join(' ');

  return (
    <div className={rootClass}>
      {games.map((game) => {
        const isSelected = game.id === currentGameId;
        const isComingSoon = !!game.comingSoon;
        const isDisabled = isComingSoon || !selectable;

        const cardClass = ['game-card', isSelected ? 'selected' : null, isComingSoon ? 'coming-soon' : null]
          .filter(Boolean)
          .join(' ');

        const IconComponent = (LucideIcons as Record<string, unknown>)[game.thumbnail.icon] as
          | React.ComponentType<{ size?: number; color?: string }>
          | undefined;
        const ResolvedIcon = IconComponent ?? (LucideIcons.Gamepad2 as React.ComponentType<{ size?: number; color?: string }>);

        return (
          <button
            key={game.id}
            className={cardClass}
            disabled={isDisabled}
            onClick={selectable && !isComingSoon ? () => onSelect?.(game.id) : undefined}
          >
            <div className="game-card-thumb" style={{ background: game.thumbnail.gradient }}>
              <span className="game-card-icon">
                <ResolvedIcon size={26} color={game.thumbnail.accent ?? '#fff'} />
              </span>
            </div>
            <div className="game-card-title">{game.title}</div>
            <div className="game-card-meta">
              {game.minPlayers}–{game.maxPlayers} players · {game.estimatedDurationMinutes} min
            </div>
            {isComingSoon && <span className="game-card-badge">Coming soon</span>}
          </button>
        );
      })}
    </div>
  );
}
