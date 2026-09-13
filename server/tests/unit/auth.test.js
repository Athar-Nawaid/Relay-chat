import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { signAccessToken, verifyAccessToken } from '../../src/services/token.service.js';
import { authSocket } from '../../src/realtime/authSocket.js';

const user = { id: '11111111-1111-4111-8111-111111111111', username: 'demo1' };

/** Minimal stand-in for a socket.io socket during the handshake. */
function fakeSocket(auth) {
  return { handshake: { auth }, data: {} };
}

/** Runs the middleware and reports what it passed to next(). */
function runHandshake(auth) {
  return new Promise((resolve) => {
    const socket = fakeSocket(auth);
    authSocket(socket, (err) => resolve({ err, socket }));
  });
}

describe('access tokens', () => {
  it('round-trips the user id and username', () => {
    const payload = verifyAccessToken(signAccessToken(user));
    expect(payload.sub).toBe(user.id);
    expect(payload.username).toBe('demo1');
  });

  it('gives every token a unique jti', () => {
    const a = verifyAccessToken(signAccessToken(user));
    const b = verifyAccessToken(signAccessToken(user));
    expect(a.jti).not.toBe(b.jti);
  });

  it('rejects a token signed with the wrong secret', () => {
    const forged = jwt.sign({ sub: user.id }, 'not-the-real-secret-but-long-enough-abc');
    expect(() => verifyAccessToken(forged)).toThrow();
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: -10 });
    expect(() => verifyAccessToken(expired)).toThrow(/expired/i);
  });
});

describe('socket handshake auth', () => {
  it('accepts a valid token and populates socket.data', async () => {
    const { err, socket } = await runHandshake({ token: signAccessToken(user) });

    expect(err).toBeUndefined();
    expect(socket.data.userId).toBe(user.id);
    expect(socket.data.username).toBe('demo1');
    expect(typeof socket.data.exp).toBe('number');
  });

  it('rejects a handshake with no token', async () => {
    const { err } = await runHandshake({});
    expect(err.data.code).toBe('AUTH_REQUIRED');
  });

  it('rejects a garbage token with AUTH_FAILED', async () => {
    const { err } = await runHandshake({ token: 'not-a-jwt' });
    expect(err.data.code).toBe('AUTH_FAILED');
  });

  it('distinguishes an expired token from an invalid one', async () => {
    const expired = jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: -10 });
    const { err } = await runHandshake({ token: expired });
    expect(err.data.code).toBe('TOKEN_EXPIRED');
  });

  it('never trusts a user id supplied in the handshake payload', async () => {
    // Identity must come from the signed token, never from client-controlled fields.
    const { socket } = await runHandshake({
      token: signAccessToken(user),
      userId: 'attacker-supplied-id',
    });

    expect(socket.data.userId).toBe(user.id);
  });
});
