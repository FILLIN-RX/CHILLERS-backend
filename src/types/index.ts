export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T | null;
  message: string | null;
}

export class AppError extends Error {
  public statusCode: number;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}
