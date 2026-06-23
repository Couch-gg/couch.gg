import type { Player } from '@couch/types';

const swatches = ['#e8554d', '#4d9be8', '#5dc961', '#e8c44d', '#d47cff', '#62d5d5', '#ff935c', '#f2f2f2'];

export function PlayerRoster({ players, hostPlayerId }: { players: Player[]; hostPlayerId: string | null }) {
  return (
    <div className="roster" aria-label="Players">
      {players.map((player) => (
        <div className="player-row" key={player.id}>
          <span className="player-swatch" style={{ background: swatches[player.colorIdx % swatches.length] }} />
          <span className="player-name">{player.name}</span>
          {hostPlayerId === player.id ? <span className="host-tag">Host</span> : null}
          <span className={player.connected ? 'connection ok' : 'connection lost'}>{player.connected ? 'online' : 'reconnect'}</span>
        </div>
      ))}
      {players.length === 0 ? <div className="empty-roster">Noch keine Controller verbunden</div> : null}
    </div>
  );
}
