import { defineConfig } from 'vite';

// Phase 1 scaffold only. The real dashboard arrives in Phase 2 (T-2.5/T-2.6).
// Dev proxy so the stub can reach the local API without CORS work.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4310',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
