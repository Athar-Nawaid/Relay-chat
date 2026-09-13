import path from 'node:path';
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
import { isProd } from './config/env.js';

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

  // In production this server also serves the built React client, which makes the
  // app same-origin end to end — so there is no CORS config anywhere, and the
  // refresh cookie is first-party. In dev the Vite proxy achieves the same thing.
  if (isProd) {
    // fileURLToPath, not .pathname: on Windows the latter yields "/D:/..." with
    // a leading slash, which express.static cannot resolve.
    const clientDist = fileURLToPath(new URL('../../client/dist/', import.meta.url));

    app.use(express.static(clientDist));

    // SPA fallback: anything not claimed above gets index.html so client-side
    // routes survive a refresh. API and socket paths are already handled, and
    // reaching here for one of them means it genuinely does not exist.
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
      return res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
