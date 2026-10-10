import http from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { instanceId } from './lib/instanceId.js';
import { connectPostgres, disconnectPostgres } from './config/postgres.js';
import { connectMongo, disconnectMongo } from './config/mongo.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { createIo } from './realtime/io.js';
import sendEmail from './services/mail.service.js';

async function main() {
  // Connect before listening, so the process never accepts traffic it cannot serve.
  await Promise.all([connectPostgres(), connectMongo(), connectRedis()]);

  // Non-blocking notification email on startup so SMTP issues do not crash the server
  sendEmail({
    to: 'atharnawaid11@gmail.com',
    subject: 'Relay was visited',
    text: 'Relay project was visited',
  }).catch((err) => {
    logger.warn({ err }, 'Failed to send visit notification email');
  });

  const app = createApp();
  const server = http.createServer(app);
  const io = createIo(server);
  // So HTTP handlers can reach the socket layer — creating a conversation needs
  // to pull existing sockets into the new room.
  app.set('io', io);

  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, instanceId, env: env.NODE_ENV }, 'server listening');
  });


  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 10_000).unref();


    await io.shutdown().catch(() => {});
    server.close();
    await Promise.allSettled([disconnectPostgres(), disconnectMongo(), disconnectRedis()]);
    clearTimeout(force);
    logger.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled promise rejection');
  });
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
