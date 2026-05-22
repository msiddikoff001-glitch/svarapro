import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import svgr from 'vite-plugin-svgr';

/**
 * Vite config for the redesigned Svara client.
 *
 * Inherits the v143 prototype's chunking and `@` alias so the build output
 * stays predictable. Keeps the PWA plugin and SVGR transform from the
 * previous svarapro client so we don't regress on icon imports and the
 * standalone app install flow.
 */
export default defineConfig({
  plugins: [
    react(),
    svgr(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: /\.(js|css)$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'static-resources',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'Svara',
        short_name: 'Svara',
        theme_color: '#17212b',
        background_color: '#17212b',
        display: 'standalone',
        icons: [{ src: '/logo.png', sizes: '192x192', type: 'image/png' }],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      // Forward `/api/*` and `/socket.io/*` straight to the NestJS backend
      // without stripping the prefix. Nest mounts everything under
      // `app.setGlobalPrefix('api/v1')`, so a client request like
      // `/api/v1/auth/login` reaches the backend untouched. The previous
      // `rewrite: (p) => p.replace(/^\/api/, '')` dropped the `/api`, leaving
      // `/v1/auth/login` which the server doesn't expose.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('lottie-web')) return 'lottie';
            if (id.includes('react') || id.includes('scheduler')) return 'react';
            return 'vendor';
          }
          return undefined;
        },
      },
    },
  },
});
