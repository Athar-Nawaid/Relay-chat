import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { isProd } from '../../config/env.js';

// The unused 4th parameter is required: Express identifies error handlers by arity.
export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }

  logger.error({ err, path: req.path, method: req.method }, 'unhandled request error');

  return res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: isProd ? 'Internal server error' : String(err?.message ?? err),
    },
  });
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.path}` } });
}
