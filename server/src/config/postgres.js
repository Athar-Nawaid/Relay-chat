import { PrismaClient } from '@prisma/client';
import { env, isProd } from './env.js';
import { logger } from '../lib/logger.js';

export const prisma = new PrismaClient({
  log: isProd ? ['warn', 'error'] : ['warn', 'error'],
  datasources: { db: { url: env.DATABASE_URL } },
});

export async function connectPostgres() {
  await prisma.$connect();
  logger.info('postgres connected');
}

export async function disconnectPostgres() {
  await prisma.$disconnect();
}

export async function pingPostgres() {
  await prisma.$queryRaw`SELECT 1`;
  return true;
}
