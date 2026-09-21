import { badRequest } from './http.js';

/* Thin zod wrapper so route handlers read cleanly. */
export const parse = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) {
    const details = Object.fromEntries(
      r.error.issues.map((i) => [i.path.join('.') || '_', i.message])
    );
    throw badRequest('Some fields are not valid', details);
  }
  return r.data;
};
