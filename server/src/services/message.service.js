import { Message } from '../models/message.model.js';
import { prisma } from '../config/postgres.js';

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;

/** The shape sent to clients. Soft-deleted messages keep their slot in the sequence. */
export function toDto(doc) {
  return {
    id: String(doc._id),
    conversationId: doc.conversationId,
    seq: doc.seq,
    senderId: doc.senderId,
    clientMsgId: doc.clientMsgId,
    body: doc.deletedAt ? null : doc.body,
    contentType: doc.contentType,
    createdAt: doc.createdAt,
    editedAt: doc.editedAt,
    deletedAt: doc.deletedAt,
  };
}

/**
 * Allocates the next sequence number for a conversation.
 *
 * One statement, and the row lock it takes is what serialises concurrent sends
 * into a total order per conversation — which is exactly the ordering guarantee
 * the client relies on. `last_message_at` is bumped in the same statement so the
 * conversation list ordering never disagrees with the message log.
 *
 * Faster alternatives exist (a Redis INCR with a periodic Postgres checkpoint),
 * at the cost of gaps after an eviction. Correctness wins here because the write
 * rate does not remotely justify it.
 */
async function allocateSeq(conversationId) {
  const rows = await prisma.$queryRaw`
    UPDATE conversations
       SET next_seq = next_seq + 1,
           last_message_at = now()
     WHERE id = ${conversationId}::uuid
    RETURNING next_seq - 1 AS seq`;

  return Number(rows[0].seq);
}

/**
 * Persists a message, exactly once per clientMsgId.
 *
 * Delivery is at-least-once: the client re-sends anything it has not seen acked,
 * including after a reconnect. The unique index on {senderId, clientMsgId} turns
 * that into an exactly-once *effect* — a retry collides with E11000 and we return
 * the message already stored rather than writing a second copy.
 *
 * A retry does burn a sequence number, because allocation happens before the
 * insert. That is deliberate and is why the contract promises `seq` is MONOTONIC
 * rather than contiguous: the client treats a gap as "fetch this range", never as
 * "data lost". Guaranteeing contiguity would need a cross-store transaction that
 * Postgres and Mongo cannot provide between them.
 */
export async function createMessage({ conversationId, senderId, body, clientMsgId }) {
  // No pre-emptive "have I seen this clientMsgId?" read.
  //
  // That check was measured at roughly a full round trip added to EVERY send, to
  // avoid burning a sequence number on the rare retry. The unique index already
  // rejects duplicates, so the read only moved work from the uncommon path onto
  // the common one. Load testing made the cost obvious; the index does the job.
  const seq = await allocateSeq(conversationId);

  try {
    const doc = await Message.create({ conversationId, seq, senderId, clientMsgId, body });
    return { message: toDto(doc), duplicate: false };
  } catch (err) {
    // E11000 means this clientMsgId is already stored — a retry. Return what is
    // there rather than writing a second copy. The seq allocated above is simply
    // burned, which is why the contract promises monotonic, not contiguous.
    if (err?.code === 11000) {
      const existing = await Message.findOne({ senderId, clientMsgId }).lean();
      if (existing) return { message: toDto(existing), duplicate: true };
    }
    throw err;
  }
}

/**
 * Reads history backwards from a cursor.
 *
 * Cursor pagination on `seq`, never `skip`: skip re-scans from the start of the
 * collection and drifts when rows are inserted mid-scroll, which in a live chat
 * is constant. This is also the fix for the original bug, where the old code
 * sorted ascending *before* limiting and so returned the fifty oldest messages
 * forever instead of the fifty newest.
 */
export async function listHistory({ conversationId, beforeSeq, limit = DEFAULT_PAGE }) {
  const size = Math.min(Math.max(limit, 1), MAX_PAGE);

  const filter = { conversationId };
  if (Number.isInteger(beforeSeq)) filter.seq = { $lt: beforeSeq };

  // Fetch one extra to learn whether another page exists, without a count().
  const docs = await Message.find(filter)
    .sort({ seq: -1 })
    .limit(size + 1)
    .lean();

  const hasMore = docs.length > size;
  const page = hasMore ? docs.slice(0, size) : docs;

  return {
    // Reversed so callers always receive ascending seq, the order they render in.
    messages: page.reverse().map(toDto),
    hasMore,
    nextCursor: page.length ? page[0].seq : null,
  };
}

/**
 * Reads an explicit seq range. Used by the client's gap repair: on seeing
 * seq > lastContiguous + 1 it fetches the span to find out whether the gap is
 * real (a soft delete, or a sequence number burned by a failed insert) or just
 * an out-of-order arrival.
 */
export async function listRange({ conversationId, afterSeq, beforeSeq, limit = MAX_PAGE }) {
  const size = Math.min(Math.max(limit, 1), MAX_PAGE);

  const docs = await Message.find({
    conversationId,
    seq: { $gt: afterSeq, $lt: beforeSeq },
  })
    .sort({ seq: 1 })
    .limit(size)
    .lean();

  return { messages: docs.map(toDto) };
}

/**
 * Drains everything a member has not yet been told about. This is the offline
 * queue read: there is no queue table, just this cursor into the message log.
 */
export async function listUndelivered({ conversationId, afterSeq, limit = MAX_PAGE }) {
  const size = Math.min(Math.max(limit, 1), MAX_PAGE);

  const docs = await Message.find({ conversationId, seq: { $gt: afterSeq } })
    .sort({ seq: 1 })
    .limit(size + 1)
    .lean();

  const hasMore = docs.length > size;
  const page = hasMore ? docs.slice(0, size) : docs;

  return { messages: page.map(toDto), hasMore };
}
