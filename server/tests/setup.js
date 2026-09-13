import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

/**
 * Test environment.
 *
 * The real .env lives at the repo root, one level above this workspace, so load
 * it explicitly — vitest runs with cwd=server/ and dotenv would not find it.
 * Anything still missing falls back to local defaults, which is what CI relies on
 * (GitHub Actions service containers export these directly).
 *
 * Must run before any module imports config/env.js, whose zod schema would
 * otherwise exit the process.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
config({ path: path.join(repoRoot, '.env') });

// Forced, not defaulted: the repo .env sets a developer-friendly LOG_LEVEL and a
// production bcrypt cost, neither of which belongs in a test run.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL ||= 'postgresql://postgres:postgres@localhost:5432/relay_test';
process.env.MONGO_URL ||= 'mongodb://localhost:27017/relay_test';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.JWT_SECRET ||= 'test-secret-that-is-at-least-32-characters-long';
// Keep hashing cheap in tests; production cost lives in .env.
process.env.BCRYPT_ROUNDS = '4';
