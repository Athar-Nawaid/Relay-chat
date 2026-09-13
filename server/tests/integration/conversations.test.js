import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/config/postgres.js';
import { connectMongo, disconnectMongo } from '../../src/config/mongo.js';
import { Message } from '../../src/models/message.model.js';

const app = createApp();
const password = 'correct-horse-battery';
const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

const users = {};
let dmId;
let groupId;

async function makeUser(tag) {
  const username = `t${stamp}${tag}`;
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username, password, displayName: `User ${tag}` })
    .expect(201);
  return { id: res.body.user.id, username, token: res.body.accessToken };
}

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });

beforeAll(async () => {
  await connectMongo();
  users.a = await makeUser('a');
  users.b = await makeUser('b');
  users.c = await makeUser('c');
});

afterAll(async () => {
  if (dmId) await Message.deleteMany({ conversationId: dmId });
  await prisma.user
    .deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } })
    .catch(() => {});
  await prisma.$disconnect();
  await disconnectMongo();
});

describe('user search', () => {
  it('finds another user and never returns yourself', async () => {
    const res = await request(app)
      .get(`/api/users?q=t${stamp}`)
      .set(auth(users.a))
      .expect(200);

    const ids = res.body.users.map((u) => u.id);
    expect(ids).toContain(users.b.id);
    expect(ids).not.toContain(users.a.id);
  });

  it('requires authentication', async () => {
    await request(app).get('/api/users?q=anything').expect(401);
  });
});

describe('creating conversations', () => {
  it('creates a DM', async () => {
    const res = await request(app)
      .post('/api/conversations')
      .set(auth(users.a))
      .send({ type: 'dm', userId: users.b.id })
      .expect(200);

    dmId = res.body.conversation.id;
    expect(res.body.conversation.type).toBe('dm');
    expect(res.body.conversation.members).toHaveLength(2);
  });

  it('is idempotent — asking twice returns the same conversation', async () => {
    const res = await request(app)
      .post('/api/conversations')
      .set(auth(users.a))
      .send({ type: 'dm', userId: users.b.id })
      .expect(200);

    expect(res.body.conversation.id).toBe(dmId);
  });

  it('returns the same DM regardless of who asks', async () => {
    // dm_key sorts the ids, so direction cannot create a second row.
    const res = await request(app)
      .post('/api/conversations')
      .set(auth(users.b))
      .send({ type: 'dm', userId: users.a.id })
      .expect(200);

    expect(res.body.conversation.id).toBe(dmId);
  });

  it('survives concurrent creation without duplicating', async () => {
    const other = await makeUser('d');
    users.d = other;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .post('/api/conversations')
          .set(auth(users.a))
          .send({ type: 'dm', userId: other.id }),
      ),
    );

    const ids = new Set(results.map((r) => r.body.conversation?.id));
    expect(ids.size).toBe(1);
  });

  it('refuses a DM with yourself', async () => {
    const res = await request(app)
      .post('/api/conversations')
      .set(auth(users.a))
      .send({ type: 'dm', userId: users.a.id })
      .expect(400);

    expect(res.body.error.code).toBe('SELF_DM');
  });

  it('creates a group with an owner', async () => {
    const res = await request(app)
      .post('/api/conversations')
      .set(auth(users.a))
      .send({ type: 'group', title: 'Test Group', memberIds: [users.b.id, users.c.id] })
      .expect(201);

    groupId = res.body.conversation.id;
    expect(res.body.conversation.members).toHaveLength(3);
    // Members are returned in one flat shape from every endpoint.
    expect(res.body.conversation.members.find((m) => m.id === users.a.id).role).toBe('owner');
  });
});

describe('authorisation', () => {
  it('blocks a non-member from reading history', async () => {
    const outsider = await makeUser('e');
    users.e = outsider;

    const res = await request(app)
      .get(`/api/conversations/${dmId}/messages`)
      .set(auth(outsider))
      .expect(403);

    expect(res.body.error.code).toBe('NOT_A_MEMBER');
  });

  it('rejects a malformed conversation id', async () => {
    await request(app).get('/api/conversations/not-a-uuid/messages').set(auth(users.a)).expect(400);
  });
});

describe('history pagination', () => {
  const TOTAL = 120;

  beforeAll(async () => {
    await Message.insertMany(
      Array.from({ length: TOTAL }, (_, i) => ({
        conversationId: dmId,
        seq: i + 1,
        senderId: users.a.id,
        clientMsgId: `${stamp}-seed-${i}`,
        body: `message ${i + 1}`,
      })),
    );
  });

  it('returns the NEWEST page by default, ascending', async () => {
    // The original bug: sorting ascending before limiting returned the fifty
    // OLDEST messages forever. This asserts the fix directly.
    const res = await request(app)
      .get(`/api/conversations/${dmId}/messages?limit=50`)
      .set(auth(users.a))
      .expect(200);

    const seqs = res.body.messages.map((m) => m.seq);
    expect(seqs).toHaveLength(50);
    expect(seqs[seqs.length - 1]).toBe(TOTAL); // newest is last
    expect(seqs[0]).toBe(TOTAL - 49);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y)); // ascending
    expect(res.body.hasMore).toBe(true);
  });

  it('walks backwards with the cursor without gaps or repeats', async () => {
    const seen = [];
    let cursor;

    for (let page = 0; page < 3; page += 1) {
      const url = `/api/conversations/${dmId}/messages?limit=50${
        cursor ? `&beforeSeq=${cursor}` : ''
      }`;
      const res = await request(app).get(url).set(auth(users.a)).expect(200);
      seen.unshift(...res.body.messages.map((m) => m.seq));
      cursor = res.body.nextCursor;
    }

    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
    expect(seen[0]).toBe(1);
    expect(seen[TOTAL - 1]).toBe(TOTAL);
  });

  it('reports hasMore false on the final page', async () => {
    const res = await request(app)
      .get(`/api/conversations/${dmId}/messages?limit=50&beforeSeq=51`)
      .set(auth(users.a))
      .expect(200);

    expect(res.body.hasMore).toBe(false);
    expect(res.body.messages[0].seq).toBe(1);
  });

  it('fetches an explicit range for gap repair', async () => {
    const res = await request(app)
      .get(`/api/conversations/${dmId}/messages?afterSeq=10&beforeSeq=15`)
      .set(auth(users.a))
      .expect(200);

    expect(res.body.messages.map((m) => m.seq)).toEqual([11, 12, 13, 14]);
  });
});

describe('listing and unread counts', () => {
  it('lists the caller conversations with members attached', async () => {
    const res = await request(app).get('/api/conversations').set(auth(users.a)).expect(200);

    const ids = res.body.conversations.map((c) => c.id);
    expect(ids).toContain(dmId);
    expect(ids).toContain(groupId);
    expect(res.body.conversations.find((c) => c.id === groupId).members).toHaveLength(3);
  });

  it('marks read and drives the unread count to zero', async () => {
    // next_seq is still 1 here because these messages were inserted straight into
    // Mongo rather than allocated through Postgres, so unread starts clamped at 0.
    await prisma.conversation.update({ where: { id: dmId }, data: { nextSeq: 121 } });

    const before = await request(app).get('/api/conversations').set(auth(users.b)).expect(200);
    expect(before.body.conversations.find((c) => c.id === dmId).unread).toBe(120);

    await request(app)
      .post(`/api/conversations/${dmId}/read`)
      .set(auth(users.b))
      .send({ upToSeq: 120 })
      .expect(204);

    const after = await request(app).get('/api/conversations').set(auth(users.b)).expect(200);
    expect(after.body.conversations.find((c) => c.id === dmId).unread).toBe(0);
  });

  it('never lets the read watermark move backwards', async () => {
    await request(app)
      .post(`/api/conversations/${dmId}/read`)
      .set(auth(users.b))
      .send({ upToSeq: 5 })
      .expect(204);

    const res = await request(app).get('/api/conversations').set(auth(users.b)).expect(200);
    expect(res.body.conversations.find((c) => c.id === dmId).lastReadSeq).toBe(120);
  });
});
