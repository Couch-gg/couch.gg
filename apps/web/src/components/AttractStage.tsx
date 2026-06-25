import { useEffect, useRef } from 'react';

interface AttractStageProps {
  className?: string;
}

declare global {
  interface Window {
    Phaser?: unknown;
  }
}

// Import a browser ES module by literal path WITHOUT letting Vite rewrite or
// pre-bundle the specifier. The `new Function` indirection hides the dynamic
// import() from Vite's static analysis so `/shared/...` and `/js/...` resolve
// against the served public assets at runtime. (Same trick as TrebuchetStage.)
const importBrowserModule = (path: string): Promise<any> => {
  const loader = new Function('path', 'return import(path)') as (path: string) => Promise<any>;
  return loader(path);
};

export function AttractStage({ className }: AttractStageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let game: { destroy: (removeCanvas: boolean) => void } | null = null;

    void (async () => {
      const PhaserModule = await import('phaser');
      const Phaser = (PhaserModule as unknown as { default?: unknown }).default ?? PhaserModule;
      (window as any).Phaser = Phaser;

      const [constantsModule, attractModule] = await Promise.all([
        importBrowserModule('/shared/constants.js'),
        importBrowserModule('/js/scenes/attract.js')
      ]);

      if (cancelled || !containerRef.current) return;

      const Attract = attractModule.Attract;
      const WORLD_W = constantsModule.WORLD_W as number;
      const WORLD_H = constantsModule.WORLD_H as number;

      game = new (Phaser as any).Game({
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
        scene: [Attract]
      });

      // If the effect was torn down while phaser/constants were still loading,
      // the game was created after `cancelled` flipped — destroy it immediately
      // so we never leak a running Phaser instance.
      if (cancelled) {
        game?.destroy(true);
        game = null;
      }
    })();

    return () => {
      cancelled = true;
      game?.destroy(true);
      game = null;
    };
  }, []);

  return <div className={className ?? 'attract-stage'} ref={containerRef} />;
}
