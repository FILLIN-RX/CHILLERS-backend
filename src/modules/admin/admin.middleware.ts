import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'chiller-admin-secret-change-me';

export interface AuthRequest extends Request {
    admin?: { username: string };
}

function verifyToken(token: string | undefined, req: AuthRequest, res: Response, next: NextFunction) {
    if (!token) {
        res.status(401).json({ success: false, data: null, message: 'Non autorisé' });
        return;
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET) as { username: string };
        req.admin = decoded;
        next();
    } catch {
        res.status(401).json({ success: false, data: null, message: 'Token invalide ou expiré' });
    }
}

/**
 * Auth admin standard : token dans l'en-tête Authorization uniquement.
 * On n'accepte PAS le token en query string (fuite via logs/Referer/historique).
 */
export function adminMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.split(' ')[1] : undefined;
    verifyToken(token, req, res, next);
}

/**
 * Auth pour les endpoints SSE (EventSource) qui ne peuvent pas envoyer
 * d'en-tête Authorization : on tolère le token en query string, limité
 * à ces seules routes de flux.
 */
export function adminSseMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
    const header = req.headers.authorization;
    const headerToken = header?.startsWith('Bearer ') ? header.split(' ')[1] : undefined;
    const token = headerToken || (req.query.token as string | undefined);
    verifyToken(token, req, res, next);
}
