import { cmd } from '../config/redis.js';
import { prisma } from '../config/postgres.js';
import { instanceId } from '../lib/instanceId.js';
import { logger } from '../lib/logger.js';

/**
 * Presence is a lease, not a record.
 *
 * The original implementation stored online users as durable rows in MongoDB,
 * so a crash left "online" ghosts forever and needed a cleanup job that could
 * itself fail. Here every presence key carries a TTL that a heartbeat refreshes,
 * so a dead instance's users simply age out within TTL_SECONDS. There is no
 * cleanup job because there is no durable state to clean.
 *
 * The set members are `${instanceId}:${socketId}`, so one user may legitimately
 * be present from several tabs and several servers at once; they are offline
 * only when the set empties.
 */

const TTL_SECONDS = 45;
const HEARTBEAT_MS = 15_000;

const key = (userId) => `presence:conns:${userId}`;

export async function addConnection(userId, socketId, owner = instanceId) {
  const results = await cmd
    .multi()
    .sadd(key(userId), `${owner}:${socketId}`)
    .expire(key(userId), TTL_SECONDS)
    .scard(key(userId))
    .exec();

  const size = results?.[2]?.[1] ?? 0;
  return { becameOnline: size === 1 }; // first connection for this user
}

export async function removeConnection(userId, socketId, owner = instanceId) {
  const results = await cmd
    .multi()
    .srem(key(userId), `${owner}:${socketId}`)
    .scard(key(userId))
    .exec();

  const size = results?.[1]?.[1] ?? 0;

  if (size === 0) {
    // Best-effort "last seen"; a failure here must not break disconnect handling.
    await prisma.user
      .update({ where: { id: userId }, data: { lastSeenAt: new Date() } })
      .catch((err) => logger.warn({ err, userId }, 'failed to write lastSeenAt'));
  }

  return { becameOffline: size === 0 };
}

/** Bulk presence lookup in one round trip rather than one call per member. */
export async function onlineStatus(userIds) {
  if (userIds.length === 0) return new Map();

  const pipeline = cmd.pipeline();
  for (const id of userIds) pipeline.exists(key(id));
  const results = await pipeline.exec();

  return new Map(userIds.map((id, i) => [id, (results?.[i]?.[1] ?? 0) === 1]));
}

/**
 * Refreshes the TTL for every user connected to THIS instance.
 *
 * Deliberately per-instance rather than per-socket: one pipeline every
 * HEARTBEAT_MS regardless of how many sockets are attached, so the cost scales
 * with the number of servers rather than the number of users.
 */
export function startPresenceHeartbeat(io) {
  const timer = setInterval(() => {
    const userIds = new Set();
    for (const socket of io.of('/').sockets.values()) {
      if (socket.data.userId) userIds.add(socket.data.userId);
    }

    if (userIds.size === 0) return;

    const pipeline = cmd.pipeline();
    for (const id of userIds) pipeline.expire(key(id), TTL_SECONDS);

    pipeline
      .exec()
      .catch((err) => logger.error({ err }, 'presence heartbeat failed'));
  }, HEARTBEAT_MS);

  timer.unref();
  return () => clearInterval(timer);
}

/** Releases every lease this instance holds, so a clean shutdown leaves no ghosts. */
export async function releaseInstanceLeases(io) {
  const pipeline = cmd.pipeline();
  let count = 0;

  for (const socket of io.of('/').sockets.values()) {
    if (!socket.data.userId) continue;
    pipeline.srem(key(socket.data.userId), `${io.instanceId ?? instanceId}:${socket.id}`);
    count += 1;
  }

  if (count > 0) await pipeline.exec().catch(() => {});
}
