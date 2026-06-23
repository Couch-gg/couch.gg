// Dev/test helper: raw TCP forwarder so a second browser preview can reach the
// game server under a different port (HTTP and WebSocket both pass through).
// Usage: PORT=3001 TARGET=3000 node scripts/tcp-proxy.js
import net from 'node:net';

const PORT = Number(process.env.PORT || 3001);
const TARGET = Number(process.env.TARGET || 3000);

const server = net.createServer((client) => {
  const upstream = net.connect(TARGET, '127.0.0.1');
  client.pipe(upstream);
  upstream.pipe(client);
  const kill = () => { client.destroy(); upstream.destroy(); };
  client.on('error', kill);
  upstream.on('error', kill);
});

server.listen(PORT, () => {
  console.log(`tcp-proxy: ${PORT} -> ${TARGET}`);
});
