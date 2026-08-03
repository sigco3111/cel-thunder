import { defineConfig } from 'vite';

/**
 * Set by the capture and playability harnesses. A browser test that runs for
 * two minutes will be full-reloaded out from under itself if anything at all
 * touches a source file in that window — an editor autosave, an indexer, a
 * formatter — and from the test's point of view that is indistinguishable from
 * the game crashing. Harnesses therefore run their own HMR-less server.
 */
const noHmr = process.env.CT_NO_HMR === '1';

export default defineConfig({
  server: {
    port: 5233,
    host: true,
    hmr: noHmr ? false : undefined,
    watch: {
      // The capture harnesses write PNGs into 'shots/' *while the page they
      // are driving is running*. Vite's watcher sees those and full-reloads
      // the tab mid-test, which looks exactly like the game crashing.
      ignored: ['**/shots/**', '**/dist/**', '**/refs/**', '**/tools/_scratch/**'],
    },
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
