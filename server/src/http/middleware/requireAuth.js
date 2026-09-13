import { prisma } from '../../config/postgres.js';
import { unauthorized } from '../../lib/errors.js';
import { verifyAccessToken } from '../../services/token.service.js';

/**
 * Authenticates from the Authorization header. The access token is a JWT
 * precisely so this is a signature check rather than a database round trip on
 * every request.
 */
export function requireAuth(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(unauthorized('AUTH_REQUIRED', 'Missing bearer token'));
  }

  try {
    const payload = verifyAccessToken(token);
    req.auth = { userId: payload.sub, username: payload.username, exp: payload.exp };
    return next();
  } catch (err) {
    const expired = err?.name === 'TokenExpiredError';
    return next(
      unauthorized(
        expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
        expired ? 'Access token expired' : 'Access token invalid',
      ),
    );
  }
}

/**
 * Loads the full user row onto `req.user`. Separate from requireAuth so routes
 * that only need an id stay free of a database hit.
 */
export async function loadUser(req, _res, next) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.auth.userId } });
    if (!user) return next(unauthorized('USER_GONE', 'Account no longer exists'));
    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
}
