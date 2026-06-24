import { useEffect, useRef } from 'react';
import type { TrebuchetEvent, TrebuchetSnapshot } from '@couch/trebuchet';

interface StageProps {
  snapshot: TrebuchetSnapshot | null;
  event?: TrebuchetEvent | { type: 'snapshot'; snapshot: TrebuchetSnapshot } | null;
  controlEvent?: TrebuchetControlEvent | null;
  compact?: boolean;
  onOriginalSend?: (message: OriginalClientMessage) => void;
}

export interface TrebuchetControlEvent {
  playerId: string;
  control: 'trebuchet.aim' | 'trebuchet.charge' | string;
  value: unknown;
  timestamp?: number;
}

interface OriginalClientMessage {
  t?: string;
  angle?: number;
  power?: number;
}

interface OriginalNet {
  you: string | null;
  code: string | null;
  connect: () => void;
  emit: (type: string, payload: unknown) => void;
  on: (type: string, fn: (payload: unknown) => void) => void;
  off: (type: string, fn: (payload: unknown) => void) => void;
}

interface StageApi {
  sync: (
    snapshot: TrebuchetSnapshot | null,
    event: StageProps['event'],
    controlEvent: TrebuchetControlEvent | null
  ) => void;
  destroy: () => void;
}

declare global {
  interface Window {
    Phaser?: unknown;
    __couchTrebuchetBridge?: {
      send?: (message: OriginalClientMessage) => void;
    };
    __couchTrebuchetNet?: OriginalNet;
  }
}

const importBrowserModule = (path: string): Promise<any> => {
  const loader = new Function('path', 'return import(path)') as (path: string) => Promise<any>;
  return loader(path);
};

export function TrebuchetStage({ snapshot, event, controlEvent = null, compact = false, onOriginalSend }: StageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<StageApi | null>(null);
  const onOriginalSendRef = useRef(onOriginalSend);
  const latestRef = useRef({ snapshot, event, controlEvent });

  useEffect(() => {
    onOriginalSendRef.current = onOriginalSend;
  }, [onOriginalSend]);

  useEffect(() => {
    let cancelled = false;
    let api: StageApi | null = null;

    window.__couchTrebuchetBridge = {
      send(message) {
        onOriginalSendRef.current?.(message);
      }
    };

    void (async () => {
      const PhaserModule = await import('phaser');
      const Phaser = (PhaserModule as unknown as { default?: unknown }).default ?? PhaserModule;
      (window as any).Phaser = Phaser;

      const [constantsModule, bootModule, gameModule, netModule] = await Promise.all([
        importBrowserModule('/shared/constants.js'),
        importBrowserModule('/js/scenes/boot.js'),
        importBrowserModule('/js/scenes/game.js'),
        importBrowserModule('/js/net.js')
      ]);

      if (cancelled || !containerRef.current) return;

      const net = netModule.net as OriginalNet;
      const Boot = bootModule.Boot;
      const Game = gameModule.Game;
      const WORLD_W = constantsModule.WORLD_W as number;
      const WORLD_H = constantsModule.WORLD_H as number;
      let lastStartKey: string | null = null;
      let lastEvent: StageProps['event'] = null;
      let lastControlEvent: TrebuchetControlEvent | null = null;

      const game = new (Phaser as any).Game({
        type: (Phaser as any).AUTO,
        parent: containerRef.current,
        width: WORLD_W,
        height: WORLD_H,
        pixelArt: true,
        backgroundColor: '#0a0a12',
        scale: {
          mode: (Phaser as any).Scale.FIT,
          autoCenter: (Phaser as any).Scale.CENTER_BOTH
        },
        scene: [Boot, Game]
      });

      const startOriginalGame = (payload: OriginalStartPayload) => {
        net.you = payload.turn;
        net.code = payload.code ?? null;
        if (game.scene.isActive('Game') || game.scene.isSleeping('Game')) {
          game.scene.stop('Game');
        }
        game.scene.start('Game', payload);
      };

      const onStart = (payload: unknown) => startOriginalGame(payload as OriginalStartPayload);
      net.connect();
      net.on('start', onStart);

      api = {
        sync(nextSnapshot, nextEvent, nextControlEvent) {
          if (nextSnapshot) {
            const key = startKey(nextSnapshot);
            if (!lastStartKey || nextEvent?.type === 'start' || key !== lastStartKey) {
              lastStartKey = key;
              net.emit('start', toOriginalStart(nextSnapshot));
            }
          }

          if (nextEvent && nextEvent !== lastEvent) {
            lastEvent = nextEvent;
            if (nextEvent.type !== 'start') emitOriginalEvent(net, nextEvent);
          }

          if (nextControlEvent && nextControlEvent !== lastControlEvent) {
            lastControlEvent = nextControlEvent;
            if (nextSnapshot?.turn) net.you = nextSnapshot.turn;
            net.emit('control', {
              playerId: nextControlEvent.playerId,
              control: nextControlEvent.control,
              value: nextControlEvent.value,
              timestamp: nextControlEvent.timestamp
            });
          }
        },
        destroy() {
          net.off('start', onStart);
          game.destroy(true);
        }
      };

      apiRef.current = api;
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      if (cancelled) return;
      api.sync(latestRef.current.snapshot, latestRef.current.event, latestRef.current.controlEvent);
    })();

    return () => {
      cancelled = true;
      api?.destroy();
      apiRef.current = null;
    };
  }, []);

  useEffect(() => {
    latestRef.current = { snapshot, event, controlEvent };
    apiRef.current?.sync(snapshot, event, controlEvent);
  }, [snapshot, event, controlEvent]);

  return (
    <div
      className={compact ? 'trebuchet-stage compact' : 'trebuchet-stage'}
      ref={containerRef}
      data-testid="trebuchet-stage"
      data-phase={snapshot?.phase ?? 'empty'}
    />
  );
}

interface OriginalStartPayload {
  t: 'start';
  seed: number;
  players: Array<{ id: string; name: string; colorIdx: number; x: number; y: number; hp: number; alive?: boolean }>;
  turn: string | null;
  wind: number;
  turnEndsAt: number;
  heights: number[];
  castles: TrebuchetSnapshot['castles'];
  local: true;
  code?: string;
}

function toOriginalStart(snapshot: TrebuchetSnapshot): OriginalStartPayload {
  return {
    t: 'start',
    seed: snapshot.seed,
    players: snapshot.units.map((unit) => ({
      id: unit.id,
      name: unit.name,
      colorIdx: unit.colorIdx,
      x: unit.x,
      y: unit.y,
      hp: unit.hp,
      alive: unit.alive
    })),
    turn: snapshot.turn,
    wind: snapshot.wind,
    turnEndsAt: snapshot.turnEndsAt ?? 0,
    heights: snapshot.heights,
    castles: snapshot.castles,
    local: true
  };
}

function emitOriginalEvent(net: OriginalNet, event: StageProps['event']): void {
  if (!event) return;
  if (event.type === 'snapshot') {
    net.emit('start', toOriginalStart(event.snapshot));
    return;
  }
  if (event.type === 'start') {
    net.emit('start', toOriginalStart(event.snapshot));
    return;
  }
  if (event.type === 'shot') {
    net.you = event.next?.turn ?? null;
    net.emit('shot', {
      t: 'shot',
      shooterId: event.shooterId,
      angle: event.angle,
      power: event.power,
      wind: event.wind,
      trajectory: event.trajectory,
      result: event.result,
      next: event.next,
      winner: event.winner,
      draw: event.draw
    });
    return;
  }
  if (event.type === 'turn') {
    net.you = event.turn;
    net.emit('turn', {
      t: 'turn',
      turn: event.turn,
      wind: event.wind,
      turnEndsAt: event.turnEndsAt,
      skipped: event.skipped
    });
  }
}

function startKey(snapshot: TrebuchetSnapshot): string {
  return [snapshot.seed, snapshot.order.join(','), snapshot.units.map((unit) => unit.id).join(',')].join(':');
}
