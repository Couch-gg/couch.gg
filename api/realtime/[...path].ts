import { createRealtimeServer } from '@couch/realtime';

const { server } = createRealtimeServer({
  apiPrefix: '/api/realtime',
  socketPath: '/api/realtime/socket.io',
  websocketOnly: true
});

export default server;
