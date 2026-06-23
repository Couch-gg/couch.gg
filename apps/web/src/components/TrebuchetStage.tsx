import { useEffect, useRef } from 'react';
import type { TrebuchetEvent, TrebuchetShotEvent, TrebuchetSnapshot } from '@couch/trebuchet';

interface StageProps {
  snapshot: TrebuchetSnapshot | null;
  event?: TrebuchetEvent | { type: 'snapshot'; snapshot: TrebuchetSnapshot } | null;
  compact?: boolean;
}

type StageApi = {
  setSnapshot: (snapshot: TrebuchetSnapshot | null, event: StageProps['event']) => void;
  destroy: () => void;
};

const teamColors = [0xe8554d, 0x4d9be8, 0x5dc961, 0xe8c44d, 0xd47cff, 0x62d5d5, 0xff935c, 0xf2f2f2];

export function TrebuchetStage({ snapshot, event, compact = false }: StageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<StageApi | null>(null);
  const latestRef = useRef<{ snapshot: TrebuchetSnapshot | null; event: StageProps['event'] }>({ snapshot, event });

  useEffect(() => {
    let cancelled = false;
    let api: StageApi | null = null;

    import('phaser').then((PhaserModule) => {
      const Phaser = (PhaserModule as unknown as { default?: typeof PhaserModule }).default ?? PhaserModule;
      if (cancelled || !containerRef.current) return;

      class CouchTrebuchetScene extends Phaser.Scene {
        private graphics!: Phaser.GameObjects.Graphics;
        private textLayer: Phaser.GameObjects.Text[] = [];
        private current: TrebuchetSnapshot | null = latestRef.current.snapshot;
        private lastEvent: StageProps['event'] = latestRef.current.event;

        create() {
          this.graphics = this.add.graphics();
          this.draw();
        }

        setSnapshot(next: TrebuchetSnapshot | null, nextEvent: StageProps['event']) {
          this.current = next;
          this.lastEvent = nextEvent;
          this.draw();
        }

        private draw() {
          if (!this.graphics) return;
          this.graphics.clear();
          for (const label of this.textLayer) label.destroy();
          this.textLayer = [];

          this.graphics.fillGradientStyle(0x121817, 0x121817, 0x26251b, 0x101212, 1);
          this.graphics.fillRect(0, 0, 960, 540);
          this.graphics.fillStyle(0xf1cf6a, 0.08);
          this.graphics.fillCircle(780, 80, 54);

          if (!this.current || this.current.heights.length === 0) {
            this.label(480, 245, 'Trebuchet wartet auf Spieler', 24, '#f8edcf', 'center');
            this.label(480, 284, 'Starte eine Lobby oder nutze diese Route als Testfeld', 14, '#aeb9a3', 'center');
            return;
          }

          this.drawTerrain(this.current);
          this.drawCastles(this.current);
          this.drawUnits(this.current);
          this.drawTrajectory(this.lastEvent);
          this.drawHud(this.current);
        }

        private drawTerrain(snapshot: TrebuchetSnapshot) {
          const points: number[] = [0, 540];
          snapshot.heights.forEach((height, x) => {
            points.push(x * 2, height * 2);
          });
          points.push(960, 540);
          this.graphics.fillStyle(0x55452d, 1);
          this.graphics.fillPoints(toPoints(points, Phaser), true);
          this.graphics.lineStyle(3, 0xc7a96f, 0.85);
          for (let x = 1; x < snapshot.heights.length; x++) {
            this.graphics.lineBetween((x - 1) * 2, snapshot.heights[x - 1] * 2, x * 2, snapshot.heights[x] * 2);
          }
        }

        private drawCastles(snapshot: TrebuchetSnapshot) {
          for (const castle of snapshot.castles) {
            const owner = snapshot.units.find((unit) => unit.id === castle.id);
            const color = owner ? teamColors[owner.colorIdx % teamColors.length] : 0xcbb986;
            this.graphics.fillStyle(0x2b2f2b, 0.95);
            this.graphics.lineStyle(1, color, 0.8);
            for (const block of castle.blocks) {
              if (block.destroyed) continue;
              this.graphics.fillRect(block.x * 2, block.y * 2, Math.max(2, block.w * 2), Math.max(2, block.h * 2));
              this.graphics.strokeRect(block.x * 2, block.y * 2, Math.max(2, block.w * 2), Math.max(2, block.h * 2));
            }
          }
        }

        private drawUnits(snapshot: TrebuchetSnapshot) {
          for (const unit of snapshot.units) {
            const color = teamColors[unit.colorIdx % teamColors.length];
            const x = unit.x * 2;
            const y = unit.y * 2;
            this.graphics.fillStyle(color, unit.alive ? 1 : 0.3);
            this.graphics.fillCircle(x, y - 18, 13);
            this.graphics.fillRect(x - 20, y - 16, 40, 14);
            this.graphics.lineStyle(4, 0x1b1b18, 0.8);
            this.graphics.lineBetween(x - 4, y - 26, x + (unit.colorIdx % 2 === 0 ? 34 : -34), y - 58);
            if (snapshot.turn === unit.id) {
              this.graphics.lineStyle(3, 0xf1cf6a, 1);
              this.graphics.strokeCircle(x, y - 22, 23);
            }
            this.label(x, y - 62, `${unit.name} · ${unit.hp}`, 12, unit.alive ? '#f8edcf' : '#7d837a', 'center');
          }
        }

        private drawTrajectory(nextEvent: StageProps['event']) {
          if (!nextEvent || nextEvent.type !== 'shot') return;
          const shot = nextEvent as TrebuchetShotEvent;
          if (shot.trajectory.length < 2) return;
          this.graphics.lineStyle(2, 0xf1cf6a, 0.85);
          for (let i = 1; i < shot.trajectory.length; i++) {
            const [ax, ay] = shot.trajectory[i - 1];
            const [bx, by] = shot.trajectory[i];
            this.graphics.lineBetween(ax * 2, ay * 2, bx * 2, by * 2);
          }
          if (shot.result.impact) {
            this.graphics.fillStyle(0xff815c, 0.9);
            this.graphics.fillCircle(shot.result.impact.x * 2, shot.result.impact.y * 2, 9);
          }
        }

        private drawHud(snapshot: TrebuchetSnapshot) {
          const turn = snapshot.units.find((unit) => unit.id === snapshot.turn);
          this.label(24, 24, 'TREBUCHET', 22, '#f8edcf', 'left');
          this.label(24, 56, turn ? `Turn: ${turn.name}` : snapshot.winner ? `Winner: ${snapshot.units.find((unit) => unit.id === snapshot.winner)?.name ?? 'Player'}` : 'Game over', 15, '#f1cf6a', 'left');
          this.label(936, 24, `Wind ${snapshot.wind > 0 ? '+' : ''}${snapshot.wind}`, 16, '#d8ebe1', 'right');
          if (snapshot.draw) this.label(480, 72, 'DRAW', 28, '#f1cf6a', 'center');
        }

        private label(x: number, y: number, text: string, size: number, color: string, align: 'left' | 'center' | 'right') {
          const label = this.add
            .text(x, y, text, {
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: `${size}px`,
              color,
              align
            })
            .setOrigin(align === 'center' ? 0.5 : align === 'right' ? 1 : 0, 0);
          this.textLayer.push(label);
        }
      }

      const game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: containerRef.current,
        width: 960,
        height: 540,
        backgroundColor: 'transparent',
        scene: CouchTrebuchetScene,
        scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }
      });

      api = {
        setSnapshot(next, nextEvent) {
          const scene = game.scene.getScene('CouchTrebuchetScene') as InstanceType<typeof CouchTrebuchetScene>;
          scene?.setSnapshot(next, nextEvent);
        },
        destroy() {
          game.destroy(true);
        }
      };
      apiRef.current = api;
      api.setSnapshot(latestRef.current.snapshot, latestRef.current.event);
    });

    return () => {
      cancelled = true;
      api?.destroy();
      apiRef.current = null;
    };
    // Phaser owns this instance; snapshots flow through the next effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    latestRef.current = { snapshot, event };
    apiRef.current?.setSnapshot(snapshot, event);
  }, [snapshot, event]);

  return (
    <div
      className={compact ? 'trebuchet-stage compact' : 'trebuchet-stage'}
      ref={containerRef}
      data-testid="trebuchet-stage"
      data-phase={snapshot?.phase ?? 'empty'}
    >
      {snapshot ? <TrebuchetSvg snapshot={snapshot} event={event} /> : null}
    </div>
  );
}

function toPoints(values: number[], Phaser: any) {
  const points = [];
  for (let i = 0; i < values.length; i += 2) {
    points.push(new Phaser.Geom.Point(values[i], values[i + 1]));
  }
  return points;
}

function TrebuchetSvg({ snapshot, event }: { snapshot: TrebuchetSnapshot; event: StageProps['event'] }) {
  const terrainPath = `M 0 270 ${snapshot.heights.map((height, x) => `L ${x} ${height.toFixed(2)}`).join(' ')} L 480 270 Z`;
  const shot = event?.type === 'shot' ? (event as TrebuchetShotEvent) : null;
  const trajectory = shot?.trajectory.map(([x, y]) => `${x},${y}`).join(' ');
  const turn = snapshot.units.find((unit) => unit.id === snapshot.turn);

  return (
    <svg className="trebuchet-svg" viewBox="0 0 480 270" role="img" aria-label="Trebuchet battlefield">
      <defs>
        <linearGradient id="couch-sky" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#121817" />
          <stop offset="100%" stopColor="#1c1d16" />
        </linearGradient>
        <filter id="soft-shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" floodColor="#000" floodOpacity="0.35" />
        </filter>
      </defs>
      <rect width="480" height="270" fill="url(#couch-sky)" />
      <circle cx="390" cy="56" r="28" fill="#f1cf6a" opacity="0.08" />
      <path d={terrainPath} fill="#5b482c" stroke="#c7a96f" strokeWidth="1.4" />
      {snapshot.castles.map((castle) => {
        const owner = snapshot.units.find((unit) => unit.id === castle.id);
        const color = colorFor(owner?.colorIdx ?? 0);
        return (
          <g key={castle.id ?? Math.random()} filter="url(#soft-shadow)">
            {castle.blocks.map((block, index) =>
              block.destroyed ? null : (
                <rect
                  key={index}
                  x={block.x}
                  y={block.y}
                  width={Math.max(1, block.w)}
                  height={Math.max(1, block.h)}
                  fill="#20251f"
                  stroke={color}
                  strokeWidth="0.25"
                />
              )
            )}
          </g>
        );
      })}
      {trajectory ? <polyline points={trajectory} fill="none" stroke="#f1cf6a" strokeWidth="1.2" strokeDasharray="2 3" /> : null}
      {shot?.result.impact ? <circle cx={shot.result.impact.x} cy={shot.result.impact.y} r="3.5" fill="#ff815c" /> : null}
      {snapshot.units.map((unit) => (
        <g key={unit.id} opacity={unit.alive ? 1 : 0.4} filter="url(#soft-shadow)">
          <circle cx={unit.x} cy={unit.y - 9} r="6" fill={colorFor(unit.colorIdx)} />
          <rect x={unit.x - 10} y={unit.y - 8} width="20" height="8" rx="1" fill={colorFor(unit.colorIdx)} />
          <line x1={unit.x - 2} y1={unit.y - 12} x2={unit.x + (unit.colorIdx % 2 === 0 ? 17 : -17)} y2={unit.y - 28} stroke="#111" strokeWidth="2" />
          {snapshot.turn === unit.id ? <circle cx={unit.x} cy={unit.y - 10} r="11" fill="none" stroke="#f1cf6a" strokeWidth="2" /> : null}
          <text x={unit.x} y={unit.y - 32} textAnchor="middle" fill="#f8edcf" fontSize="7" fontFamily="monospace">
            {unit.name} · {unit.hp}
          </text>
        </g>
      ))}
      <text x="14" y="20" fill="#f8edcf" fontSize="14" fontFamily="monospace" fontWeight="700">TREBUCHET</text>
      <text x="14" y="37" fill="#f1cf6a" fontSize="9" fontFamily="monospace">
        {turn ? `Turn: ${turn.name}` : snapshot.winner ? 'Winner' : 'Game over'}
      </text>
      <text x="464" y="20" textAnchor="end" fill="#d8ebe1" fontSize="10" fontFamily="monospace">
        Wind {snapshot.wind > 0 ? '+' : ''}{snapshot.wind}
      </text>
    </svg>
  );
}

function colorFor(index: number): string {
  const color = teamColors[index % teamColors.length].toString(16).padStart(6, '0');
  return `#${color}`;
}
