import { hash, verify } from '@node-rs/bcrypt';
import { prisma } from '../config/postgres.js';
import { env } from '../config/env.js';
import { conflict, unauthorized } from '../lib/errors.js';

const AVATAR_COLORS = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#ef4444'];
const pickColor = () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

/** The shape safe to send to a client. Never includes passwordHash. */
export const publicUser = (user) => ({
  id: user.id,
  username: user.username,
  displayName: user.displayName,
  avatarColor: user.avatarColor,
});

export async function registerUser({ username, displayName, password }) {
  // The unique constraint is the real guard — this check just produces a nicer
  // error than a raw P2002 in the common case.
  const taken = await prisma.user.findUnique({ where: { username } });
  if (taken) throw conflict('USERNAME_TAKEN', 'That username is already registered');

  const passwordHash = await hash(password, env.BCRYPT_ROUNDS);

  try {
    return await prisma.user.create({
      data: {
        username,
        displayName: displayName || username,
        passwordHash,
        avatarColor: pickColor(),
      },
    });
  } catch (err) {
    // Lost the race between the check above and the insert.
    if (err?.code === 'P2002') {
      throw conflict('USERNAME_TAKEN', 'That username is already registered');
    }
    throw err;
  }
}

export async function authenticate({ username, password }) {
  const user = await prisma.user.findUnique({ where: { username } });

  // Same error and roughly the same work either way, so the response does not
  // reveal whether the username exists.
  if (!user) {
    await hash(password, env.BCRYPT_ROUNDS);
    throw unauthorized('INVALID_CREDENTIALS', 'Incorrect username or password');
  }

  const ok = await verify(password, user.passwordHash);
  if (!ok) throw unauthorized('INVALID_CREDENTIALS', 'Incorrect username or password');

  return user;
}
