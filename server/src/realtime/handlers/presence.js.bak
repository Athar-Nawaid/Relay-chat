import { EVENTS, room } from '../events.js';
import { addConnection, removeConnection } from '../../services/presence.service.js';
import { membershipsFor } from '../../services/sync.service.js';
import { logger } from '../../lib/logger.js';

/**
 * Tells everyone who shares a conversation with this user that their status
 * changed. Broadcast to conversation rooms rather than to a global channel, so
 * presence only reaches people entitled to see it — and the Redis adapter carries
 * it to sockets on every other instance.
 */
async function broadcastPresence(io, userId, online, conversationIds) {
  if (conversationIds.length === 0) return;

  io.to(conversationIds.map(room.conversation)).emit(EVENTS.PRESENCE_UPDATE, {
    userId,
    online,
    at: new Date().toISOString(),
  });
}

export async function onConnect(io, socket, conversationIds) {
  const { becameOnline } = await addConnection(
    socket.data.userId,
    socket.id,
    socket.data.instanceId,
  );

  // Only announce a transition. A second tab opening is not news.
  if (becameOnline) await broadcastPresence(io, socket.data.userId, true, conversationIds);
}

export async function onDisconnect(io, socket) {
  try {
    const { becameOffline } = await removeConnection(
      socket.data.userId,
      socket.id,
      socket.data.instanceId,
    );
    if (!becameOffline) return;

    // Re-read memberships rather than trusting a stale closure: the user may have
    // joined or left conversations during the life of this socket.
    const memberships = await membershipsFor(socket.data.userId);
    await broadcastPresence(
      io,
      socket.data.userId,
      false,
      memberships.map((m) => m.conversationId),
    );
  } catch (err) {
    logger.error({ err, userId: socket.data.userId }, 'presence disconnect handling failed');
  }
}
