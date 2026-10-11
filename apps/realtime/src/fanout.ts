import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import type { Server, Socket } from 'socket.io';

// Cross-instance broadcast. On Vercel the TV and the phones of one lobby can be
// connected to different Function instances; without an adapter a room emit only
// reaches sockets on the emitting instance and everyone else waits for the 750ms
// lobby poll. The Redis adapter publishes every room emit over Redis pub/sub so
// each instance delivers it to its own sockets.
//
// Attaching is async (two Redis connections). Until it resolves, emits stay
// instance-local, which is exactly the old behaviour, so callers don't wait.
// Sockets that connect in the meantime are moved over by swapAdapter.
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
      swapAdapter(io, createAdapter(pub, sub, { key: 'couch:sio' }));
      mode = 'redis';
      return mode;
    })
    .catch((err: unknown) => {
      console.error('Redis fan-out unavailable, staying instance-local', err);
      return mode;
    });

  return { mode: () => mode, ready };
}

// io.adapter() gives every namespace a fresh, empty adapter, and each socket keeps
// a reference to the adapter it was created with. A TV that connected while Redis
// was still connecting would drop out of its lobby room for the whole session:
// its memberships stay behind in the old adapter, and so would its later joins
// and leaves. So copy the memberships over and point those sockets at the new one.
function swapAdapter(io: Server, adapter: ReturnType<typeof createAdapter>): void {
  const before = [...io._nsps.values()].map((nsp) => ({ nsp, sids: new Map(nsp.adapter.sids) }));
  io.adapter(adapter);
  for (const { nsp, sids } of before) {
    for (const [id, rooms] of sids) nsp.adapter.addAll(id, rooms);
    // Sockets still in connect middleware are created but not yet in nsp.sockets.
    const pending = (nsp as unknown as { _preConnectSockets?: Map<string, Socket> })._preConnectSockets;
    for (const socket of [...nsp.sockets.values(), ...(pending?.values() ?? [])]) {
      (socket as unknown as { adapter: typeof nsp.adapter }).adapter = nsp.adapter;
    }
  }
}
