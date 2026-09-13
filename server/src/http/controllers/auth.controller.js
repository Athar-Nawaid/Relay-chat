import { z } from 'zod';
import { isProd, env } from '../../config/env.js';
import { badRequest, unauthorized } from '../../lib/errors.js';
import { authenticate, publicUser, registerUser } from '../../services/auth.service.js';
import {
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
} from '../../services/token.service.js';

const REFRESH_COOKIE = 'rt';

/**
 * Path-scoped so the refresh token is only ever sent to the endpoints that need
 * it — it never rides along on ordinary API calls. SameSite=Lax is sufficient
 * because the client is same-origin in both dev (Vite proxy) and prod (Express
 * serves the build), which is also why this app has no CORS configuration at all.
 */
const cookieOptions = () => ({
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax',
  path: '/api/auth',
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
});

const credentials = z.object({
  username: z
    .string()
    .trim()
    .min(3, 'Username must be at least 3 characters')
    .max(32)
    .regex(/^[a-zA-Z0-9_]+$/, 'Username may contain only letters, numbers and underscores'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

const registerSchema = credentials.extend({
  displayName: z.string().trim().min(1).max(40).optional(),
});

function parse(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw badRequest('VALIDATION_FAILED', result.error.issues[0].message);
  }
  return result.data;
}

async function establishSession(res, user, req) {
  const { token } = await issueRefreshToken({
    userId: user.id,
    userAgent: req.get('user-agent'),
  });

  res.cookie(REFRESH_COOKIE, token, cookieOptions());

  return { accessToken: signAccessToken(user), user: publicUser(user) };
}

export async function register(req, res, next) {
  try {
    const { username, displayName, password } = parse(registerSchema, req.body);
    const user = await registerUser({ username, displayName, password });
    res.status(201).json(await establishSession(res, user, req));
  } catch (err) {
    next(err);
  }
}

export async function login(req, res, next) {
  try {
    const { username, password } = parse(credentials, req.body);
    const user = await authenticate({ username, password });
    res.json(await establishSession(res, user, req));
  } catch (err) {
    next(err);
  }
}

export async function refresh(req, res, next) {
  try {
    const presented = req.cookies?.[REFRESH_COOKIE];
    if (!presented) throw unauthorized('REFRESH_MISSING', 'No refresh token supplied');

    const { token, user } = await rotateRefreshToken({
      presented,
      userAgent: req.get('user-agent'),
    });

    res.cookie(REFRESH_COOKIE, token, cookieOptions());
    res.json({ accessToken: signAccessToken(user), user: publicUser(user) });
  } catch (err) {
    // A dead refresh token should leave the browser clean rather than retrying
    // with the same bad value forever.
    if (err?.status === 401) res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    next(err);
  }
}

export async function logout(req, res, next) {
  try {
    const presented = req.cookies?.[REFRESH_COOKIE];
    if (presented) await revokeRefreshToken(presented);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export function me(req, res) {
  res.json({ user: publicUser(req.user) });
}
