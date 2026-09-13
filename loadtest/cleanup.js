import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import mongoose from 'mongoose';

/** Removes everything the load generator created. */
const prisma = new PrismaClient();

const conversation = await prisma.conversation.findFirst({
  where: { type: 'group', title: 'loadtest' },
});

if (conversation) {
  await mongoose.connect(process.env.MONGO_URL);
  const { deletedCount } = await mongoose.connection
    .collection('messages')
    .deleteMany({ conversationId: conversation.id });
  console.log(`removed ${deletedCount} load-test messages`);
  await mongoose.connection.close();

  await prisma.conversation.delete({ where: { id: conversation.id } });
}

const { count } = await prisma.user.deleteMany({ where: { username: { startsWith: 'loadtest_' } } });
console.log(`removed ${count} load-test users`);

await prisma.$disconnect();
