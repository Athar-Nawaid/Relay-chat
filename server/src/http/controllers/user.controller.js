import { z } from 'zod';
import { prisma } from '../../config/postgres.js';
import { badRequest } from '../../lib/errors.js';

const searchSchema = z.object({
  q: z.string().trim().min(1, 'Search query required').max(32),
  limit: z.coerce.number().int().positive().max(25).optional(),
});

export async function search(req, res, next) {
  try {
    const parsed = searchSchema.safeParse(req.query);
    if (!parsed.success) throw badRequest('VALIDATION_FAILED', parsed.error.issues[0].message);

    const { q, limit = 10 } = parsed.data;

    const users = await prisma.user.findMany({
      where: {
        // citext makes username matching case-insensitive without a mode flag;
        // displayName is plain text, so it needs one.
        AND: [
          { id: { not: req.auth.userId } },
          {
            OR: [
              { username: { contains: q } },
              { displayName: { contains: q, mode: 'insensitive' } },
            ],
          },
        ],
      },
      select: { id: true, username: true, displayName: true, avatarColor: true },
      orderBy: { username: 'asc' },
      take: limit,
    });

    res.json({ users });
  } catch (err) {
    next(err);
  }
}
