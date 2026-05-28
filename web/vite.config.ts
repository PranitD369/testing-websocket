import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The Fastify server serves the built React app under `/app`. Setting `base: '/app/'`
// means asset URLs in the production HTML are written as `/app/assets/...` so the
// static handler resolves them correctly. In dev we use the vite server at `/`.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/app/' : '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Gemini Live Reliability Lab',
        short_name: 'GLL Lab',
        description: 'Reliability tester for the Gemini Live WebSocket proxy.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/app/',
        scope: '/app/',
        icons: [
          { src: '/app/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/app/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/app/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Don't cache the WS / fallback paths - they must always go to the network.
        navigateFallbackDenylist: [/^\/ws/, /^\/fallback/, /^\/health/],
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      // Fastify backend in dev. Both paths support WebSocket upgrades.
      '/ws': { target: 'ws://localhost:3000', ws: true },
      '/fallback': { target: 'http://localhost:3000' },
      '/health': { target: 'http://localhost:3000' },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
}));
