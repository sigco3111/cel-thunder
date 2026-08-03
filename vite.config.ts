import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5233,
    host: true,
    proxy: {
      // The authoritative game server runs separately on 8791.
      '/ws': { target: 'ws://localhost:8791', ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes('node_modules/three') ? 'three' : undefined),
      },
    },
  },
});
