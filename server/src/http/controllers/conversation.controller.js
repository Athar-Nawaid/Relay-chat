import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';
import {
  assertMember,
  createGroup,
  createOrGetDm,
  getConversation,
  listForUser,
  markRead,
} from '../../services/conversation.service.js';
import { listHistory, listRange } from '../../services/message.service.js';
import { EVENTS, room } from '../../realtime/events.js';

const uuid = z.string().uuid('Not a valid id');

const createSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('dm'), userId: uuid }),
  z.object({
    type: z.literal('group'),
    title: z.string().trim().min(1).max(60),
    memberIds: z.array(uuid).min(1).max(50),
  }),
]);

const historySchema = z.object({
  beforeSeq: z.coerce.number().int().positive().optional(),
  afterSeq: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest('VALIDATION_FAILED', result.error.issues[0].message);
  return result.data;
}

export async function list(req, res, next) {
  try {
    res.json({ conversations: await listForUser(req.auth.userId) });
  } catch (err) {
    next(err);
  }
}

/**
 * Brings a brand-new conversation to life for everyone in it.
 *
 * Sockets join their conversation rooms at connect time, so a member who is
 * already online would otherwise sit outside the new room and receive nothing
 * until they reloaded. `socketsJoin` fixes that, and because it goes through the
 * Redis adapter it reaches that member's sockets on *any* instance, not just
 * this one.
 */
async function announceConversation(req, conversation) {
  const io = req.app.get('io');
  if (!io) return; // no socket layer (tests mounting the app alone)

  const conversationRoom = room.conversation(conversation.id);

  await Promise.all(
    conversation.members.map(async (member) => {
      const userRoom = room.user(member.id);
      await io.in(userRoom).socketsJoin(conversationRoom);
      io.to(userRoom).emit(EVENTS.CONVERSATION_NEW, conversation);
    }),
  );
}

export async function create(req, res, next) {
  try {
    const input = parse(createSchema, req.body);
    const isDm = input.type === 'dm';

    const conversation = isDm
      ? await createOrGetDm(req.auth.userId, input.userId)
      : await createGroup(req.auth.userId, input.title, input.memberIds);

    await announceConversation(req, conversation).catch(() => {
      // A failed announce is not a failed creation. The conversation exists, and
      // members will pick it up on their next connect.
    });

    // 200 rather than 201 for DMs: the upsert means the caller cannot know
    // whether it created anything, and pretending otherwise would be a lie.
    res.status(isDm ? 200 : 201).json({ conversation });
  } catch (err) {
    next(err);
  }
}

export async function show(req, res, next) {
  try {
    const id = parse(uuid, req.params.id);
    await assertMember(req.auth.userId, id);
    res.json({ conversation: await getConversation(id) });
  } catch (err) {
    next(err);
  }
}

export async function history(req, res, next) {
  try {
    const id = parse(uuid, req.params.id);
    const { beforeSeq, afterSeq, limit } = parse(historySchema, req.query);

    await assertMember(req.auth.userId, id);

    // Both bounds present means a gap-repair request for one explicit span.
    if (afterSeq !== undefined && beforeSeq !== undefined) {
      return res.json(await listRange({ conversationId: id, afterSeq, beforeSeq, limit }));
    }

    return res.json(await listHistory({ conversationId: id, beforeSeq, limit }));
  } catch (err) {
    next(err);
  }
}

export async function read(req, res, next) {
  try {
    const id = parse(uuid, req.params.id);
    const { upToSeq } = parse(z.object({ upToSeq: z.coerce.number().int().nonnegative() }), req.body);

    await assertMember(req.auth.userId, id);
    await markRead(req.auth.userId, id, upToSeq);

    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
