/**
 * An error with an HTTP status and a stable machine-readable code. The code is
 * what both the REST layer and the socket ack protocol surface to the client, so
 * the client can branch on `RATE_LIMITED` vs `NOT_A_MEMBER` without string
 * matching on prose.
 */
export class AppError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (code, msg) => new AppError(400, code, msg);
export const unauthorized = (code = 'UNAUTHORIZED', msg) => new AppError(401, code, msg);
export const forbidden = (code = 'FORBIDDEN', msg) => new AppError(403, code, msg);
export const notFound = (code = 'NOT_FOUND', msg) => new AppError(404, code, msg);
export const conflict = (code = 'CONFLICT', msg) => new AppError(409, code, msg);
export const tooManyRequests = (code = 'RATE_LIMITED', msg) => new AppError(429, code, msg);
