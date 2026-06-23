import { ArrowLeft, RefreshCcw, Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import { TrebuchetEngine, type TrebuchetEvent, type TrebuchetSnapshot } from '@couch/trebuchet';
import { TrebuchetStage } from '../components/TrebuchetStage.js';

const players = [
  { id: 'p1', name: 'Alex', colorIdx: 0 },
  { id: 'p2', name: 'Bea', colorIdx: 1 }
];

export function TrebuchetStandaloneRoute({ navigate }: { navigate: (to: string) => void }) {
  const [seedTick, setSeedTick] = useState(0);
  const engine = useMemo(() => new TrebuchetEngine({ now: () => Date.now() }), [seedTick]);
  const [snapshot, setSnapshot] = useState<TrebuchetSnapshot>(() => engine.start(players).snapshot);
  const [event, setEvent] = useState<TrebuchetEvent | null>(null);
  const [angle, setAngle] = useState(72);
  const [power, setPower] = useState(70);
  const turn = snapshot.units.find((unit) => unit.id === snapshot.turn);

  const restart = () => {
    setSeedTick((value) => value + 1);
  };

  const fire = () => {
    if (!snapshot.turn) return;
    const next = engine.fire(snapshot.turn, angle, power);
    if (!next) return;
    setEvent(next);
    setSnapshot(next.snapshot);
  };

  return (
    <main className="test-shell">
      <header className="tv-header">
        <button className="ghost-btn compact" onClick={() => navigate('/')}>
          <ArrowLeft size={16} /> Home
        </button>
        <div className="room-code">
          <span>Test route</span>
          <strong>/games/trebuchet</strong>
        </div>
        <button className="icon-btn" onClick={restart} title="Restart">
          <RefreshCcw size={18} />
        </button>
      </header>
      <section className="test-layout">
        <TrebuchetStage snapshot={snapshot} event={event} />
        <aside className="test-controls">
          <span className="micro-label">Local authoritative test</span>
          <h1>{turn ? `${turn.name}'s turn` : snapshot.winner ? 'Winner' : 'Finished'}</h1>
          <label className="range-control">
            <span>Angle <strong>{angle}°</strong></span>
            <input min={50} max={130} value={angle} type="range" onChange={(e) => setAngle(Number(e.target.value))} />
          </label>
          <label className="range-control">
            <span>Power <strong>{power}%</strong></span>
            <input min={10} max={100} value={power} type="range" onChange={(e) => setPower(Number(e.target.value))} />
          </label>
          <button className="fire-btn" disabled={!snapshot.turn} onClick={fire}>
            <Send size={18} /> Fire test shot
          </button>
          <div className="mini-roster">
            {snapshot.units.map((unit) => <span key={unit.id}>{unit.name}: {unit.hp} HP</span>)}
          </div>
        </aside>
      </section>
    </main>
  );
}
