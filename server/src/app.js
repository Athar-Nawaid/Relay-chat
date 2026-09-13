import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { healthRouter } from './http/routes/health.js';
import { authRouter } from './http/routes/auth.js';
import { conversationRouter } from './http/routes/conversations.js';
import { userRouter } from './http/routes/users.js';
import { errorHandler, notFoundHandler } from './http/middleware/errorHandler.js';
import { logger } from './lib/logger.js';

export function createApp() {
  const app = express();

  // Behind Fly/Render. Without this, express-rate-limit keys every client to the
  // proxy's IP and rate-limits the whole world as one bucket.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());

  // Health is registered before the rate limiter so platform health checks and
  // uptime pings are never throttled.
  app.use(healthRouter);

  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
    }),
  );

  app.use('/api/auth', authRouter);
  app.use('/api/conversations', conversationRouter);
  app.use('/api/users', userRouter);

  // Serve the built client when a build exists — deliberately NOT gated on
  // NODE_ENV.
  //
  // It was, and that cost a deployment: Render did not have NODE_ENV set, so the
  // app ran in development mode, never mounted this, and answered "/" with a
  // JSON 404 from the not-found handler. A missing environment variable should
  // not silently change what the server serves. The presence of a build is the
  // honest signal, and it is what actually determines whether we CAN serve it.
  //
  // fileURLToPath, not .pathname: on Windows the latter yields "/D:/..." with a
  // leading slash, which express.static cannot resolve.
  const clientDist = fileURLToPath(new URL('../../client/dist/', import.meta.url));
  const indexHtml = path.join(clientDist, 'index.html');

  if (existsSync(indexHtml)) {
    app.use(express.static(clientDist));

    // SPA fallback: anything not claimed above gets index.html so client-side
    // routes survive a refresh. API and socket paths fall through to the
    // not-found handler, because reaching here means they genuinely do not exist.
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
      return res.sendFile(indexHtml);
    });

    logger.info({ clientDist }, 'serving client build');
  } else {
    logger.warn(
      { clientDist },
      'no client build found — API only. Run `npm run build` to serve the UI.',
    );
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
