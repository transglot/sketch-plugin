import { defineConfig } from 'vitest/config';

// Isolated config: this package tests only the PURE modules (api/keys/plan) under Node —
// zero Sketch-runtime coupling (the repo-root vitest excludes packages/**). The host
// adapter (commands.ts) needs the real Sketch runtime and is covered by the README
// manual checklist, not vitest.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
});
