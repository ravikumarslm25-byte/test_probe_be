import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import { env, isProd } from './config/env.js';
import { connectDb } from './config/db.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';
import { storageRoot } from './services/storage.js';
import { attachRealtime, liveStats } from './realtime/live.js';
import { Role, Institution } from './models/core.js';
import { Exam } from './models/exam.js';
import { zonedToUtc, DEFAULT_TIMEZONE } from './utils/time.js';
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
import qbankRoutes from './routes/qbank.routes.js';
import uploadRoutes from './routes/upload.routes.js';

const app = express();

/* How many proxies sit in front of the API. nginx alone is 1; CloudFront
   in front of nginx is 2. Too low, and every request appears to come from
   the proxy — the candidate's recorded IP becomes CloudFront's, and the
   per-address rate limit lumps together everyone on the same edge. */
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
/* Handing cors an array means an unlisted origin is refused in
   silence: no header is added, nothing is logged, and the request is
   still handled. The browser then reports "No Access-Control-Allow-
   Origin header is present", which reads like a fault in the service
   and sends everyone looking in the wrong place. Naming the refused
   origin, once per origin, turns hours of guesswork into one line. */
const refusedOrigins = new Set();
app.use(cors({
  credentials: true,
  origin(origin, cb) {
    // same-origin requests, curl and health checks send no origin
    if (!origin) return cb(null, true);
    if (env.corsOrigins.includes(origin)) return cb(null, true);

    if (!refusedOrigins.has(origin)) {
      refusedOrigins.add(origin);
      console.warn(`[cors] refused "${origin}" — it is not in CORS_ORIGINS.`);
      console.warn(`[cors] permitted: ${env.corsOrigins.join(', ') || '(none)'}`);
      console.warn('[cors] the browser will report this as a missing header, not as a refusal.');
    }
    return cb(null, false);          // no header; never throws
  },
}));
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

/* Answer uploads are mounted BEFORE the general limiter, because they
   do not fit it. The phone carries no token, so every upload in the
   hall would be keyed on one campus address and the three hundredth
   candidate would be refused. The route brings its own limiter, keyed
   on the single-use pass instead. */
app.use('/api/uploads', uploadRoutes);

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

/* Health answers for the database too, not just the process. A reply of
   ok: true while queries are failing sends whoever is debugging in the
   wrong direction, and an uptime monitor would never notice the outage.
   A replica-set election can leave a long-running driver pointed at a
   former primary; this reports it and 503 tells a monitor to act. */
app.get('/api/health', async (_req, res) => {
  const started = Date.now();
  const state = mongoose.STATES[mongoose.connection.readyState];
  let database = { ok: false, state };
  if (mongoose.connection.readyState !== 1) {
    database.error = `not connected to MongoDB (${state})`;
  } else {
    try {
      await mongoose.connection.db.admin().command({ ping: 1 });
      database = { ...database, ok: true, pingMs: Date.now() - started };
    } catch (e) {
      database.error = e.message.slice(0, 200);
    }
  }
  res.status(database.ok ? 200 : 503).json({
    ok: database.ok, service: 'testprobe', version: '0.1.0',
    time: new Date().toISOString(),
    database,
    live: liveStats(),
  });
});

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
app.use('/api/qbank', qbankRoutes);

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

/* Papers created before examinations carried a zone have no stored
   instant, so every comparison would fall back to recomputing one on
   each read. Written once, at boot. */
async function backfillExamInstants() {
  const stale = await Exam.find({ $or: [{ startsAt: null }, { startsAt: { $exists: false } }] })
    .select('date startTime timezone institutionId').lean();
  if (!stale.length) return;

  const zones = new Map();
  for (const inst of await Institution.find().select('settings.timezone').lean()) {
    zones.set(String(inst._id), inst.settings?.timezone || DEFAULT_TIMEZONE);
  }

  const writes = stale.map((e) => {
    const tz = e.timezone || zones.get(String(e.institutionId)) || DEFAULT_TIMEZONE;
    return {
      updateOne: {
        filter: { _id: e._id },
        update: { $set: { timezone: tz, startsAt: zonedToUtc(e.date, e.startTime, tz) } },
      },
    };
  }).filter((w) => w.updateOne.update.$set.startsAt);

  if (writes.length) {
    await Exam.bulkWrite(writes, { ordered: false });
    console.log(`[exams] ${writes.length} examination(s) given a stored start instant`);
  }
}

const start = async () => {
  await connectDb();
  await syncSystemRoles();
  await backfillExamInstants();
  const server = app.listen(env.port, () => {
    console.log(`[api] Test Probe listening on http://localhost:${env.port}/api`);
    console.log(`[api] browser origins permitted: ${env.corsOrigins.join(', ')}`);
  });
  attachRealtime(server);
};

start().catch((e) => {
  console.error('[boot] failed to start', e);
  process.exit(1);
});

export default app;
