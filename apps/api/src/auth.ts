import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { HttpError } from './errors.js';

export type Role = 'SELLER' | 'BIDDER';
export interface SessionUser { id: string; publicId: string; displayName: string; email: string; role: Role }

// Express expõe a extensão de Request por declaration merging via namespace.
/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  namespace Express {
    interface Request { user?: SessionUser }
  }
}

export function setSessionCookie(res: Response, user: SessionUser) {
  const token = jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: '7d' });
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(config.cookieName, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/' });
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[config.cookieName] as string | undefined;
    if (token) {
      const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
      if (typeof payload.sub === 'string' && (payload.role === 'SELLER' || payload.role === 'BIDDER')) {
        req.user = { id: payload.sub, role: payload.role, publicId: '', displayName: '', email: '' };
      }
    }
  } catch { /* Sessão expirada ou inválida: rotas públicas seguem acessíveis. */ }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Entre na sua conta para continuar.', 'AUTH_REQUIRED'));
  next();
}

export function requireRole(role: Role) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, 'Entre na sua conta para continuar.', 'AUTH_REQUIRED'));
    if (req.user.role !== role) return next(new HttpError(403, 'Seu perfil não pode executar esta ação.', 'ROLE_FORBIDDEN'));
    next();
  };
}
