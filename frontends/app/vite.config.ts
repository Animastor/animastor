import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [preact()],
  resolve: {
    alias: {
      '@animastor/navigator': resolve(__dirname, '../../packages/animastor-navigator/src'),
    },
  },
  server: {
    // Proxy /api to the local dev backend; in production nginx handles this.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/gpu': { target: 'http://localhost:5000', changeOrigin: true }
    }
  },
  build: {
    outDir: 'dist',
    target: 'es2020'
  }
});
