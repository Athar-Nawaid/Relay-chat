import { Router } from 'express';
import { pingPostgres } from '../../config/postgres.js';
import { pingMongo } from '../../config/mongo.js';
import { pingRedis } from '../../config/redis.js';
import { instanceId } from '../../lib/instanceId.js';

export const healthRouter = Router();

async function check(fn) {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * Reports which of the three stores this instance can actually reach, plus the
 * instance id — which is what makes a multi-instance deploy visible from outside.
 */
healthRouter.get('/healthz', async (_req, res) => {
  const [postgres, mongo, redis] = await Promise.all([
    check(pingPostgres),
    check(pingMongo),
    check(pingRedis),
  ]);

  const ok = postgres.ok && mongo.ok && redis.ok;
  res.status(ok ? 200 : 503).json({
    ok,
    instanceId,
    uptimeSeconds: Math.round(process.uptime()),
    dependencies: { postgres, mongo, redis },
  });
});
