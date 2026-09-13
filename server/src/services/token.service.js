import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../config/postgres.js';
import { unauthorized } from '../lib/errors.js';

/**
 * Two token types, deliberately different in kind.
 *
 * The ACCESS token is a short-lived JWT — stateless, so every request and every
 * socket handshake can be authorised without touching Postgres. The client holds
 * it in memory only.
 *
 * The REFRESH token is NOT a JWT. It is opaque random bytes, and only its sha256
 * is stored, so a database leak does not hand an attacker usable sessions. Being
 * stateful is the entire point: it can be revoked, which a JWT cannot.
 */

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function signAccessToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, env.JWT_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL,
    jwtid: crypto.randomUUID(),
  });
}

/** Throws on invalid/expired token. Callers translate that into their own error shape. */
export function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_SECRET);
}

function refreshExpiry() {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Mints a refresh token. Omitting `familyId` starts a new rotation family, which
 * is what a fresh login does; passing one continues an existing chain.
 */
export async function issueRefreshToken({ userId, familyId, userAgent }, client = prisma) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = refreshExpiry();

  await client.refreshToken.create({
    data: {
      userId,
      tokenHash: sha256(token),
      familyId: familyId ?? crypto.randomUUID(),
      userAgent: userAgent?.slice(0, 255) ?? null,
      expiresAt,
    },
  });

  return { token, expiresAt };
}

/**
 * Rotates a refresh token, with reuse detection.
 *
 * Every refresh burns the presented token and issues a new one in the same family.
 * So a token that is presented twice means someone is replaying a stolen copy —
 * and since we cannot tell the thief from the victim, the safe move is to revoke
 * the *entire family* and force a re-login. That contains the theft to one refresh
 * cycle instead of the full token lifetime.
 */
export async function rotateRefreshToken({ presented, userAgent }) {
  const tokenHash = sha256(presented);

  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!existing) throw unauthorized('REFRESH_INVALID', 'Refresh token not recognised');

  if (existing.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { familyId: existing.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw unauthorized('REFRESH_REUSED', 'Refresh token reuse detected — all sessions revoked');
  }

  if (existing.expiresAt <= new Date()) {
    throw unauthorized('REFRESH_EXPIRED', 'Refresh token has expired');
  }

  // Revoke-and-reissue must be atomic, or a crash between the two leaves the user
  // holding a token that no longer works and no replacement.
  const { token, expiresAt } = await prisma.$transaction(async (tx) => {
    await tx.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });

    return issueRefreshToken(
      { userId: existing.userId, familyId: existing.familyId, userAgent },
      tx,
    );
  });

  return { token, expiresAt, user: existing.user };
}

/** Revokes a single token (logout on this device). Silent if already gone. */
export async function revokeRefreshToken(presented) {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: sha256(presented), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Revokes every live token for a user (logout everywhere / password change). */
export async function revokeAllForUser(userId) {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
