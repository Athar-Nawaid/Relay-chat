import { verifyAccessToken } from '../services/token.service.js';
import { logger } from '../lib/logger.js';

/**
 * Authenticates the WebSocket handshake.
 *
 * The token arrives in `socket.handshake.auth` rather than via the cookie. The
 * cookie would in fact work here, since the app is same-origin — but the explicit
 * payload is transport-agnostic, so it keeps working cross-origin and for a
 * future native client that has no cookie jar.
 *
 * The client MUST supply `auth` as a callback, not an object literal. The
 * callback is re-invoked on every reconnect attempt, so a token refreshed after
 * expiry is picked up automatically. An object literal snapshots the token once
 * at construction — which is the classic bug where everything works for fifteen
 * minutes and then reconnect-loops forever.
 */
export function authSocket(socket, next) {
  const token = socket.handshake.auth?.token;

  if (!token) {
    const err = new Error('unauthorized');
    err.data = { code: 'AUTH_REQUIRED' };
    return next(err);
  }

  try {
    const payload = verifyAccessToken(token);
    socket.data.userId = payload.sub;
    socket.data.username = payload.username;
    socket.data.exp = payload.exp; // seconds since epoch
    return next();
  } catch (cause) {
    const err = new Error('unauthorized');
    err.data = { code: cause?.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'AUTH_FAILED' };
    return next(err);
  }
}

const SWEEP_INTERVAL_MS = 60_000;

/**
 * Disconnects sockets whose access token has expired.
 *
 * Without this, a JWT verified once at handshake stays effectively valid for the
 * entire life of the connection — potentially hours past its `exp`. A long-lived
 * WebSocket quietly converts a 15-minute token into an unbounded session, which
 * defeats the short expiry entirely.
 *
 * Clients are warned via `auth:expired` first so they can refresh and reconnect
 * cleanly rather than just seeing a dropped socket.
 */
export function startTokenExpirySweep(io) {
  const timer = setInterval(() => {
    const now = Math.floor(Date.now() / 1000);

    for (const socket of io.of('/').sockets.values()) {
      if (typeof socket.data.exp === 'number' && socket.data.exp <= now) {
        logger.debug({ userId: socket.data.userId }, 'disconnecting socket with expired token');
        socket.emit('auth:expired');
        socket.disconnect(true);
      }
    }
  }, SWEEP_INTERVAL_MS);

  timer.unref();
  return () => clearInterval(timer);
}
