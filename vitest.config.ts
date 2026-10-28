import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: process.cwd(),
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 10_000 },
});
