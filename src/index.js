import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';

import { env, isProd } from './config/env.js';
import { connectDb } from './config/db.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';
import { storageRoot } from './services/storage.js';
import { attachRealtime, liveStats } from './realtime/live.js';
import { Role } from './models/core.js';
import { SYSTEM_ROLES } from './utils/permissions.js';

import authRoutes from './routes/auth.routes.js';
import institutionRoutes from './routes/institution.routes.js';
import examRoutes from './routes/exam.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import attemptRoutes from './routes/attempt.routes.js';
import settingsRoutes from './routes/settings.routes.js';
import invigilationRoutes from './routes/invigilation.routes.js';
import evaluationRoutes from './routes/evaluation.routes.js';
import reportRoutes from './routes/report.routes.js';
import ticketRoutes from './routes/ticket.routes.js';
import scheduleRoutes from './routes/schedule.routes.js';

const app = express();

/* How many proxies sit in front of the API. nginx alone is 1; CloudFront
   in front of nginx is 2. Too low, and every request appears to come from
   the proxy — the candidate's recorded IP becomes CloudFront's, and the
   per-address rate limit lumps together everyone on the same edge. */
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: env.corsOrigins, credentials: true }));
app.use(express.json({ limit: '25mb' }));   // identity captures and scan pages arrive as data URLs
app.use(cookieParser());
app.use(morgan(isProd ? 'combined' : 'dev'));

/* Limited per signed-in person, not per IP address. A college lab puts
   thirty candidates behind one public address, and a per-IP limit would
   start refusing their autosaves mid-paper. The token is verified before
   it is used as a key — an unverified one could be forged to get a fresh
   allowance on every request. Sign-in has its own stricter limiter. */
const rateKey = (req) => {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    try { return `u:${jwt.verify(h.slice(7), env.accessSecret).sub}`; } catch { /* fall through */ }
  }
  return `ip:${req.ip}`;
};

app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  limit: (req) => (rateKey(req).startsWith('u:') ? 600 : 300),
  keyGenerator: rateKey,
  standardHeaders: true,
  legacyHeaders: false,
}));

/* Local evidence files. On S3 this route is unused — the driver
   returns presigned URLs instead. */
if (process.env.STORAGE_DRIVER !== 's3') {
  app.use('/uploads', express.static(storageRoot, { maxAge: '1h', index: false }));
}

app.get('/api/health', (_req, res) => res.json({
  ok: true, service: 'testprobe', version: '0.1.0',
  time: new Date().toISOString(),
  live: liveStats(),
}));

app.use('/api/auth', authRoutes);
app.use('/api/institution', institutionRoutes);
app.use('/api/exams', examRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/attempts', attemptRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/invigilation', invigilationRoutes);
app.use('/api/evaluation', evaluationRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/schedule', scheduleRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

/* System roles are defined in code. The database copy is updated on
   every boot so a permission added to the definition reaches an
   institution that was seeded before it existed. Custom roles are
   never touched. */
async function syncSystemRoles() {
  let changed = 0;
  for (const spec of SYSTEM_ROLES) {
    /* Matched by name, not by the isSystem flag: an institution seeded
       before a role was marked as a system role would otherwise never
       receive a permission added to the definition. The flag is
       repaired here at the same time. */
    const r = await Role.updateMany(
      { name: spec.name },
      { $set: {
        permissions: spec.permissions,
        scope: spec.scope,
        description: spec.description,
        isSystem: true,
      } },
    );
    changed += r.modifiedCount;
  }
  if (changed) console.log(`[roles] ${changed} system role(s) brought up to date`);
  else console.log('[roles] system roles already current');
}

const start = async () => {
  await connectDb();
  await syncSystemRoles();
  const server = app.listen(env.port, () => {
    console.log(`[api] Test Probe listening on http://localhost:${env.port}/api`);
  });
  attachRealtime(server);
};

start().catch((e) => {
  console.error('[boot] failed to start', e);
  process.exit(1);
});

export default app;
