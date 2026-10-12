import { createRealtimeServer, guardUnhandledRejections } from '@couch/realtime';

guardUnhandledRejections();

const { server } = createRealtimeServer({
  apiPrefix: '/api/realtime',
  socketPath: '/api/realtime/socket.io',
  websocketOnly: true
});

export default server;
