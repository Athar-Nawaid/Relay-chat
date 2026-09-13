import { z } from 'zod';
import { EVENTS } from '../events.js';
import { assertMember, markRead } from '../../services/conversation.service.js';
import { listUndelivered } from '../../services/message.service.js';
import { advanceDelivered, deliveredSeq, membershipsFor } from '../../services/sync.service.js';
import { logger } from '../../lib/logger.js';

const BACKLOG_PAGE = 200;

const ackSchema = z.object({
  conversationId: z.string().uuid(),
  upToSeq: z.number().int().nonnegative(),
});

/**
 * Sends one conversation's undelivered messages.
 *
 * The server's watermark is authoritative — never a value the client claims —
 * because it advances only on an explicit sync:ack. A client cannot skip messages
 * by lying, and a client that dies mid-drain simply receives the batch again.
 */
async function drainConversation(socket, conversationId, fromSeq) {
  const { messages, hasMore } = await listUndelivered({
    conversationId,
    afterSeq: fromSeq,
    limit: BACKLOG_PAGE,
  });

  if (messages.length === 0) return;

  socket.emit(EVENTS.MESSAGE_BACKLOG, { conversationId, messages, hasMore });
}

/** Drains every conversation the user belongs to. Runs on each connect. */
export async function drainAll(socket) {
  const memberships = await membershipsFor(socket.data.userId);

  for (const m of memberships) {
    try {
      await drainConversation(socket, m.conversationId, m.lastDeliveredSeq);
    } catch (err) {
      logger.error({ err, conversationId: m.conversationId }, 'backlog drain failed');
    }
  }
}

export function registerSyncHandlers(_io, socket) {
  /**
   * Confirms receipt, moving the watermark forward.
   *
   * Everything between the server emitting a backlog and receiving this ack is
   * the at-least-once window: crash in it and the batch is delivered again, which
   * the client de-duplicates on messageId. That redundancy is the protocol
   * working, not a defect — losing nothing matters more than sending once.
   */
  socket.on(EVENTS.SYNC_ACK, async (payload, ack) => {
    try {
      const parsed = ackSchema.safeParse(payload);
      if (!parsed.success) return ack?.({ ok: false, code: 'VALIDATION_FAILED' });

      const { conversationId, upToSeq } = parsed.data;
      await assertMember(socket.data.userId, conversationId);
      await advanceDelivered(socket.data.userId, conversationId, upToSeq);

      return ack?.({ ok: true });
    } catch (err) {
      logger.error({ err }, 'sync:ack failed');
      return ack?.({ ok: false, code: 'INTERNAL' });
    }
  });

  /** Explicit request for the next page, or a manual resync after a gap. */
  socket.on(EVENTS.SYNC_REQUEST, async (payload, ack) => {
    try {
      const conversationId = z.string().uuid().parse(payload?.conversationId);
      await assertMember(socket.data.userId, conversationId);

      const from = Number.isInteger(payload?.fromSeq)
        ? payload.fromSeq
        : await deliveredSeq(socket.data.userId, conversationId);

      await drainConversation(socket, conversationId, from);
      return ack?.({ ok: true });
    } catch (err) {
      logger.error({ err }, 'sync:request failed');
      return ack?.({ ok: false, code: 'INTERNAL' });
    }
  });

  /** Read receipts. Separate from delivery: seen by a human, not just received. */
  socket.on(EVENTS.READ_MARK, async (payload, ack) => {
    try {
      const parsed = ackSchema.safeParse(payload);
      if (!parsed.success) return ack?.({ ok: false, code: 'VALIDATION_FAILED' });

      await assertMember(socket.data.userId, parsed.data.conversationId);
      await markRead(socket.data.userId, parsed.data.conversationId, parsed.data.upToSeq);

      return ack?.({ ok: true });
    } catch (err) {
      logger.error({ err }, 'read:mark failed');
      return ack?.({ ok: false, code: 'INTERNAL' });
    }
  });
}
