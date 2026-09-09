/**
 * Vite configuration.
 *
 * Two deployment shapes have to come out of this one config, and they differ in
 * exactly two variables:
 *
 *  - **GitHub Pages** — the SPA is served from `https://<user>.github.io/<repo>/`,
 *    so every asset URL needs the repo name prefixed (`base`), and the API lives
 *    on another host entirely (`VITE_API_BASE_URL` is an absolute origin).
 *  - **EC2 single-origin** — the API serves `dist/` itself, so `base` is `/` and
 *    `VITE_API_BASE_URL` is empty, meaning "same origin as this page".
 *
 * Both are build-time values because Vite inlines `import.meta.env` into the
 * bundle; there is no runtime config file to read, and adding one would mean an
 * extra request before the app can make its first call.
 */

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Where the API runs during `npm run dev`.
 *
 * The dev server proxies `/api` here so the browser sees one origin and CORS
 * never enters the picture locally — which also means the dev build exercises
 * the same "empty base URL" path the EC2 build uses.
 */
const DEV_API_TARGET = process.env.DEV_API_TARGET ?? 'http://127.0.0.1:8080';

export default defineConfig({
  // Set by the Pages workflow to `/<repo>/`. Anything else wants the default.
  base: process.env.VITE_BASE_PATH ?? '/',

  plugins: [react(), tailwindcss()],

  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: DEV_API_TARGET,
        changeOrigin: true,
        // The run event stream must not be buffered by the dev proxy, or search
        // progress arrives in one lump when the run finishes — which is the one
        // moment it is no longer useful.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['x-accel-buffering'] = 'no';
            }
          });
        },
      },
    },
  },

  build: {
    outDir: 'dist',
    // Kept on: the bundle is served from a private, single-user deployment, and
    // a readable stack trace is worth more here than the few hundred kilobytes
    // of .map files nobody downloads unless DevTools is open.
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        // These three change far less often than the app code, so splitting them
        // out means a UI tweak does not invalidate a megabyte of cached vendor
        // JavaScript. Every name here must be a real dependency — Rollup treats
        // a manual chunk as an entry module and fails the build outright if it
        // cannot resolve one, which is how a leftover `@tanstack/react-table`
        // announced itself after the leads table stopped using it.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          virtual: ['@tanstack/react-virtual'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
});
