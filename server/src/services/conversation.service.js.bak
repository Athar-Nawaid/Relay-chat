import { prisma } from '../config/postgres.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';

/**
 * DM identity is derived, not chosen: sorting the two user ids means the pair
 * (A,B) and (B,A) produce the same key, and the UNIQUE constraint on dm_key then
 * makes DM creation idempotent at the database level rather than via a
 * read-then-write race in application code.
 */
export const dmKeyFor = (a, b) => [a, b].sort().join(':');

const memberSelect = {
  select: { id: true, username: true, displayName: true, avatarColor: true },
};

/**
 * Flattens Prisma's nested `{user, role}` membership into one object.
 *
 * Every endpoint returns members in this single shape, so the client never has
 * to know which query produced a conversation.
 */
function shape(conversation) {
  if (!conversation) return conversation;

  return {
    ...conversation,
    members: (conversation.members ?? []).map((m) =>
      m.user ? { ...m.user, role: m.role } : m,
    ),
  };
}

/* ------------------------------------------------------------------ *
 * Membership authorisation
 * ------------------------------------------------------------------ */

const MEMBERSHIP_TTL_MS = 30_000;
const MEMBERSHIP_CACHE_MAX = 10_000;

/** key `${userId}:${conversationId}` -> expiry timestamp. Positive results only. */
const membershipCache = new Map();

/**
 * Authorises a user against a conversation.
 *
 * Every socket event calls this on the hot path, so successful lookups are cached
 * briefly. Only positive results are cached: a non-member must never be let in by
 * a stale entry, whereas a removed member retaining access for up to 30s is an
 * acceptable trade. `invalidateMembership` clears it on an explicit removal.
 */
export async function assertMember(userId, conversationId) {
  const key = `${userId}:${conversationId}`;
  const expiresAt = membershipCache.get(key);

  if (expiresAt !== undefined && expiresAt > Date.now()) return;

  const row = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { userId: true },
  });

  if (!row) throw forbidden('NOT_A_MEMBER', 'You are not a member of this conversation');

  // Cheap bound: the cache is an optimisation, so dropping it wholesale is safe.
  if (membershipCache.size >= MEMBERSHIP_CACHE_MAX) membershipCache.clear();
  membershipCache.set(key, Date.now() + MEMBERSHIP_TTL_MS);
}

export function invalidateMembership(userId, conversationId) {
  membershipCache.delete(`${userId}:${conversationId}`);
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/**
 * Every conversation for a user, with unread counts.
 *
 * The unread count is arithmetic on two integers the membership row already
 * holds — `(next_seq - 1) - last_read_seq` — so it costs nothing and never scans
 * the message store. This is the payoff for tracking delivery as high-water marks
 * instead of per-message receipt rows.
 */
export async function listForUser(userId) {
  const rows = await prisma.$queryRaw`
    SELECT c.id,
           c.type::text          AS type,
           c.title,
           c.last_message_at     AS "lastMessageAt",
           c.next_seq - 1        AS "lastSeq",
           m.last_read_seq       AS "lastReadSeq",
           GREATEST(c.next_seq - 1 - m.last_read_seq, 0) AS unread
    FROM conversation_members m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.user_id = ${userId}::uuid
    ORDER BY c.last_message_at DESC NULLS LAST, c.id`;

  if (rows.length === 0) return [];

  // One extra round trip for all members, rather than N+1 per conversation.
  const members = await prisma.conversationMember.findMany({
    where: { conversationId: { in: rows.map((r) => r.id) } },
    select: { conversationId: true, user: memberSelect },
  });

  const byConversation = new Map();
  for (const m of members) {
    if (!byConversation.has(m.conversationId)) byConversation.set(m.conversationId, []);
    byConversation.get(m.conversationId).push(m.user);
  }

  return rows.map((r) => ({
    ...r,
    unread: Number(r.unread),
    lastSeq: Number(r.lastSeq),
    lastReadSeq: Number(r.lastReadSeq),
    members: byConversation.get(r.id) ?? [],
  }));
}

export async function getConversation(conversationId) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { members: { select: { user: memberSelect, role: true } } },
  });

  if (!conversation) throw notFound('CONVERSATION_NOT_FOUND');
  return shape(conversation);
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/**
 * Returns the DM between two users, creating it only if absent.
 *
 * The upsert on the unique dm_key is what makes this idempotent — clicking
 * "message Alice" twice, or two devices doing it simultaneously, both converge on
 * one row. The database enforces it; the application never checks-then-inserts.
 */
export async function createOrGetDm(meId, otherId) {
  if (meId === otherId) throw badRequest('SELF_DM', 'You cannot start a conversation with yourself');

  const other = await prisma.user.findUnique({ where: { id: otherId }, select: { id: true } });
  if (!other) throw notFound('USER_NOT_FOUND');

  const dmKey = dmKeyFor(meId, otherId);
  const include = { members: { select: { user: memberSelect, role: true } } };

  try {
    const created = await prisma.conversation.upsert({
      where: { dmKey },
      update: {},
      create: {
        type: 'dm',
        dmKey,
        createdById: meId,
        members: { create: [{ userId: meId }, { userId: otherId }] },
      },
      include,
    });
    return shape(created);
  } catch (err) {
    // An upsert is a SELECT followed by an INSERT, not an atomic operation. Two
    // simultaneous requests can both miss and both try to insert; the unique
    // constraint lets exactly one win and rejects the other with P2002.
    //
    // That rejection is the constraint working, not a failure — so the loser
    // simply reads the winner's row. This is what makes DM creation genuinely
    // idempotent under concurrency rather than only when requests are serial.
    if (err?.code === 'P2002') {
      return shape(await prisma.conversation.findUnique({ where: { dmKey }, include }));
    }
    throw err;
  }
}

export async function createGroup(meId, title, memberIds) {
  const unique = [...new Set([meId, ...memberIds])];

  const found = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true },
  });

  if (found.length !== unique.length) throw notFound('USER_NOT_FOUND', 'One or more users not found');

  const created = await prisma.conversation.create({
    data: {
      type: 'group',
      title,
      createdById: meId,
      members: {
        create: unique.map((userId) => ({
          userId,
          role: userId === meId ? 'owner' : 'member',
        })),
      },
    },
    include: { members: { select: { user: memberSelect, role: true } } },
  });

  return shape(created);
}

/**
 * Advances the read watermark. GREATEST prevents regression from an out-of-order
 * or replayed mark — the watermark must never move backwards.
 */
export async function markRead(userId, conversationId, upToSeq) {
  await prisma.$executeRaw`
    UPDATE conversation_members
       SET last_read_seq = GREATEST(last_read_seq, ${upToSeq})
     WHERE conversation_id = ${conversationId}::uuid
       AND user_id = ${userId}::uuid`;
}
