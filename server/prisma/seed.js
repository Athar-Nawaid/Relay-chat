import { hash } from '@node-rs/bcrypt';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const prisma = new PrismaClient();

/**
 * Seeds three demo accounts, one group and two DMs.
 *
 * The demo accounts matter more than they look: the fastest path from a
 * recruiter's click to "oh, it actually works" is opening two tabs as two
 * different users. Never make an evaluator register.
 */
const DEMO_PASSWORD = 'demo1234';

const dmKeyFor = (a, b) => [a, b].sort().join(':');

async function main() {
  const rounds = Number(process.env.BCRYPT_ROUNDS ?? 12);
  const passwordHash = await hash(DEMO_PASSWORD, rounds);

  const specs = [
    { username: 'demo1', displayName: 'Ada', avatarColor: '#6366f1' },
    { username: 'demo2', displayName: 'Grace', avatarColor: '#ec4899' },
    { username: 'demo3', displayName: 'Alan', avatarColor: '#14b8a6' },
  ];

  const users = [];
  for (const spec of specs) {
    users.push(
      await prisma.user.upsert({
        where: { username: spec.username },
        update: {},
        create: { ...spec, passwordHash },
      }),
    );
  }
  const [ada, grace, alan] = users;

  // Two DMs. The dmKey unique constraint makes this idempotent — re-running the
  // seed returns the existing conversations rather than creating duplicates.
  const dmPairs = [
    [ada, grace],
    [ada, alan],
  ];

  for (const [a, b] of dmPairs) {
    await prisma.conversation.upsert({
      where: { dmKey: dmKeyFor(a.id, b.id) },
      update: {},
      create: {
        type: 'dm',
        dmKey: dmKeyFor(a.id, b.id),
        createdById: a.id,
        members: { create: [{ userId: a.id }, { userId: b.id }] },
      },
    });
  }

  // One group. Groups have no dmKey, so guard on title to stay idempotent.
  const existingGroup = await prisma.conversation.findFirst({
    where: { type: 'group', title: 'Engineering' },
  });

  if (!existingGroup) {
    await prisma.conversation.create({
      data: {
        type: 'group',
        title: 'Engineering',
        createdById: ada.id,
        members: {
          create: [
            { userId: ada.id, role: 'owner' },
            { userId: grace.id },
            { userId: alan.id },
          ],
        },
      },
    });
  }

  console.log(
    `Seeded ${users.length} users (demo1/demo2/demo3, password "${DEMO_PASSWORD}"), 2 DMs, 1 group.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
