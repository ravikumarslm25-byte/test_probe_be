import { Router } from 'express';
import { Exam, Attempt, Room, Audit } from '../models/exam.js';
import { Institution } from '../models/core.js';
import { authenticate, can, tenant, resolveScope } from '../middleware/auth.js';
import { wrap } from '../utils/http.js';
import { VIOLATION_CATALOGUE } from '../utils/grading.js';

const r = Router();
r.use(authenticate);

r.get('/', can('exam:view'), wrap(async (req, res) => {
  const t = tenant(req);
  const scope = await resolveScope(req.actor);

  const examFilter = { ...t };
  if (scope) examFilter.subjectId = { $in: scope.subjectIds };

  const weekAhead = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const weekBack  = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);

  const [exams, institution] = await Promise.all([
    Exam.find({ ...examFilter, date: { $gte: weekBack, $lte: weekAhead } })
      .populate('subjectId', 'code title')
      .populate('batchIds', 'label')
      .sort({ date: 1, startTime: 1 }).lean(),
    Institution.findById(req.actor.institutionId).lean(),
  ]);

  const ids = exams.map((e) => e._id);
  const agg = await Attempt.aggregate([
    { $match: { examId: { $in: ids } } },
    { $group: {
      _id: null,
      scheduled: { $sum: 1 },
      inProgress: { $sum: { $cond: [{ $eq: ['$status', 'in_progress'] }, 1, 0] } },
      submitted:  { $sum: { $cond: [{ $eq: ['$status', 'submitted'] }, 1, 0] } },
      flagged:    { $sum: { $cond: [{ $gt: ['$flagScore', 0] }, 1, 0] } },
      pendingEval:{ $sum: { $cond: [{ $eq: ['$evaluation.state', 'pending'] }, 1, 0] } },
    } },
  ]);
  const s = agg[0] || {};

  const live = exams.find((e) => e.status === 'live');
  let liveDetail = null;
  if (live) {
    const [stats, rooms] = await Promise.all([
      Attempt.aggregate([
        { $match: { examId: live._id } },
        { $group: {
          _id: null,
          total: { $sum: 1 },
          present: { $sum: { $cond: [{ $in: ['$status', ['in_progress', 'submitted', 'flagged']] }, 1, 0] } },
          submitted: { $sum: { $cond: [{ $eq: ['$status', 'submitted'] }, 1, 0] } },
          flagged: { $sum: { $cond: [{ $gt: ['$flagScore', 0] }, 1, 0] } },
        } },
      ]),
      Room.countDocuments({ examId: live._id }),
    ]);
    const st = stats[0] || {};
    const startAt = new Date(`${live.date}T${live.startTime}:00`);
    liveDetail = {
      id: String(live._id),
      title: live.title, code: live.code,
      batches: (live.batchIds || []).map((b) => b.label),
      startTime: live.startTime, durationMinutes: live.durationMinutes,
      elapsedMinutes: Math.max(0, Math.floor((Date.now() - startAt) / 60000)),
      rooms, ...st,
    };
  }

  // recent proctoring events across live examinations
  const recentAttempts = await Attempt.find({ ...t, 'violations.0': { $exists: true } })
    .populate('studentId', 'name regNo')
    .sort({ updatedAt: -1 }).limit(12).lean();

  const feed = [];
  for (const a of recentAttempts) {
    for (const v of a.violations.slice(-2)) {
      feed.push({
        at: v.at,
        student: a.studentId ? { name: a.studentId.name, regNo: a.studentId.regNo } : null,
        type: VIOLATION_CATALOGUE[v.type]?.label || v.type,
        severity: v.severity,
      });
    }
  }
  feed.sort((x, y) => new Date(y.at) - new Date(x.at));

  res.json({
    metrics: {
      examsThisWeek: exams.length,
      candidatesScheduled: s.scheduled || 0,
      sittingNow: s.inProgress || 0,
      flagged: s.flagged || 0,
      awaitingEvaluation: s.pendingEval || 0,
    },
    live: liveDetail,
    exams: exams.slice(0, 6).map((e) => ({
      id: String(e._id), title: e.title, code: e.code,
      batches: (e.batchIds || []).map((b) => b.label),
      date: e.date, startTime: e.startTime, status: e.status,
    })),
    feed: feed.slice(0, 8),
    licence: institution?.licence || null,
  });
}));

r.get('/audit', can('settings:view', 'result:approve'), wrap(async (req, res) => {
  const rows = await Audit.find(tenant(req)).sort({ at: -1 }).limit(200).lean();
  res.json({ audit: rows.map((a) => ({ ...a, id: String(a._id) })) });
}));

export default r;
