import crypto from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/config/postgres.js';

const app = createApp();

// Unique per run so repeated runs never collide, and so the assertions never
// depend on seed data that another test might have changed.
const username = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const password = 'correct-horse-battery';

/** Pulls the refresh cookie value out of a set-cookie header. */
function refreshCookie(res) {
  const raw = res.headers['set-cookie']?.find((c) => c.startsWith('rt='));
  return raw?.split(';')[0];
}

let userId;

/** Looks up which rotation family a cookie's token belongs to. */
async function familyIdOf(cookie) {
  const token = cookie.slice('rt='.length);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  return row.familyId;
}

afterAll(async () => {
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  await prisma.$disconnect();
});

describe('registration', () => {
  it('creates an account and returns an access token', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username, password, displayName: 'Test User' })
      .expect(201);

    userId = res.body.user.id;
    expect(res.body.user.username).toBe(username);
    expect(res.body.accessToken).toBeTruthy();
    expect(refreshCookie(res)).toBeTruthy();
  });

  it('never returns the password hash', async () => {
    const res = await request(app).post('/api/auth/login').send({ username, password }).expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  it('rejects a duplicate username', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username, password })
      .expect(409);
    expect(res.body.error.code).toBe('USERNAME_TAKEN');
  });

  it('rejects a duplicate username differing only in case', async () => {
    // citext is what enforces this, not application code.
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: username.toUpperCase(), password })
      .expect(409);
    expect(res.body.error.code).toBe('USERNAME_TAKEN');
  });

  it('rejects a short password', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: `${username}x`, password: 'short' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('login', () => {
  it('gives the same error for a wrong password and an unknown user', async () => {
    const wrongPass = await request(app)
      .post('/api/auth/login')
      .send({ username, password: 'not-the-password' })
      .expect(401);

    const unknownUser = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nosuchuser_zzz', password })
      .expect(401);

    // Identical responses, so neither reveals whether the account exists.
    expect(wrongPass.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknownUser.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('protected routes', () => {
  it('rejects a request with no bearer token', async () => {
    const res = await request(app).get('/api/auth/me').expect(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('rejects a forged token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not.a.jwt')
      .expect(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('returns the current user for a valid token', async () => {
    const login = await request(app).post('/api/auth/login').send({ username, password });

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(200);

    expect(res.body.user.id).toBe(userId);
  });
});

describe('refresh token rotation and reuse detection', () => {
  it('rotates the token and issues a different one', async () => {
    const login = await request(app).post('/api/auth/login').send({ username, password });
    const first = refreshCookie(login);

    const refreshed = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', first)
      .expect(200);

    expect(refreshCookie(refreshed)).not.toBe(first);
    expect(refreshed.body.accessToken).toBeTruthy();
  });

  it('revokes the whole family when a used token is replayed', async () => {
    const login = await request(app).post('/api/auth/login').send({ username, password });
    const stolen = refreshCookie(login);

    // Legitimate rotation burns `stolen` and issues `fresh`.
    const rotated = await request(app).post('/api/auth/refresh').set('Cookie', stolen).expect(200);
    const fresh = refreshCookie(rotated);

    // The attacker replays the old one.
    const replay = await request(app).post('/api/auth/refresh').set('Cookie', stolen).expect(401);
    expect(replay.body.error.code).toBe('REFRESH_REUSED');

    // The victim's still-unused token must now be dead too — that is the whole
    // point of family revocation: we cannot tell thief from victim, so both stop.
    //
    // It reports REFRESH_REUSED rather than a distinct "revoked" code because a
    // token killed by family revocation is indistinguishable from a replayed one
    // — both simply carry revokedAt. Failing closed on either is the correct
    // outcome, and re-revoking an already-revoked family is idempotent.
    const victim = await request(app).post('/api/auth/refresh').set('Cookie', fresh).expect(401);
    expect(victim.body.error.code).toBe('REFRESH_REUSED');
  });

  it('revokes only the compromised family, not every session', async () => {
    // Two independent logins — think two devices.
    const deviceA = await request(app).post('/api/auth/login').send({ username, password });
    const deviceB = await request(app).post('/api/auth/login').send({ username, password });

    const stolenA = refreshCookie(deviceA);
    const familyB = await familyIdOf(refreshCookie(deviceB));

    // Compromise device A: rotate, then replay the burned token.
    await request(app).post('/api/auth/refresh').set('Cookie', stolenA).expect(200);
    await request(app).post('/api/auth/refresh').set('Cookie', stolenA).expect(401);

    const liveInA = await prisma.refreshToken.count({
      where: { familyId: await familyIdOf(stolenA), revokedAt: null },
    });
    const liveInB = await prisma.refreshToken.count({
      where: { familyId: familyB, revokedAt: null },
    });

    expect(liveInA).toBe(0); // the compromised chain is fully dead
    expect(liveInB).toBe(1); // the unrelated device is untouched
  });

  it('rejects a refresh with no cookie', async () => {
    const res = await request(app).post('/api/auth/refresh').expect(401);
    expect(res.body.error.code).toBe('REFRESH_MISSING');
  });
});

describe('logout', () => {
  it('makes the refresh token unusable', async () => {
    const login = await request(app).post('/api/auth/login').send({ username, password });
    const cookie = refreshCookie(login);

    await request(app).post('/api/auth/logout').set('Cookie', cookie).expect(204);
    await request(app).post('/api/auth/refresh').set('Cookie', cookie).expect(401);
  });
});
