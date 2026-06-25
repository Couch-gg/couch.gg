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

export function emitAck<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Realtime connection timed out')), 8_000);
    const send = () => socket.emit(event, payload, (response: T & { ok?: boolean; error?: string }) => {
      window.clearTimeout(timeout);
      if (response && response.ok === false) {
        reject(new Error(response.error || 'Socket event failed'));
        return;
      }
      resolve(response);
    });
    if (socket.connected) {
      send();
    } else {
      socket.once('connect', send);
      socket.once('connect_error', (err) => {
        window.clearTimeout(timeout);
        reject(err);
      });
    }
  });
}
