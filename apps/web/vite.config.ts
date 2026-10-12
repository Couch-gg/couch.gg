import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    // On any host other than localhost/127.0.0.1/0.0.0.0 (e.g. the LAN IP a TV
    // or phone opens) the client talks to its own origin under /api/realtime,
    // as in production. Forward that to the local realtime server and strip the
    // prefix it only has on Vercel. `vite preview` reuses this proxy.
    proxy: {
      '/api/realtime': {
        target: 'http://127.0.0.1:4100',
        ws: true,
        rewrite: (path) =>
          path.replace(/^\/api\/realtime\/socket\.io/, '/socket.io').replace(/^\/api\/realtime/, '/api')
      }
    }
  },
  preview: {
    port: 4173,
    host: '0.0.0.0'
  }
});
