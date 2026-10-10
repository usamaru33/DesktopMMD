import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

const shared = resolve(__dirname, 'src/shared');

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    publicDir: resolve(__dirname, 'src/renderer/public'),
    resolve: { alias: { '@shared': shared } },
    esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
    build: {
      // the AudioWorklet module must be a real file: CSP forbids data: scripts
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          character: resolve(__dirname, 'src/renderer/character/index.html'),
          admin: resolve(__dirname, 'src/renderer/admin/index.html'),
        },
      },
    },
  },
});
