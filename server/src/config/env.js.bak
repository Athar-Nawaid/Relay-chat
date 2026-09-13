import 'dotenv/config';
import { z } from 'zod';

/**
 * Fail fast and loudly on misconfiguration. A missing REDIS_URL should kill the
 * process at boot with a readable message, not surface as a confusing socket
 * adapter error twenty minutes into a demo.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (Postgres, pooled)'),
  // Only needed by the Prisma CLI for migrations, so optional at runtime.
  DIRECT_URL: z.string().optional(),
  MONGO_URL: z.string().min(1, 'MONGO_URL is required (MongoDB)'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required (Redis, TCP endpoint)'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`\nInvalid environment configuration:\n${issues}\n\nSee .env.example.\n`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
