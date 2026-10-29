import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';

const SECRET = process.env.JWT_SECRET ?? 'dev-secret';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  try {
    jwt.verify(token ?? '', SECRET);
    next();
  } catch {
    res.status(401).end();
  }
}
