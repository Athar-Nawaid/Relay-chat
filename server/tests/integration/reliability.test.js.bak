import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { prisma } from '../../src/config/postgres.js';
import { connectMongo, disconnectMongo } from '../../src/config/mongo.js';
import { connectRedis, disconnectRedis } from '../../src/config/redis.js';
import { Message } from '../../src/models/message.model.js';
import {
  bootInstance,
  connectClient,
  createDm,
  emitWithAck,
  expectNoEvent,
  registerUser,
  waitFor,
} from '../helpers/harness.js';

/**
 * The reliability contract, executable.
 *
 * These are the tests that back the claims made about this project: at-least-once
 * delivery, an exactly-once effect via idempotency keys, a watermark-based
 * offline queue, and fan-out across independent instances.
 */

const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const newClientMsgId = () => crypto.randomUUID();

let alpha; // instance A
let beta; // instance B
let alice;
let bob;
let conversationId;

beforeAll(async () => {
  await Promise.all([connectMongo(), connectRedis()]);

  alpha = await bootInstance();
  beta = await bootInstance();

  alice = await registerUser(alpha.app, `r${stamp}alice`);
  bob = await registerUser(alpha.app, `r${stamp}bob`);
  conversationId = await createDm(alpha.app, alice, bob.id);
});

afterAll(async () => {
  await alpha?.close();
  await beta?.close();
  await Message.deleteMany({ conversationId });
  await prisma.user
    .deleteMany({ where: { id: { in: [alice?.id, bob?.id].filter(Boolean) } } })
    .catch(() => {});
  await prisma.$disconnect();
  await disconnectMongo();
  await disconnectRedis();
});

describe('1. idempotent sends', () => {
  it('stores exactly one message when the same clientMsgId is sent twice', async () => {
    const socket = await connectClient(alpha.url, alice.token);
    const clientMsgId = newClientMsgId();

    const first = await emitWithAck(socket, 'message:send', {
      conversationId,
      body: 'sent once, delivered once',
      clientMsgId,
    });

    // The client never saw the ack and retries with the SAME key.
    const second = await emitWithAck(socket, 'message:send', {
      conversationId,
      body: 'sent once, delivered once',
      clientMsgId,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.duplicate).toBe(true);

    // Same message returned, so the client can reconcile its optimistic bubble.
    expect(second.message.id).toBe(first.message.id);
    expect(second.message.seq).toBe(first.message.seq);

    const stored = await Message.countDocuments({ senderId: alice.id, clientMsgId });
    expect(stored).toBe(1);

    socket.close();
  });

  it('does not rebroadcast a duplicate to the room', async () => {
    const sender = await connectClient(alpha.url, alice.token);
    const receiver = await connectClient(alpha.url, bob.token);

    const clientMsgId = newClientMsgId();
    const payload = { conversationId, body: 'no echo on retry', clientMsgId };

    const delivered = waitFor(receiver, 'message:new', {
      filter: (m) => m.clientMsgId === clientMsgId,
    });
    await emitWithAck(sender, 'message:send', payload);
    await delivered;

    // The retry must not produce a second message:new — the room already has it.
    await emitWithAck(sender, 'message:send', payload);
    const extra = await expectNoEvent(receiver, 'message:new');
    expect(extra.filter((m) => m.clientMsgId === clientMsgId)).toHaveLength(0);

    sender.close();
    receiver.close();
  });
});

describe('2. offline queue', () => {
  it('delivers messages sent while the recipient was disconnected', async () => {
    const sender = await connectClient(alpha.url, alice.token);

    // Bob is offline entirely — no socket at all.
    const bodies = ['while you were out 1', 'while you were out 2', 'while you were out 3'];
    for (const body of bodies) {
      await emitWithAck(sender, 'message:send', {
        conversationId,
        body,
        clientMsgId: newClientMsgId(),
      });
    }

    const bobSocket = await connectClient(alpha.url, bob.token);
    const backlog = await waitFor(bobSocket, 'message:backlog');

    const received = backlog.messages.map((m) => m.body);
    for (const body of bodies) expect(received).toContain(body);

    sender.close();
    bobSocket.close();
  });
});

describe('3. the watermark advances', () => {
  it('does not resend a backlog that was acknowledged', async () => {
    const first = await connectClient(alpha.url, bob.token);
    const backlog = await waitFor(first, 'message:backlog');
    const highest = Math.max(...backlog.messages.map((m) => m.seq));

    // Confirm receipt, which moves the server-side watermark forward.
    const ack = await emitWithAck(first, 'sync:ack', { conversationId, upToSeq: highest });
    expect(ack.ok).toBe(true);
    first.close();

    // Reconnecting must now deliver nothing.
    const second = await connectClient(alpha.url, bob.token);
    const redelivered = await expectNoEvent(second, 'message:backlog');
    expect(redelivered).toHaveLength(0);
    second.close();
  });
});

describe('4. at-least-once: nothing is lost when a client dies mid-drain', () => {
  it('redelivers a backlog the client never acknowledged', async () => {
    const sender = await connectClient(alpha.url, alice.token);
    const body = `unacked-${crypto.randomUUID()}`;

    await emitWithAck(sender, 'message:send', {
      conversationId,
      body,
      clientMsgId: newClientMsgId(),
    });

    // Bob receives the backlog and then dies WITHOUT acking — a crash, a closed
    // laptop, a dropped network. The watermark must not have moved.
    const dying = await connectClient(alpha.url, bob.token);
    const firstDelivery = await waitFor(dying, 'message:backlog');
    expect(firstDelivery.messages.map((m) => m.body)).toContain(body);
    dying.disconnect();

    // On reconnect the same message must arrive again. Receiving it twice is the
    // contract working: at-least-once means never losing, not never repeating.
    const revived = await connectClient(alpha.url, bob.token);
    const secondDelivery = await waitFor(revived, 'message:backlog');
    expect(secondDelivery.messages.map((m) => m.body)).toContain(body);

    // And it is genuinely one stored message, not two.
    expect(await Message.countDocuments({ conversationId, body })).toBe(1);

    sender.close();
    revived.close();
  });
});

describe('5. handshake authentication', () => {
  it('rejects a connection with no token', async () => {
    await expect(connectClient(alpha.url, undefined)).rejects.toThrow();
  });

  it('rejects a forged token', async () => {
    const forged = jwt.sign({ sub: alice.id }, 'wrong-secret-but-long-enough-padding');
    await expect(connectClient(alpha.url, forged)).rejects.toThrow();
  });

  it('rejects an expired token with TOKEN_EXPIRED', async () => {
    const expired = jwt.sign({ sub: alice.id }, process.env.JWT_SECRET, { expiresIn: -10 });

    await expect(connectClient(alpha.url, expired)).rejects.toMatchObject({
      data: { code: 'TOKEN_EXPIRED' },
    });
  });
});

describe('6. authorisation', () => {
  it('refuses a send from a non-member', async () => {
    const outsider = await registerUser(alpha.app, `r${stamp}out`);
    const socket = await connectClient(alpha.url, outsider.token);

    const res = await emitWithAck(socket, 'message:send', {
      conversationId,
      body: 'let me in',
      clientMsgId: newClientMsgId(),
    });

    expect(res.ok).toBe(false);
    expect(res.code).toBe('NOT_A_MEMBER');

    socket.close();
    await prisma.user.delete({ where: { id: outsider.id } }).catch(() => {});
  });

  it('ignores a senderId supplied in the payload', async () => {
    const socket = await connectClient(alpha.url, alice.token);

    const res = await emitWithAck(socket, 'message:send', {
      conversationId,
      body: 'impersonation attempt',
      clientMsgId: newClientMsgId(),
      senderId: bob.id, // must be ignored in favour of the signed token
    });

    expect(res.ok).toBe(true);
    expect(res.message.senderId).toBe(alice.id);

    socket.close();
  });
});

describe('7. horizontal scaling across instances', () => {
  it('delivers a message between clients on two different servers', async () => {
    const onAlpha = await connectClient(alpha.url, alice.token);
    const onBeta = await connectClient(beta.url, bob.token);

    // Genuinely different processes-worth of state, and the proof is visible.
    expect(onAlpha.hello.instanceId).not.toBe(onBeta.hello.instanceId);

    const clientMsgId = newClientMsgId();
    const delivered = waitFor(onBeta, 'message:new', {
      filter: (m) => m.clientMsgId === clientMsgId,
    });

    await emitWithAck(onAlpha, 'message:send', {
      conversationId,
      body: 'crossed the instance boundary',
      clientMsgId,
    });

    const message = await delivered;
    expect(message.body).toBe('crossed the instance boundary');
    expect(message.senderId).toBe(alice.id);

    onAlpha.close();
    onBeta.close();
  });

  it('propagates presence across instances', async () => {
    // A user who has never connected, so "became online" is unambiguous — an
    // earlier test's socket still closing would otherwise suppress the
    // transition, since only the FIRST connection is announced.
    const carol = await registerUser(alpha.app, `r${stamp}carol`);
    await createDm(alpha.app, carol, bob.id);

    // Reconnect bob so his socket joins the new conversation's room.
    const watcher = await connectClient(beta.url, bob.token);
    const update = waitFor(watcher, 'presence:update', {
      filter: (p) => p.userId === carol.id && p.online === true,
    });

    const joiner = await connectClient(alpha.url, carol.token);
    const payload = await update;

    expect(payload.userId).toBe(carol.id);
    expect(payload.online).toBe(true);

    joiner.close();
    watcher.close();
    await prisma.user.delete({ where: { id: carol.id } }).catch(() => {});
  });
});

describe('8. joining a conversation created while already connected', () => {
  it('pulls an existing socket into the new room, across instances', async () => {
    // Both users are already connected — and to *different* instances — before
    // the group exists. Sockets join their rooms at connect time, so without an
    // explicit socketsJoin the invitee would sit outside the new room and
    // receive nothing until they reloaded.
    const invitee = await registerUser(alpha.app, `r${stamp}inv`);
    const inviteeSocket = await connectClient(beta.url, invitee.token);
    const creatorSocket = await connectClient(alpha.url, alice.token);

    const notified = waitFor(inviteeSocket, 'conversation:new');

    const res = await request(alpha.app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ type: 'group', title: 'Live join', memberIds: [invitee.id] })
      .expect(201);

    const created = res.body.conversation;

    // The invitee is told about it without asking.
    const announced = await notified;
    expect(announced.id).toBe(created.id);
    expect(announced.title).toBe('Live join');

    // And is genuinely in the room: a message sent now arrives with no reconnect.
    const clientMsgId = newClientMsgId();
    const delivered = waitFor(inviteeSocket, 'message:new', {
      filter: (m) => m.clientMsgId === clientMsgId,
    });

    await emitWithAck(creatorSocket, 'message:send', {
      conversationId: created.id,
      body: 'welcome to the group',
      clientMsgId,
    });

    expect((await delivered).body).toBe('welcome to the group');

    inviteeSocket.close();
    creatorSocket.close();
    await Message.deleteMany({ conversationId: created.id });
    await prisma.conversation.delete({ where: { id: created.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: invitee.id } }).catch(() => {});
  });
});

describe('9. ordering', () => {
  it('assigns strictly increasing sequence numbers under concurrent sends', async () => {
    const socket = await connectClient(alpha.url, alice.token);

    const acks = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        emitWithAck(socket, 'message:send', {
          conversationId,
          body: `concurrent ${i}`,
          clientMsgId: newClientMsgId(),
        }),
      ),
    );

    const seqs = acks.map((a) => a.message.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
    // The row lock on next_seq is what guarantees this under concurrency.
    expect([...seqs].sort((a, b) => a - b)).toEqual([...new Set(seqs)].sort((a, b) => a - b));

    socket.close();
  });
});
