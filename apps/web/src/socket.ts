import { io, type Socket } from 'socket.io-client';
import { REALTIME_SOCKET_PATH, REALTIME_URL } from './api.js';

export function createSocket(): Socket {
  return io(REALTIME_URL, {
    path: REALTIME_SOCKET_PATH,
    transports: ['websocket'],
    reconnection: true,
    // Keep trying indefinitely: a phone can be asleep for minutes and must
    // reconnect whenever it wakes, not give up after a handful of attempts.
    reconnectionAttempts: Infinity,
    reconnectionDelay: 400,
    reconnectionDelayMax: 5000
  });
}

// Emit an event and wait for the server's ack. Settles exactly once: with the
// ack, or with an error after 8 s. While the socket is down the event waits
// for the next connect (socket.io keeps retrying, so one failed attempt is no
// reason to give up), and once the call has failed it is never sent anymore:
// a caller that retries must not end up having it run twice.
export function emitAck<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = () => {
      settled = true;
      window.clearTimeout(timeout);
      socket.off('connect', send);
    };
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settle();
      reject(new Error('Realtime connection timed out'));
    }, 8_000);
    function send() {
      socket.off('connect', send);
      socket.emit(event, payload, (response: T & { ok?: boolean; error?: string; status?: number }) => {
        if (settled) return;
        settle();
        if (response && response.ok === false) {
          // Keep the server's status (403, 409, ...) for callers that react to it.
          reject(Object.assign(new Error(response.error || 'Socket event failed'), { status: response.status }));
          return;
        }
        resolve(response);
      });
    }
    if (socket.connected) send();
    else socket.on('connect', send);
  });
}
