import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import type { Server } from 'socket.io';

// Cross-instance broadcast. On Vercel the TV and the phones of one lobby can be
// connected to different Function instances; without an adapter a room emit only
// reaches sockets on the emitting instance and everyone else waits for the 750ms
// lobby poll. The Redis adapter publishes every room emit over Redis pub/sub so
// each instance delivers it to its own sockets.
//
// Attaching is async (two Redis connections). Until it resolves, emits stay
// instance-local, which is exactly the old behaviour, so callers don't wait.
export type FanoutMode = 'redis' | 'local';

export interface Fanout {
  mode(): FanoutMode;
  ready: Promise<FanoutMode>;
}

export function attachFanout(io: Server, redisUrl = process.env.REDIS_URL): Fanout {
  let mode: FanoutMode = 'local';
  if (!redisUrl) return { mode: () => mode, ready: Promise.resolve(mode) };

  const pub = createClient({ url: redisUrl });
  const sub = pub.duplicate();
  pub.on('error', (err: unknown) => console.error('Redis fan-out (pub) error', err));
  sub.on('error', (err: unknown) => console.error('Redis fan-out (sub) error', err));

  const ready = Promise.all([pub.connect(), sub.connect()])
    .then(() => {
      io.adapter(createAdapter(pub, sub, { key: 'couch:sio' }));
      mode = 'redis';
      return mode;
    })
    .catch((err: unknown) => {
      console.error('Redis fan-out unavailable, staying instance-local', err);
      return mode;
    });

  return { mode: () => mode, ready };
}
