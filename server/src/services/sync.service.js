import { prisma } from '../config/postgres.js';

/**
 * The delivery watermark: everything with seq > lastDeliveredSeq is undelivered.
 *
 * There is no queue table and no Redis list. The append-only message log in Mongo
 * IS the queue; Postgres holds each member's cursor into it. That is why an
 * offline user needs no special storage — they are simply a cursor that has
 * fallen behind.
 */
export async function membershipsFor(userId) {
  return prisma.conversationMember.findMany({
    where: { userId },
    select: { conversationId: true, lastDeliveredSeq: true, lastReadSeq: true },
  });
}

export async function deliveredSeq(userId, conversationId) {
  const row = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { lastDeliveredSeq: true },
  });
  return row?.lastDeliveredSeq ?? 0;
}

/**
 * Advances the delivery watermark.
 *
 * GREATEST is what makes this safe to call with a duplicate or out-of-order ack —
 * the watermark can only ever move forwards. Without it, a late ack carrying a
 * stale seq would rewind the cursor and cause the whole backlog to be redelivered.
 */
export async function advanceDelivered(userId, conversationId, upToSeq) {
  await prisma.$executeRaw`
    UPDATE conversation_members
       SET last_delivered_seq = GREATEST(last_delivered_seq, ${upToSeq})
     WHERE conversation_id = ${conversationId}::uuid
       AND user_id = ${userId}::uuid`;
}
