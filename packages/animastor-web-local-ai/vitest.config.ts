import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'react': 'preact/compat',
      'react/jsx-runtime': 'preact/jsx-runtime',
      'react/jsx-dev-runtime': 'preact/jsx-runtime',
    },
  },
  oxc: {
    jsx: {
      runtime: 'automatic',
      jsxImportSource: 'preact',
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
