import { z } from 'zod';
import { EVENTS, room } from '../events.js';
import { assertMember } from '../../services/conversation.service.js';

const schema = z.object({ conversationId: z.string().uuid() });

/**
 * Typing indicators are deliberately ephemeral — never persisted, never acked,
 * and dropped silently on error. They are a hint, and a lost hint costs nothing.
 *
 * No stop-event timer is kept server-side: the client expires its own indicator
 * after a few seconds, so a sender who crashes mid-type cannot leave someone
 * "typing…" forever.
 */
function relay(socket, event, isTyping) {
  socket.on(event, async (payload) => {
    try {
      const parsed = schema.safeParse(payload);
      if (!parsed.success) return;

      await assertMember(socket.data.userId, parsed.data.conversationId);

      // broadcast: everyone in the room except the sender.
      socket.broadcast.to(room.conversation(parsed.data.conversationId)).emit(EVENTS.TYPING, {
        conversationId: parsed.data.conversationId,
        userId: socket.data.userId,
        typing: isTyping,
      });
    } catch {
      // Intentionally silent.
    }
  });
}

export function registerTypingHandlers(_io, socket) {
  relay(socket, EVENTS.TYPING_START, true);
  relay(socket, EVENTS.TYPING_STOP, false);
}
