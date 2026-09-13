import Redis from 'ioredis';
import { env } from './env.js';
import { logger } from '../lib/logger.js';

/**
 * Three clients, deliberately.
 *
 * A Redis connection in subscriber mode cannot issue normal commands. So the
 * socket.io adapter gets a dedicated `pub` and `sub` pair, and everything else —
 * presence leases, rate-limit counters — goes through a third `cmd` client.
 * Trying to SET on the subscriber is the classic mistake here.
 */
const options = {
  maxRetriesPerRequest: null, // required by the adapter; let ioredis retry forever
  enableReadyCheck: true,
  lazyConnect: true,
};

export const pub = new Redis(env.REDIS_URL, options);
export const sub = pub.duplicate();
export const cmd = new Redis(env.REDIS_URL, options);

for (const [name, client] of Object.entries({ pub, sub, cmd })) {
  client.on('error', (err) => logger.error({ err, client: name }, 'redis error'));
}

export async function connectRedis() {
  await Promise.all([pub.connect(), sub.connect(), cmd.connect()]);
  logger.info('redis connected (pub/sub/cmd)');
}

export async function disconnectRedis() {
  await Promise.allSettled([pub.quit(), sub.quit(), cmd.quit()]);
}

export async function pingRedis() {
  await cmd.ping();
  return true;
}
