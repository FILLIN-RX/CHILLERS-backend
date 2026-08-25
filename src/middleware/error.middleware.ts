import { Request, Response, NextFunction } from 'express';
import { AppError } from '../types';

export const errorMiddleware = (
  err: AppError | any,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const statusCode = err.statusCode || err.response?.status || 500;
  const internalMessage = err.response?.data?.status_message || err.message || 'Internal server error';

  console.error(`[ERROR] ${statusCode} - ${internalMessage}`);

  const clientMessage = statusCode < 500 ? internalMessage : 'Internal server error';

  res.status(statusCode).json({
    success: false,
    data: null,
    message: clientMessage,
  });
};
