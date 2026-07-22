import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'chiller-admin-secret-change-me';

export interface AuthRequest extends Request {
    admin?: { username: string };
}

export function adminMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
    const header = req.headers.authorization;
    const queryToken = req.query.token as string | undefined;
    const token = (header?.startsWith('Bearer ') ? header.split(' ')[1] : null) || queryToken;
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
