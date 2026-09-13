import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  create,
  history,
  list,
  read,
  show,
} from '../controllers/conversation.controller.js';

export const conversationRouter = Router();

conversationRouter.use(requireAuth);

conversationRouter.get('/', list);
conversationRouter.post('/', create);
conversationRouter.get('/:id', show);
conversationRouter.get('/:id/messages', history);
conversationRouter.post('/:id/read', read);
