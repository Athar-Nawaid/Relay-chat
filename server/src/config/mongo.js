import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from '../lib/logger.js';

export async function connectMongo() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.MONGO_URL, { serverSelectionTimeoutMS: 10000 });

  // Build the unique {senderId, clientMsgId} index before serving traffic —
  // idempotent sends depend on it existing, and Mongoose builds indexes lazily
  // in the background otherwise.
  await mongoose.connection.syncIndexes();

  logger.info('mongo connected');
}

export async function disconnectMongo() {
  await mongoose.connection.close();
}

export async function pingMongo() {
  await mongoose.connection.db.admin().ping();
  return true;
}
