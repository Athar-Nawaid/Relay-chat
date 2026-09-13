import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { PrismaClient } from '@prisma/client';

/**
 * Socket.IO load generator.
 *
 * Measures end-to-end fan-out latency: the time from a sender emitting to a
 * *different* client receiving. Because every client lives in this one process,
 * the send and receive clocks are identical — which is what makes the latency
 * figure real rather than an estimate across unsynchronised machines.
 *
 * Usage:
 *   node loadtest/socket-load.js --users 100 --senders 10 --duration 20000 \
 *     --targets http://localhost:3000,http://localhost:3001
 */

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .split('--')
    .filter(Boolean)
    .map((pair) => {
      const [k, ...rest] = pair.trim().split(/\s+/);
      return [k, rest.join(' ')];
    }),
);

const USERS = Number(args.users ?? 100);
const SENDERS = Number(args.senders ?? 10);
const DURATION_MS = Number(args.duration ?? 20_000);
const SEND_INTERVAL_MS = Number(args.interval ?? 1000);
const TARGETS = (args.targets ?? 'http://localhost:3000').split(',').map((s) => s.trim());

const prisma = new PrismaClient();
const PREFIX = 'loadtest_';

const percentile = (sorted, p) => {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
};

const summarise = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? null,
  };
};

/** Creates (or reuses) N users all inside one group conversation. */
async function seed() {
  process.stdout.write(`Seeding ${USERS} users… `);

  const users = [];
  for (let i = 0; i < USERS; i += 1) {
    const username = `${PREFIX}${i}`;
    users.push(
      await prisma.user.upsert({
        where: { username },
        update: {},
        create: {
          username,
          displayName: `Load ${i}`,
          // Never logged into — the generator mints JWTs directly.
          passwordHash: 'x'.repeat(60),
        },
      }),
    );
  }

  let conversation = await prisma.conversation.findFirst({
    where: { type: 'group', title: 'loadtest' },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { type: 'group', title: 'loadtest', createdById: users[0].id },
    });
  }

  // Membership is what authorises a send, so everyone must be in the room.
  await prisma.conversationMember.createMany({
    data: users.map((u) => ({ conversationId: conversation.id, userId: u.id })),
    skipDuplicates: true,
  });

  console.log('done.');
  return { users, conversationId: conversation.id };
}

/** Mint tokens directly: we are measuring the socket path, not bcrypt. */
const tokenFor = (user) =>
  jwt.sign({ sub: user.id, username: user.username }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });

async function run() {
  const { users, conversationId } = await seed();

  const connectTimes = [];
  const fanoutLatencies = [];
  const ackLatencies = [];
  let sent = 0;
  let received = 0;
  let errors = 0;

  console.log(`Connecting ${USERS} clients across ${TARGETS.length} instance(s)…`);

  const sockets = await Promise.all(
    users.map(
      (user, i) =>
        new Promise((resolve) => {
          const started = Date.now();
          const socket = io(TARGETS[i % TARGETS.length], {
            transports: ['websocket'],
            auth: (cb) => cb({ token: tokenFor(user) }),
            reconnection: false,
          });

          socket.on('hello', () => {
            connectTimes.push(Date.now() - started);
            resolve(socket);
          });

          socket.on('connect_error', () => {
            errors += 1;
            resolve(null);
          });

          socket.on('message:new', (message) => {
            // Ignore our own: fan-out latency means sender -> OTHER client.
            if (message.senderId === user.id) return;

            const at = Number(message.body.split('|')[1]);
            if (Number.isFinite(at)) {
              fanoutLatencies.push(Date.now() - at);
              received += 1;
            }
          });

          setTimeout(() => resolve(null), 20_000);
        }),
    ),
  );

  const live = sockets.filter(Boolean);
  const instanceIds = new Set(live.map((s) => s.io?.engine?.id).filter(Boolean));
  console.log(`Connected ${live.length}/${USERS} (${errors} failed).`);

  const senders = live.slice(0, Math.min(SENDERS, live.length));
  console.log(`${senders.length} senders emitting every ${SEND_INTERVAL_MS}ms for ${DURATION_MS}ms…`);

  const timers = senders.map((socket, i) =>
    setInterval(() => {
      const startedAt = Date.now();
      sent += 1;

      socket
        .timeout(15_000)
        .emit(
          'message:send',
          {
            conversationId,
            body: `LT|${startedAt}|sender ${i}`,
            clientMsgId: crypto.randomUUID(),
          },
          (timeoutErr, res) => {
            if (timeoutErr || !res?.ok) errors += 1;
            else ackLatencies.push(Date.now() - startedAt);
          },
        );
    }, SEND_INTERVAL_MS),
  );

  await new Promise((resolve) => setTimeout(resolve, DURATION_MS));
  timers.forEach(clearInterval);

  // Let late deliveries land before measuring.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const seconds = DURATION_MS / 1000;
  const fanout = summarise(fanoutLatencies);
  const ack = summarise(ackLatencies);
  const connect = summarise(connectTimes);

  console.log(`
=====================================================
  Load test results
=====================================================
  Instances under test   ${TARGETS.length}  (${TARGETS.join(', ')})
  Connections attempted  ${USERS}
  Connections live       ${live.length}
  Distinct engine ids    ${instanceIds.size}

  Connect time (ms)      p50 ${connect.p50}  p95 ${connect.p95}  max ${connect.max}

  Messages sent          ${sent}
  Ack round-trip (ms)    p50 ${ack.p50}  p95 ${ack.p95}  p99 ${ack.p99}
  Send throughput        ${(sent / seconds).toFixed(1)} msg/s

  Fan-out deliveries     ${received}
  Fan-out latency (ms)   p50 ${fanout.p50}  p95 ${fanout.p95}  p99 ${fanout.p99}
  Delivery throughput    ${(received / seconds).toFixed(1)} deliveries/s

  Errors / timeouts      ${errors}
=====================================================
`);

  live.forEach((s) => s.close());
  await prisma.$disconnect();
  process.exit(0);
}

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
