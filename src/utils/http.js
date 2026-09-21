export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest  = (m, d) => new HttpError(400, m, d);
export const unauthorized= (m = 'Sign in to continue') => new HttpError(401, m);
export const forbidden   = (m = 'You do not have permission to do that') => new HttpError(403, m);
export const notFound    = (m = 'Not found') => new HttpError(404, m);
export const conflict    = (m, d) => new HttpError(409, m, d);

// wraps an async route handler so rejections reach the error middleware
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
