import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src',
  base: './',
  resolve: {
    alias: {
      // Use platform-web TypeScript source directly so Vite/esbuild can
      // resolve its named exports. The CommonJS build output is not reliably
      // analysed by Rollup for named exports.
      '@ziner/platform-web': resolve(__dirname, '../../packages/platform-web/src/index.ts'),
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/index.html'),
      },
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  optimizeDeps: {
  },
});
