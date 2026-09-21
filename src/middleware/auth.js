import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { env, isProd } from '../config/env.js';
import { User, Student, Role, Mapping } from '../models/core.js';
import { unauthorized, forbidden } from '../utils/http.js';

const COOKIE_BASE = 'egx_rt';
const cookieName = (kind) => `${COOKIE_BASE}_${kind === 'student' ? 'student' : 'staff'}`;

/* ---------------- token issue / verify ---------------- */
export function signAccess(payload) {
  return jwt.sign(payload, env.accessSecret, { expiresIn: env.accessTtl });
}
export function signRefresh(payload) {
  return jwt.sign(payload, env.refreshSecret, { expiresIn: env.refreshTtl });
}
export const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function setRefreshCookie(res, token, kind) {
  res.cookie(cookieName(kind), token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'strict' : 'lax',
    path: '/api/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function clearRefreshCookie(res, kind) {
  if (kind) res.clearCookie(cookieName(kind), { path: '/api/auth' });
  else {
    res.clearCookie(cookieName('staff'), { path: '/api/auth' });
    res.clearCookie(cookieName('student'), { path: '/api/auth' });
  }
}

/* The caller says which session it wants, because a browser may hold
   both. Falling back to whichever exists keeps a single-session tab
   working without the hint. */
export const readRefreshCookie = (req, kind) => {
  if (kind) return req.cookies?.[cookieName(kind)];
  return req.cookies?.[cookieName('staff')] || req.cookies?.[cookieName('student')];
};

/* ---------------- authenticate ----------------
   Populates req.actor with identity, permissions and scope.
   Permissions are resolved from roles on every request rather
   than baked into the token, so a role change takes effect
   immediately instead of at next sign-in.                    */
export async function authenticate(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthorized();

    let claims;
    try {
      claims = jwt.verify(token, env.accessSecret);
    } catch {
      throw unauthorized('Your session has expired');
    }

    if (claims.kind === 'student') {
      const student = await Student.findById(claims.sub).lean();
      if (!student || student.status !== 'active') throw unauthorized();
      req.actor = {
        kind: 'student',
        id: String(student._id),
        institutionId: String(student.institutionId),
        name: student.name,
        regNo: student.regNo,
        batchId: String(student.batchId),
        permissions: new Set(),
        scope: 'own',
      };
      return next();
    }

    const user = await User.findById(claims.sub).populate('roleIds').lean();
    if (!user || user.status !== 'active') throw unauthorized();

    const roles = user.roleIds || [];
    const permissions = new Set(roles.flatMap((r) => r.permissions || []));

    // widest scope held across all roles wins
    const rank = { own: 0, department: 1, institution: 2 };
    const scope = roles.reduce((best, r) =>
      rank[r.scope] > rank[best] ? r.scope : best, 'own');

    req.actor = {
      kind: 'staff',
      id: String(user._id),
      institutionId: String(user.institutionId),
      name: user.name,
      email: user.email,
      departmentId: user.departmentId ? String(user.departmentId) : null,
      roles: roles.map((r) => ({ id: String(r._id), name: r.name, scope: r.scope })),
      roleNames: roles.map((r) => r.name),
      permissions,
      scope,
      mustResetPassword: user.mustResetPassword,
    };
    next();
  } catch (e) { next(e); }
}

/* ---------------- permission guard ---------------- */
export const can = (...required) => (req, _res, next) => {
  if (!req.actor) return next(unauthorized());
  if (req.actor.kind === 'student') return next(forbidden());
  const ok = required.some((p) => req.actor.permissions.has(p));
  if (!ok) return next(forbidden(`Requires ${required.join(' or ')}`));
  next();
};

export const studentOnly = (req, _res, next) => {
  if (req.actor?.kind !== 'student') return next(forbidden());
  next();
};

/* ---------------- tenant filter ----------------
   Never trust an institutionId from the client. Every query
   is scoped to the actor's own institution.                 */
export const tenant = (req) => ({ institutionId: req.actor.institutionId });

/* ---------------- data scoping ----------------
   Resolves which batches and subjects the actor may see.
   Institution scope returns null, meaning "no restriction". */
export async function resolveScope(actor) {
  if (actor.scope === 'institution') return null;

  const maps = await Mapping.find({
    institutionId: actor.institutionId,
    staffId: actor.id,
  }).lean();

  return {
    batchIds:   [...new Set(maps.map((m) => String(m.batchId)))],
    subjectIds: [...new Set(maps.filter((m) => m.subjectId).map((m) => String(m.subjectId)))],
    departmentId: actor.departmentId,
  };
}

/* Applies a resolved scope to a query filter for student-bearing collections. */
export function scopeStudents(filter, scope) {
  if (!scope) return filter;
  return { ...filter, batchId: { $in: scope.batchIds } };
}

export function scopeSubjects(filter, scope) {
  if (!scope) return filter;
  return { ...filter, subjectId: { $in: scope.subjectIds } };
}

export { cookieName };
