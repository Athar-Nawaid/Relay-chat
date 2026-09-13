import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The proxy makes development same-origin, exactly as production is (where
 * Express serves the built client). That single choice removes CORS from the
 * project entirely and lets the refresh cookie stay first-party with
 * SameSite=Lax — no credentials juggling, no preflight, no origin allowlist.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      // ws:true is required — without it the socket handshake 404s and the
      // client silently falls back to failing forever.
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
