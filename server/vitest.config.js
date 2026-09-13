import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.js'],
    // Integration tests share real databases, so they must not race each other.
    fileParallelism: false,
    // These talk to managed databases in remote regions — a single test can make
    // a dozen sequential round trips. The default 5s is a latency limit, not a
    // correctness one, and failing on it hides real results.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
