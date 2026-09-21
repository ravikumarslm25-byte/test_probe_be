import { Router } from 'express';
import { z } from 'zod';
import { Exam, Question, Attempt } from '../models/exam.js';
import { Institution } from '../models/core.js';
import { authenticate, can, tenant } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { wrap, notFound, forbidden, badRequest } from '../utils/http.js';
import { parse } from '../utils/validate.js';
import { storage } from '../services/storage.js';
import { applyBestN, suggestDescriptive } from '../utils/grading.js';

const r = Router();
r.use(authenticate);

const now = () => new Date();
const round = (n) => Math.round(n * 100) / 100;

/* ============================================================
   QUEUE
   ============================================================ */
r.get('/exams', can('evaluation:view'), wrap(async (req, res) => {
  const exams = await Exam.find({ ...tenant(req), status: { $in: ['closed', 'evaluation', 'published'] } })
    .populate('subjectId', 'code title')
    .sort({ date: -1 }).lean();

  const stats = await Attempt.aggregate([
    { $match: { examId: { $in: exams.map((e) => e._id) } } },
    { $group: {
      _id: '$examId',
      total: { $sum: 1 },
      pending: { $sum: { $cond: [{ $eq: ['$evaluation.state', 'pending'] }, 1, 0] } },
      done: { $sum: { $cond: [{ $eq: ['$evaluation.state', 'submitted'] }, 1, 0] } },
      flagged: { $sum: { $cond: [{ $gt: ['$flagScore', 0] }, 1, 0] } },
    } },
  ]);
  const by = Object.fromEntries(stats.map((s) => [String(s._id), s]));

  res.json({
    exams: exams.map((e) => ({
      id: String(e._id), title: e.title, code: e.code,
      date: e.date, status: e.status, totalMarks: e.totalMarks, passMark: e.passMark,
      resultsPublishedAt: e.resultsPublishedAt,
      stats: by[String(e._id)] || { total: 0, pending: 0, done: 0, flagged: 0 },
    })),
  });
}));

r.get('/exams/:examId/scripts', can('evaluation:view'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.examId, ...tenant(req) }).lean();
  if (!exam) throw notFound('Examination not found');

  const filter = { examId: exam._id, ...tenant(req), status: { $in: ['submitted', 'terminated'] } };
  if (req.query.state) filter['evaluation.state'] = req.query.state;

  const attempts = await Attempt.find(filter)
    .populate('studentId', 'name regNo')
    .sort({ 'evaluation.state': 1 }).lean();

  const descKey = exam.blueprint.sections.find((s) => s.type === 'desc')?.key;

  res.json({
    exam: {
      id: String(exam._id), title: exam.title, code: exam.code,
      totalMarks: exam.totalMarks, passMark: exam.passMark,
      status: exam.status, resultsPublishedAt: exam.resultsPublishedAt,
      sections: exam.blueprint.sections,
    },
    scripts: attempts.map((a) => {
      const descAnswers = (a.answers || []).filter((x) => x.section === descKey);
      const evaluated = descAnswers.filter((x) => x.awarded != null).length;
      return {
        attemptId: String(a._id),
        student: a.studentId ? { name: a.studentId.name, regNo: a.studentId.regNo } : null,
        status: a.status,
        marks: a.marks,
        flagScore: a.flagScore,
        needsReviewCount: (a.answers || []).filter((x) => x.needsReview).length,
        descriptive: { answered: descAnswers.filter((x) => x.awarded != null || x.suggested != null).length, evaluated },
        state: a.evaluation?.state || 'pending',
        cycles: (a.evaluation?.cycles || []).length,
        submittedAt: a.submittedAt,
      };
    }),
  });
}));

/* ============================================================
   ONE SCRIPT
   ============================================================ */
r.get('/attempts/:id', can('evaluation:view'), wrap(async (req, res) => {
  const attempt = await Attempt.findOne({ _id: req.params.id, ...tenant(req) })
    .populate('studentId', 'name regNo')
    .lean();
  if (!attempt) throw notFound('Script not found');

  const exam = await Exam.findById(attempt.examId).lean();
  const questions = await Question.find({ examId: attempt.examId }).sort({ section: 1, order: 1 }).lean();
  const byId = new Map(questions.map((q) => [String(q._id), q]));

  const locked = attempt.evaluation?.state === 'submitted';
  const anonymous = false;   // per-exam toggle lands with the results module

  const items = await Promise.all((attempt.answers || []).map(async (a) => {
    const q = byId.get(String(a.questionId));
    if (!q) return null;

    const base = {
      questionId: String(q._id),
      section: q.section, type: q.type, order: q.order,
      text: q.text, marks: q.marks,
      awarded: a.awarded, autoAwarded: a.autoAwarded,
      needsReview: a.needsReview,
      countedInBestN: a.countedInBestN,
      remarks: a.remarks,
    };

    if (q.type === 'mcq') {
      return {
        ...base,
        options: q.options,
        correctOptions: q.correctOptions,
        selected: a.selected || [],
      };
    }
    if (q.type === 'fib') {
      return { ...base, acceptedAnswers: q.acceptedAnswers, given: a.text || '' };
    }
    // descriptive — the evaluator sees the key, the keywords and the suggestion
    return {
      ...base,
      mode: a.mode,
      html: a.html,
      typed: a.text,
      scanUrls: await Promise.all((a.scanPages || []).map(async (p) => ({
        page: p.page, url: await storage.urlFor(p.key),
      }))),
      keywords: q.keywords,
      modelAnswer: q.modelAnswer,
      markingGuidance: q.markingGuidance,
      suggested: a.suggested,
      keywordHits: a.keywordHits || [],
      coverage: q.keywords?.length
        ? Math.round(((a.keywordHits || []).length / q.keywords.length) * 100)
        : null,
    };
  }));

  res.json({
    attempt: {
      id: String(attempt._id),
      student: anonymous ? { name: 'Candidate', regNo: '—' } : attempt.studentId,
      status: attempt.status,
      marks: attempt.marks,
      flagScore: attempt.flagScore,
      violationCount: (attempt.violations || []).length,
      submittedAt: attempt.submittedAt,
      terminationReason: attempt.terminationReason,
      state: attempt.evaluation?.state,
      locked,
      cycles: attempt.evaluation?.cycles || [],
    },
    exam: {
      title: exam.title, code: exam.code,
      totalMarks: exam.totalMarks, passMark: exam.passMark,
      sections: exam.blueprint.sections,
    },
    answers: items.filter(Boolean),
  });
}));

/* ============================================================
   AWARD MARKS
   Saving is allowed until submission. After submission the
   evaluator cannot touch it — only a revaluation cycle reopens it.
   ============================================================ */
r.patch('/attempts/:id/marks', can('evaluation:edit'), wrap(async (req, res) => {
  const attempt = await Attempt.findOne({ _id: req.params.id, ...tenant(req) });
  if (!attempt) throw notFound('Script not found');

  if (attempt.evaluation?.state === 'submitted') {
    throw forbidden('These marks have been submitted and cannot be edited. A revaluation cycle must be opened by the examination cell.');
  }

  const { marks } = parse(z.object({
    marks: z.array(z.object({
      questionId: z.string(),
      awarded: z.number().min(0),
      remarks: z.string().max(2000).optional(),
    })).min(1),
  }), req.body);

  const exam = await Exam.findById(attempt.examId).lean();
  const questions = await Question.find({ examId: attempt.examId }).lean();
  const byId = new Map(questions.map((q) => [String(q._id), q]));

  for (const m of marks) {
    const q = byId.get(m.questionId);
    if (!q) throw badRequest('That question is not on this paper');
    if (m.awarded > q.marks) {
      throw badRequest(`Question ${q.order + 1} carries ${q.marks} marks; ${m.awarded} was entered`);
    }
    const answer = attempt.answers.find((a) => String(a.questionId) === m.questionId);
    if (!answer) continue;
    answer.awarded = m.awarded;
    if (m.remarks !== undefined) answer.remarks = m.remarks;
  }

  recomputeTotals(attempt, exam, byId);
  attempt.evaluation.state = 'in_review';
  attempt.evaluation.evaluatorId = req.actor.id;
  await attempt.save();

  res.json({ ok: true, marks: attempt.marks });
}));

/* Recomputes every section total and reapplies best-N. Called after
   any mark change so the totals can never drift from the answers. */
function recomputeTotals(attempt, exam, byId) {
  const descSection = exam.blueprint.sections.find((s) => s.type === 'desc');

  if (descSection) {
    const descAnswers = attempt.answers.filter((a) => {
      const q = byId.get(String(a.questionId));
      return q?.section === descSection.key;
    });
    applyBestN(descAnswers, descSection.answerCount || descAnswers.length);
  }

  const totals = {};
  for (const a of attempt.answers) {
    const q = byId.get(String(a.questionId));
    if (!q) continue;
    if (q.section === descSection?.key && !a.countedInBestN) continue;
    totals[q.section] = (totals[q.section] || 0) + (a.awarded ?? 0);
  }

  attempt.marks.sectionA = round(totals.A || 0);
  attempt.marks.sectionB = round(totals.B || 0);
  attempt.marks.sectionC = round(totals.C || 0);
  attempt.marks.total = round((totals.A || 0) + (totals.B || 0) + (totals.C || 0));
  attempt.marks.passed = attempt.marks.total >= exam.passMark;
}

/* ============================================================
   SUBMIT — final for the evaluator
   ============================================================ */
r.post('/attempts/:id/submit', can('evaluation:edit'), wrap(async (req, res) => {
  const attempt = await Attempt.findOne({ _id: req.params.id, ...tenant(req) });
  if (!attempt) throw notFound('Script not found');

  if (attempt.evaluation?.state === 'submitted') {
    throw forbidden('These marks have already been submitted');
  }

  const exam = await Exam.findById(attempt.examId).lean();
  const questions = await Question.find({ examId: attempt.examId }).lean();
  const byId = new Map(questions.map((q) => [String(q._id), q]));

  // every answered descriptive question must carry a mark
  const descKey = exam.blueprint.sections.find((s) => s.type === 'desc')?.key;
  const missing = attempt.answers.filter((a) => {
    const q = byId.get(String(a.questionId));
    if (q?.section !== descKey) return false;
    const answered = a.html || a.text || (a.scanPages || []).length;
    return answered && a.awarded == null;
  });
  if (missing.length) {
    throw badRequest(`${missing.length} descriptive answer(s) still have no mark`);
  }

  recomputeTotals(attempt, exam, byId);
  attempt.evaluation.state = 'submitted';
  attempt.evaluation.evaluatorId = req.actor.id;
  attempt.evaluation.submittedAt = now();
  await attempt.save();

  await audit(req, {
    action: 'evaluation.submitted', entity: 'Attempt', entityId: attempt._id,
    after: { total: attempt.marks.total, passed: attempt.marks.passed },
  });

  res.json({ ok: true, marks: attempt.marks, locked: true });
}));

/* ============================================================
   REVALUATION — the only route back into a submitted script
   ============================================================ */
r.post('/attempts/:id/revaluation', can('evaluation:approve', 'result:approve'), wrap(async (req, res) => {
  const attempt = await Attempt.findOne({ _id: req.params.id, ...tenant(req) });
  if (!attempt) throw notFound('Script not found');

  if (attempt.evaluation?.state !== 'submitted') {
    throw badRequest('This script has not been submitted, so it does not need revaluation');
  }

  const { reason, evaluatorId } = parse(z.object({
    reason: z.string().min(10, 'State the reason in at least a short sentence').max(1000),
    evaluatorId: z.string().optional(),
  }), req.body);

  const cycle = (attempt.evaluation.cycles?.length || 0) + 1;
  attempt.evaluation.cycles.push({
    cycle,
    initiatedBy: req.actor.id,
    evaluatorId: evaluatorId || attempt.evaluation.evaluatorId,
    reason,
    previousTotal: attempt.marks.total,
    newTotal: null,
    at: now(),
  });
  attempt.evaluation.state = 'pending';
  if (evaluatorId) attempt.evaluation.evaluatorId = evaluatorId;
  await attempt.save();

  await audit(req, {
    action: 'evaluation.revaluation_opened', entity: 'Attempt', entityId: attempt._id,
    before: { total: attempt.marks.total }, after: { cycle, reason, evaluatorId },
  });

  res.json({ ok: true, cycle, state: attempt.evaluation.state });
}));

/* ============================================================
   RESULTS
   ============================================================ */
r.get('/exams/:examId/results', can('result:view'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.examId, ...tenant(req) }).lean();
  if (!exam) throw notFound('Examination not found');

  const attempts = await Attempt.find({ examId: exam._id, ...tenant(req) })
    .populate('studentId', 'name regNo')
    .lean();

  const evaluated = attempts.filter((a) => a.evaluation?.state === 'submitted');
  const totals = evaluated.map((a) => a.marks?.total || 0);
  const passed = evaluated.filter((a) => a.marks?.passed).length;

  const mean = totals.length ? round(totals.reduce((s, n) => s + n, 0) / totals.length) : 0;
  const sorted = [...totals].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

  res.json({
    exam: {
      id: String(exam._id), title: exam.title, code: exam.code, date: exam.date,
      totalMarks: exam.totalMarks, passMark: exam.passMark,
      status: exam.status, resultsPublishedAt: exam.resultsPublishedAt,
    },
    summary: {
      scripts: attempts.length,
      evaluated: evaluated.length,
      pending: attempts.length - evaluated.length,
      passed,
      failed: evaluated.length - passed,
      passRate: evaluated.length ? Math.round((passed / evaluated.length) * 100) : 0,
      mean, median,
      highest: totals.length ? Math.max(...totals) : 0,
      lowest: totals.length ? Math.min(...totals) : 0,
    },
    rows: attempts.map((a) => ({
      attemptId: String(a._id),
      student: a.studentId ? { name: a.studentId.name, regNo: a.studentId.regNo } : null,
      status: a.status,
      marks: a.marks,
      flagScore: a.flagScore,
      state: a.evaluation?.state,
      cycles: (a.evaluation?.cycles || []).length,
      published: Boolean(a.resultPublishedAt),
    })),
  });
}));

r.post('/exams/:examId/publish', can('result:publish'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.examId, ...tenant(req) });
  if (!exam) throw notFound('Examination not found');

  const pending = await Attempt.countDocuments({
    examId: exam._id, status: { $in: ['submitted', 'terminated'] },
    'evaluation.state': { $ne: 'submitted' },
  });

  const { force } = parse(z.object({ force: z.boolean().default(false) }), req.body);

  if (pending && !force) {
    throw badRequest(
      `${pending} script(s) have not been evaluated. Publishing now would issue incomplete results.`,
      { pending: 'Finish evaluation, or confirm that you want to publish what is ready.' },
    );
  }

  const stamp = now();
  const result = await Attempt.updateMany(
    { examId: exam._id, 'evaluation.state': 'submitted' },
    { $set: { resultPublishedAt: stamp } },
  );

  exam.status = 'published';
  exam.resultsPublishedAt = stamp;
  await exam.save();

  await audit(req, {
    action: 'result.published', entity: 'Exam', entityId: exam._id,
    after: { published: result.modifiedCount, pendingAtPublish: pending, forced: force },
  });

  res.json({
    ok: true,
    published: result.modifiedCount,
    notified: result.modifiedCount,
    stillPending: pending,
  });
}));

/* Withholding one candidate's result, for a disciplinary matter. */
r.post('/attempts/:id/withhold', can('result:approve'), wrap(async (req, res) => {
  const attempt = await Attempt.findOne({ _id: req.params.id, ...tenant(req) });
  if (!attempt) throw notFound('Script not found');

  const { reason } = parse(z.object({
    reason: z.string().min(10, 'State the reason').max(1000),
  }), req.body);

  attempt.resultPublishedAt = undefined;
  attempt.terminationReason = attempt.terminationReason || `Result withheld: ${reason}`;
  await attempt.save();

  await audit(req, {
    action: 'result.withheld', entity: 'Attempt', entityId: attempt._id, after: { reason },
  });
  res.json({ ok: true });
}));

export default r;
