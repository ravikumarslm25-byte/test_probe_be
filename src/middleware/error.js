import { HttpError } from '../utils/http.js';
import { isProd } from '../config/env.js';

export function notFoundHandler(req, _res, next) {
  next(new HttpError(404, `No route for ${req.method} ${req.originalUrl}`));
}

export function errorHandler(err, _req, res, _next) {
  // mongoose duplicate key
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern || {}).join(', ');
    return res.status(409).json({ error: `That ${field || 'record'} already exists` });
  }
  // mongoose validation
  if (err?.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Some fields are not valid',
      details: Object.fromEntries(Object.entries(err.errors).map(([k, v]) => [k, v.message])),
    });
  }
  if (err?.name === 'CastError') {
    return res.status(400).json({ error: `Invalid ${err.path}` });
  }

  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);

  res.status(status).json({
    error: status >= 500 && isProd ? 'Something went wrong on our side' : err.message,
    ...(err.details ? { details: err.details } : {}),
  });
}
