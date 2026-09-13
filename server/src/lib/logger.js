import pino from 'pino';
import { env, isProd } from '../config/env.js';
import { instanceId } from './instanceId.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { instanceId },
  // Pretty output in dev; structured JSON in prod where a log shipper reads it.
  transport: isProd
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
});
