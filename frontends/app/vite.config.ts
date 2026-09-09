import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  resolve: {
    // The extracted @animastor/file and @animastor/navigator packages carry
    // their own node_modules with a second preact copy. Without dedupe their
    // hooks render against a foreign component tree
    // ("Cannot read properties of undefined (reading '__H')") and the app
    // mounts to a blank page. Every preact import resolves to the app's
    // single instance.
    dedupe: ['preact', 'preact/hooks', 'preact/jsx-runtime', 'preact/jsx-dev-runtime', 'preact/compat', '@preact/signals']
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
