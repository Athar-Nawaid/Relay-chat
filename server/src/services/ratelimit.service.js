import { cmd } from '../config/redis.js';

/**
 * Fixed-window counter in Redis.
 *
 * Shared across instances — which is the point, since a per-process limiter is
 * trivially bypassed by reconnecting until you land on a different server.
 *
 * A fixed window allows up to 2x the limit across a boundary; a sliding window
 * or token bucket would be stricter. For flood control on a chat message that is
 * an entirely acceptable trade for one INCR.
 */
export async function consume({ key, limit, windowSeconds }) {
  const redisKey = `rate:${key}`;

  const results = await cmd.multi().incr(redisKey).expire(redisKey, windowSeconds, 'NX').exec();
  const count = results?.[0]?.[1] ?? 0;

  return { allowed: count <= limit, count, limit };
}
