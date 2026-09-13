import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { search } from '../controllers/user.controller.js';

export const userRouter = Router();

userRouter.use(requireAuth);
userRouter.get('/', search);
