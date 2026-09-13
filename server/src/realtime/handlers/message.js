import { z } from 'zod';
import { EVENTS, room } from '../events.js';
import { assertMember } from '../../services/conversation.service.js';
import { createMessage } from '../../services/message.service.js';
import { consume } from '../../services/ratelimit.service.js';
import { logger } from '../../lib/logger.js';

const sendSchema = z.object({
  conversationId: z.string().uuid(),
  body: z.string().trim().min(1).max(4000),
  clientMsgId: z.string().min(8).max(64),
});

const RATE = { limit: 20, windowSeconds: 10 };

/** Acks always have the same shape, so the client has one thing to branch on. */
const fail = (code, message) => ({ ok: false, code, message });

export function registerMessageHandlers(io, socket) {
  socket.on(EVENTS.MESSAGE_SEND, async (payload, ack) => {
    // Without an ack callback the client cannot learn the outcome, and the whole
    // at-least-once contract depends on it. Reject rather than half-honour it.
    if (typeof ack !== 'function') return;

    try {
      const parsed = sendSchema.safeParse(payload);
      if (!parsed.success) {
        return ack(fail('VALIDATION_FAILED', parsed.error.issues[0].message));
      }

      const { conversationId, body, clientMsgId } = parsed.data;
      const userId = socket.data.userId;

      // Identity comes from the signed token, never from the payload.
      await assertMember(userId, conversationId);

      const { allowed } = await consume({ key: `send:${userId}`, ...RATE });
      if (!allowed) return ack(fail('RATE_LIMITED', 'Slow down'));

      const { message, duplicate } = await createMessage({
        conversationId,
        senderId: userId,
        body,
        clientMsgId,
      });

      // Broadcast before acking so the room sees it as early as possible. A
      // duplicate is NOT rebroadcast: the room already received it the first time,
      // and this is only the sender retrying an ack it never saw.
      if (!duplicate) {
        io.to(room.conversation(conversationId)).emit(EVENTS.MESSAGE_NEW, message);
      }

      return ack({ ok: true, duplicate, message });
    } catch (err) {
      if (err?.status === 403) return ack(fail('NOT_A_MEMBER', err.message));

      logger.error({ err, userId: socket.data.userId }, 'message:send failed');
      // A failed ack is the signal that keeps the message in the client's outbox
      // for retry, which is why this must never throw silently.
      return ack(fail('INTERNAL', 'Could not send message'));
    }
  });
}
