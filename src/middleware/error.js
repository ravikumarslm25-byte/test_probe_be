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
  /* Two writes to the same attempt at once, and the second lost.
     Returned as a conflict rather than a 500 so the client retries
     against the document as it now stands — which is what makes the
     choice rule hold when a candidate's machine sends two answers in
     the same instant. */
  if (err?.name === 'VersionError') {
    return res.status(409).json({
      error: 'That answer was being saved from somewhere else at the same moment. Try again.',
    });
  }

  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);

  res.status(status).json({
    error: status >= 500 && isProd ? 'Something went wrong on our side' : err.message,
    ...(err.details ? { details: err.details } : {}),
  });
}
