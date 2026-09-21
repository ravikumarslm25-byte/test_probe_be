import { Router } from 'express';
import { z } from 'zod';
import { Institution } from '../models/core.js';
import { Exam } from '../models/exam.js';
import { authenticate, can, tenant } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { audit } from '../middleware/audit.js';
import { wrap, notFound, badRequest } from '../utils/http.js';
import { parse } from '../utils/validate.js';

const r = Router();
r.use(authenticate);

/* Both a candidate and an invigilator need this before they can
   negotiate, so it sits outside the settings permission. */
r.get('/ice', wrap(async (_req, res) => {
  const iceServers = [{ urls: env.stunUrls }];
  if (env.turnUrl) {
    iceServers.push({
      urls: env.turnUrl,
      username: env.turnUsername,
      credential: env.turnCredential,
    });
  }
  res.json({ iceServers, hasTurn: Boolean(env.turnUrl) });
}));

/* The platforms a candidate may sit an examination on. Windows only
   is the default because the Institute asked for it; the others are
   listed so an administrator can enable them without a code change. */
export const PLATFORMS = [
  { key: 'windows', label: 'Windows',
    note: 'Windows 10 and above. The default, and the only platform enabled out of the box.' },
  { key: 'macos', label: 'macOS',
    note: 'Enable where staff or candidates work on Apple hardware.' },
  { key: 'linux', label: 'Linux',
    note: 'Ubuntu, Fedora and other desktop distributions.' },
  { key: 'chromeos', label: 'ChromeOS',
    note: 'Chromebooks. Camera and microphone behave as on desktop Chrome.' },
  { key: 'android', label: 'Android',
    note: 'Tablets and phones. Not recommended for a full paper — the descriptive editor is cramped.' },
  { key: 'ios', label: 'iPadOS and iOS',
    note: 'Not recommended for a full paper. Fullscreen lockdown is weaker on Safari.' },
];

const settingsSchema = z.object({
  verificationWindowMinutes: z.number().int().min(0).max(120).optional(),
  entryCutoffMinutes: z.number().int().min(0).max(240).optional(),
  roomCapacity: z.number().int().min(1).max(500).optional(),
  invigilatorRatio: z.number().int().min(1).max(200).optional(),
  roomCloseBufferMinutes: z.number().int().min(0).max(240).optional(),
  allowedPlatforms: z.array(z.enum(PLATFORMS.map((p) => p.key))).min(1, 'At least one platform must be permitted').optional(),
  evidenceRetentionDays: z.number().int().min(7).max(3650).optional(),
  captureIntervalSeconds: z.number().int().min(5).max(120).optional(),
  enforcementMode: z.enum(['flag_only', 'terminate']).optional(),
});

r.get('/', can('settings:view', 'exam:view'), wrap(async (req, res) => {
  const inst = await Institution.findById(req.actor.institutionId).lean();
  if (!inst) throw notFound('Institution not found');

  /* The institutional list is only a default. Each paper carries its
     own copy, so the screen shows both — otherwise "I enabled macOS
     but the exam still refuses me" is impossible to diagnose. */
  const exams = await Exam.find({ ...tenant(req), status: { $ne: 'published' } })
    .select('title code date status proctoring.allowedPlatforms')
    .sort({ date: -1 }).limit(60).lean();

  const def = inst.settings?.allowedPlatforms || ['windows'];
  const matches = (list) => {
    const a = [...(list || ['windows'])].sort().join(',');
    return a === [...def].sort().join(',');
  };

  res.json({
    institution: {
      id: String(inst._id),
      name: inst.name, shortName: inst.shortName, code: inst.code,
    },
    settings: inst.settings,
    licence: inst.licence,
    platforms: PLATFORMS,
    exams: exams.map((e) => ({
      id: String(e._id),
      title: e.title, code: e.code, date: e.date, status: e.status,
      allowedPlatforms: e.proctoring?.allowedPlatforms || ['windows'],
      matchesDefault: matches(e.proctoring?.allowedPlatforms),
      editable: !['closed', 'evaluation', 'published'].includes(e.status),
    })),
  });
}));

r.patch('/', can('settings:edit', 'exam:edit'), wrap(async (req, res) => {
  const body = parse(settingsSchema, req.body);
  const inst = await Institution.findById(req.actor.institutionId);
  if (!inst) throw notFound('Institution not found');

  const before = { ...inst.settings.toObject?.() ?? inst.settings };
  Object.assign(inst.settings, body);
  await inst.save();

  await audit(req, {
    action: 'settings.updated', entity: 'Institution', entityId: inst._id,
    before, after: body,
  });

  res.json({ settings: inst.settings, platforms: PLATFORMS });
}));

/* ---------------- per-exam platform override ----------------
   An administrator may widen or narrow platforms for one paper
   without changing the institutional default. Only permitted
   before the examination begins. */
r.patch('/exams/:id/platforms', can('exam:edit'), wrap(async (req, res) => {
  const { allowedPlatforms } = parse(z.object({
    allowedPlatforms: z.array(z.enum(PLATFORMS.map((p) => p.key))).min(1, 'At least one platform must be permitted'),
  }), req.body);

  const exam = await Exam.findOne({ _id: req.params.id, ...tenant(req) });
  if (!exam) throw notFound('Examination not found');
  /* A live paper may still be changed. Widening the list only ever
     lets a refused candidate in, and narrowing it does not disturb
     anyone already sitting, because the check runs at join. Once
     marking has begun there is nothing left to change. */
  if (['closed', 'evaluation', 'published'].includes(exam.status)) {
    throw badRequest('This examination has closed; platform rules can no longer be changed');
  }

  const before = exam.proctoring.allowedPlatforms;
  exam.proctoring.allowedPlatforms = allowedPlatforms;
  await exam.save();

  await audit(req, {
    action: 'exam.platforms_changed', entity: 'Exam', entityId: exam._id,
    before: { allowedPlatforms: before }, after: { allowedPlatforms },
  });

  res.json({ ok: true, allowedPlatforms });
}));

/* Applies the institutional list to every examination not yet
   started. Saves an administrator editing each paper by hand after
   changing the default. */
r.post('/apply-platforms', can('settings:edit', 'exam:edit'), wrap(async (req, res) => {
  const inst = await Institution.findById(req.actor.institutionId).lean();
  const allowed = inst?.settings?.allowedPlatforms || ['windows'];

  const OPEN = ['draft', 'scheduled', 'live'];
  const CLOSED = ['closed', 'evaluation', 'published'];

  const [updatable, skipped] = await Promise.all([
    Exam.find({ ...tenant(req), status: { $in: OPEN } }).select('title code status').lean(),
    Exam.find({ ...tenant(req), status: { $in: CLOSED } }).select('title code status').lean(),
  ]);

  const result = await Exam.updateMany(
    { ...tenant(req), status: { $in: OPEN } },
    { $set: { 'proctoring.allowedPlatforms': allowed } },
  );

  await audit(req, {
    action: 'settings.platforms_applied', entity: 'Institution', entityId: inst._id,
    after: { allowed, examsUpdated: result.modifiedCount, skipped: skipped.length },
  });

  res.json({
    ok: true,
    allowedPlatforms: allowed,
    examsUpdated: result.modifiedCount,
    updated: updatable.map((e) => ({ code: e.code, title: e.title, status: e.status })),
    skipped: skipped.map((e) => ({ code: e.code, title: e.title, status: e.status })),
  });
}));

export default r;
