import {defineConfig} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';
import {readFileSync} from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  define: {__APP_VERSION__: JSON.stringify(pkg.version)},
  build: {outDir: 'dist', emptyOutDir: true, target: 'es2020'},
  plugins: [
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      manifest: {
        name: 'Tiemvio POS', short_name: 'Tiemvio POS', lang: 'vi', start_url: '/', scope: '/', display: 'standalone',
        background_color: '#faf6f0', theme_color: '#1a3d34',
        icons: [
          {src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png'},
          {src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable'}
        ]
      },
      workbox: {
        importScripts: ['push-sw.js'],
        navigateFallback: '/index.html',
        // Downloads and static installation instructions must reach the network, never the POS app shell.
        navigateFallbackDenylist: [/^\/__\//, /\.mobileconfig(?:\?|$)/, /^\/install-ios\.html(?:\?|$)/, /^\/legal\.txt(?:\?|$)/],
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        runtimeCaching: [
          {urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\//, handler: 'CacheFirst', options: {cacheName: 'fonts', expiration: {maxEntries: 20, maxAgeSeconds: 31536000}}}
        ]
      }
    })
  ]
});
