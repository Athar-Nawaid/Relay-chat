import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { login, logout, me, refresh, register } from '../controllers/auth.controller.js';
import { loadUser, requireAuth } from '../middleware/requireAuth.js';

export const authRouter = Router();

/**
 * Tighter than the global /api limit. Login and register are the endpoints worth
 * brute-forcing, and bcrypt at cost 12 makes each attempt expensive for us too —
 * so an unthrottled login endpoint is also a cheap CPU exhaustion vector.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again later' } },
});

authRouter.post('/register', authLimiter, register);
authRouter.post('/login', authLimiter, login);
authRouter.post('/refresh', refresh);
authRouter.post('/logout', logout);
authRouter.get('/me', requireAuth, loadUser, me);
