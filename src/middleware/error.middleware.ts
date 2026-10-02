import { Request, Response, NextFunction } from 'express';
import { AppError } from '../types';

export const errorMiddleware = (
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const statusCode = err.statusCode || 500;
  const internalMessage = err.message || 'Internal server error';

  console.error(`[ERROR] ${statusCode} - ${internalMessage}`);

  // On ne renvoie le détail au client que pour les erreurs "attendues"
  // (< 500, typiquement des AppError de validation). Pour les 500, message
  // générique afin de ne pas fuiter d'information interne.
  const clientMessage = statusCode < 500 ? internalMessage : 'Internal server error';

  res.status(statusCode).json({
    success: false,
    data: null,
    message: clientMessage,
  });
};
