import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Exam, Question, Attempt, Room } from '../models/exam.js';
import { Role, User, Student } from '../models/core.js';
import { authenticate, can, tenant } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { wrap, notFound, forbidden, badRequest } from '../utils/http.js';
import { parse } from '../utils/validate.js';
import { storage } from '../services/storage.js';
import { applyBestN } from '../utils/grading.js';
import { sanitiseAnswerHtml, stripTags } from '../utils/sanitise.js';
import { decidePass } from '../services/finalise.js';

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
  if (req.query.mine === 'true') filter['evaluation.evaluatorId'] = req.actor.id;
  else if (req.query.unallocated === 'true') filter['evaluation.evaluatorId'] = null;

  const attempts = await Attempt.find(filter)
    .populate('studentId', 'name regNo')
    .populate('evaluation.evaluatorId', 'name')
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
        evaluator: a.evaluation?.evaluatorId?.name
          ? { id: String(a.evaluation.evaluatorId._id), name: a.evaluation.evaluatorId.name }
          : null,
        mine: String(a.evaluation?.evaluatorId?._id || a.evaluation?.evaluatorId || '') === String(req.actor.id),
        cycles: (a.evaluation?.cycles || []).length,
        submittedAt: a.submittedAt,
      };
    }),
  });
}));

/* ============================================================
   ALLOCATING SCRIPTS TO EVALUATORS

   Naming evaluators while the paper is being built does not work:
   at that point nobody knows how many candidates will sit, how many
   will be terminated, or which staff are free the week the scripts
   come in. So allocation is a step of its own, taken once the
   examination is over.

   Until a script is allocated, anyone with evaluation rights can
   open it — which is what used to happen to every script, and meant
   whoever opened one first owned it. Once it is allocated it belongs
   to that evaluator, and only the examination cell can override.
   ============================================================ */
r.get('/exams/:examId/allocation', can('evaluation:view'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.examId, ...tenant(req) })
    .populate('subjectId', 'code title').lean();
  if (!exam) throw notFound('Examination not found');

  const scripts = await Attempt.find({
    examId: exam._id, ...tenant(req), status: { $in: ['submitted', 'terminated'] },
  }).select('studentId roomId evaluation.evaluatorId evaluation.state').lean();

  /* Eligible evaluators are the staff whose roles carry
     evaluation:edit — read off the roles rather than guessed from a
     job title. */
  const roles = await Role.find({ ...tenant(req), permissions: 'evaluation:edit' }).select('_id name').lean();
  const staff = await User.find({
    ...tenant(req), status: 'active', roleIds: { $in: roles.map((x) => x._id) },
  }).select('name email departmentId').populate('departmentId', 'name').sort({ name: 1 }).lean();

  /* Which class each script belongs to. A script carries its
     candidate, and the candidate carries the class, so this is one
     hop — worth making, because a class is the unit the examination
     cell actually allocates in. */
  const students = await Student.find({ _id: { $in: scripts.map((s) => s.studentId) } })
    .select('batchId').populate('batchId', 'label year section').lean();
  const batchOf = new Map(students.map((s) => [String(s._id), s.batchId || null]));

  const rooms = await Room.find({ examId: exam._id }).select('name').lean();
  const roomName = new Map(rooms.map((r) => [String(r._id), r.name]));

  /* Per-evaluator totals, for the load bars. */
  const load = new Map();
  let unallocated = 0;
  for (const s of scripts) {
    const id = String(s.evaluation?.evaluatorId || '');
    if (!id) { unallocated += 1; continue; }
    if (!load.has(id)) load.set(id, { allocated: 0, submitted: 0 });
    load.get(id).allocated += 1;
    if (s.evaluation?.state === 'submitted') load.get(id).submitted += 1;
  }

  const name = new Map(staff.map((x) => [String(x._id), x.name]));

  /* A group is a class or a room: the two things an examination cell
     hands to an evaluator as a unit. Scripts are never allocated one
     at a time, so the counts here are what the screen works in. */
  function group(keyOf, labelOf) {
    const by = new Map();
    for (const s of scripts) {
      const key = keyOf(s);
      if (!key) continue;
      if (!by.has(key)) {
        by.set(key, { id: key, label: labelOf(s, key), scripts: 0, marked: 0, unallocated: 0, held: new Map() });
      }
      const g = by.get(key);
      g.scripts += 1;
      if (s.evaluation?.state === 'submitted') g.marked += 1;
      const ev = String(s.evaluation?.evaluatorId || '');
      if (!ev) g.unallocated += 1;
      else g.held.set(ev, (g.held.get(ev) || 0) + 1);
    }
    return [...by.values()]
      .map((g) => ({
        id: g.id, label: g.label, scripts: g.scripts, marked: g.marked,
        unallocated: g.unallocated,
        /* One name when the whole group is with one evaluator, the
           list when a previous allocation split it. */
        evaluators: [...g.held.entries()]
          .map(([id, n]) => ({ id, name: name.get(id) || 'Someone outside this list', count: n }))
          .sort((a, b) => b.count - a.count),
      }))
      .sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true }));
  }

  const byClass = group(
    (s) => {
      const b = batchOf.get(String(s.studentId));
      return b ? String(b._id) : null;
    },
    (s) => {
      const b = batchOf.get(String(s.studentId));
      return b?.label || 'Unknown class';
    },
  );

  const byRoom = group(
    (s) => (s.roomId ? String(s.roomId) : null),
    (s) => roomName.get(String(s.roomId)) || 'Unknown room',
  );

  /* Scripts whose candidate has no class, or which were never put in
     a room, would otherwise vanish from a grouped screen — and an
     unallocated script nobody can see is one nobody marks. */
  const ungrouped = {
    byClass: scripts.filter((s) => !batchOf.get(String(s.studentId))).length,
    byRoom: scripts.filter((s) => !s.roomId).length,
  };

  res.json({
    exam: {
      id: String(exam._id), title: exam.title, code: exam.code, status: exam.status,
      subject: exam.subjectId ? { code: exam.subjectId.code, title: exam.subjectId.title } : null,
    },
    total: scripts.length,
    unallocated,
    ungrouped,
    groups: { batch: byClass, room: byRoom },
    evaluators: staff.map((s) => ({
      id: String(s._id), name: s.name, email: s.email,
      department: s.departmentId?.name || null,
      ...(load.get(String(s._id)) || { allocated: 0, submitted: 0 }),
    })),
  });
}));

/* `evaluation:approve` alone. `exam:edit` was accepted here too, and
   it should not be: it is a paper-BUILDING permission, and `can` is an
   OR. A custom role of exam:edit plus evaluation:edit — a plausible
   "Senior Faculty" — could therefore allocate every script on a paper
   to itself and then mark them all. Every stock role that should
   allocate already holds evaluation:approve. */
r.post('/exams/:examId/allocate', can('evaluation:approve'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.examId, ...tenant(req) });
  if (!exam) throw notFound('Examination not found');
  if (['draft', 'scheduled', 'live'].includes(exam.status)) {
    throw forbidden('Scripts can be allocated once the examination is over');
  }

  /* Allocation is by CLASS or by ROOM, never script by script.

     Sharing scripts out evenly by count looked tidy and was wrong: an
     examination cell hands an evaluator a class, or the scripts that
     came out of one hall, as a bundle. Splitting III CSE A across
     four evaluators means four people marking the same paper to four
     standards, and no single person able to answer for that class. */
  const body = parse(z.object({
    by: z.enum(['batch', 'room']),
    assignments: z.array(z.object({
      groupId: z.string(),
      /* Empty takes the group back off whoever holds it. */
      evaluatorId: z.string().nullable().default(null),
    })).min(1, 'Choose at least one class or room'),
  }), req.body);

  /* The target must actually be able to MARK, not merely exist.
     Checking only that the user is active let a class be handed to an
     invigilator or a clerk: the scripts then carried an evaluatorId
     whose holder `can('evaluation:edit')` refuses, while
     `assertScriptIsMine` refused every real evaluator — so nobody
     could mark them, and because they were "allocated" they stopped
     being counted as waiting and disappeared from the panel. */
  const wanted = body.assignments.filter((a) => a.evaluatorId);
  const wantedIds = [...new Set(wanted.map((a) => String(a.evaluatorId)))];

  const markerRoles = await Role.find({ ...tenant(req), permissions: 'evaluation:edit' })
    .select('_id').lean();
  const evaluators = await User.find({
    _id: { $in: wantedIds }, ...tenant(req), status: 'active',
    roleIds: { $in: markerRoles.map((r) => r._id) },
  }).select('name').lean();

  if (evaluators.length !== wantedIds.length) {
    const ok = new Set(evaluators.map((e) => String(e._id)));
    const bad = wantedIds.filter((id) => !ok.has(id));
    const who = await User.find({ _id: { $in: bad }, ...tenant(req) }).select('name status').lean();
    const first = who[0];
    throw badRequest(first
      ? `${first.name} cannot be given scripts — ${first.status !== 'active'
        ? 'that account is deactivated'
        : 'their role does not carry the right to enter marks'}.`
      : 'One of those evaluators is not a member of staff here.');
  }
  const nameOf = new Map(evaluators.map((e) => [String(e._id), e.name]));

  /* Only unmarked scripts move. A submitted script is finished work
     and must not change hands. */
  const scripts = await Attempt.find({
    examId: exam._id, ...tenant(req), status: { $in: ['submitted', 'terminated'] },
    'evaluation.state': { $ne: 'submitted' },
  }).select('studentId roomId').lean();

  /* Which group each script is in. For a class that means going
     through the candidate. */
  let groupOf;
  if (body.by === 'room') {
    groupOf = (s) => (s.roomId ? String(s.roomId) : null);
  } else {
    const students = await Student.find({ _id: { $in: scripts.map((s) => s.studentId) } })
      .select('batchId').lean();
    const batch = new Map(students.map((s) => [String(s._id), s.batchId ? String(s.batchId) : null]));
    groupOf = (s) => batch.get(String(s.studentId)) || null;
  }

  const target = new Map(body.assignments.map((a) => [a.groupId, a.evaluatorId || null]));
  const at = new Date();
  const writes = [];
  const perEvaluator = new Map();
  let cleared = 0;

  for (const s of scripts) {
    const g = groupOf(s);
    if (g == null || !target.has(g)) continue;
    const to = target.get(g);

    if (to) {
      writes.push({ updateOne: {
        filter: { _id: s._id },
        update: { $set: {
          'evaluation.evaluatorId': new Types.ObjectId(to),
          'evaluation.allocatedBy': req.actor.id,
          'evaluation.allocatedAt': at,
        } },
      } });
      perEvaluator.set(to, (perEvaluator.get(to) || 0) + 1);
    } else {
      writes.push({ updateOne: {
        filter: { _id: s._id },
        update: { $unset: {
          'evaluation.evaluatorId': '', 'evaluation.allocatedBy': '', 'evaluation.allocatedAt': '',
        } },
      } });
      cleared += 1;
    }
  }

  if (!writes.length) {
    return res.json({
      allocated: 0, cleared: 0, perEvaluator: [],
      message: 'Nothing moved — every script in those groups is already marked.',
    });
  }

  await Attempt.bulkWrite(writes, { ordered: false });

  const summary = [...perEvaluator.entries()]
    .map(([id, n]) => ({ id, name: nameOf.get(id), scripts: n }))
    .sort((a, b) => b.scripts - a.scripts);

  await audit(req, { action: 'evaluation.allocated', entity: 'Exam', entityId: exam._id,
    after: { by: body.by, groups: body.assignments.length, allocated: writes.length - cleared,
             cleared, perEvaluator: summary } });

  res.json({ allocated: writes.length - cleared, cleared, by: body.by, perEvaluator: summary });
}));

/* There is deliberately no route for moving ONE script. Allocation is
   by class or by room — see POST /exams/:examId/allocate. The single
   legitimate case for naming a different evaluator for one candidate
   is a revaluation, which has its own route, its own reason and its
   own audit trail. */

/* An allocated script belongs to its evaluator. The examination cell
   keeps an override, because someone has to be able to act when an
   evaluator is ill the day before results are due. */
function assertScriptIsMine(req, attempt) {
  const allocated = attempt.evaluation?.evaluatorId;
  if (!allocated) return;                                     // free for anyone to pick up
  if (String(allocated) === String(req.actor.id)) return;
  if (req.actor.permissions.has('evaluation:approve')) return; // the cell, stepping in
  throw forbidden('This script is allocated to another evaluator');
}

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
      /* Cleaned on the way in as well. Cleaned again here because
         answers written before that was true are still in the
         database, and this is the screen that renders them as HTML
         in a member of staff's own session. */
      html: sanitiseAnswerHtml(a.html),
      typed: stripTags(a.text),
      /* `mime` travels with the URL because an uploaded answer is no
         longer always an image. A phone scanner app produces a PDF,
         and the evaluator's viewer has to open it rather than drop an
         unrenderable <img> on the page. Rows written before the
         upload pathway carry no mime and are images. */
      scanUrls: await Promise.all((a.scanPages || []).map(async (p) => ({
        page: p.page, url: await storage.urlFor(p.key),
        mime: p.mime || 'image/jpeg', name: p.name, bytes: p.bytes,
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
  assertScriptIsMine(req, attempt);

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
  /* An allocated script keeps its evaluator. This line used to claim
     it for whoever saved: the examination cell opening a script to
     check a mark, and pressing Save, took it off the evaluator it
     was given to, whose next save was then refused as "allocated to
     another evaluator". Only an unallocated script is claimed. */
  if (!attempt.evaluation.evaluatorId) attempt.evaluation.evaluatorId = req.actor.id;
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
  /* The same rule the sealing path uses, rather than a second copy
     of it. Two copies disagreed: a disqualified candidate came out a
     fail on an objective-only paper and a PASS on one with Part C,
     because only this line ran for the second. */
  attempt.marks.passed = decidePass({
    total: attempt.marks.total,
    passMark: exam.passMark,
    descNeedsEval: false,          // the evaluator is the one saving
    status: attempt.status,
  });
}

/* ============================================================
   SUBMIT — final for the evaluator
   ============================================================ */
r.post('/attempts/:id/submit', can('evaluation:edit'), wrap(async (req, res) => {
  const attempt = await Attempt.findOne({ _id: req.params.id, ...tenant(req) });
  if (!attempt) throw notFound('Script not found');
  assertScriptIsMine(req, attempt);

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
  /* An allocated script keeps the evaluator it was given to, even
     when the cell submits on their behalf; `submittedBy` records who
     actually did it. An unallocated script is taken by whoever
     marked it. */
  if (!attempt.evaluation.evaluatorId) attempt.evaluation.evaluatorId = req.actor.id;
  attempt.evaluation.submittedBy = req.actor.id;
  attempt.evaluation.submittedAt = now();

  /* Close off an open revaluation cycle with the total it produced.
     `newTotal` was written as null when the cycle opened and nothing
     ever filled it in, so the history a revaluation exists to leave
     read "78 → pending" for ever. */
  const open = attempt.evaluation.cycles?.[attempt.evaluation.cycles.length - 1];
  if (open && open.newTotal == null) open.newTotal = attempt.marks.total;
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

  /* A named re-evaluator is checked exactly as an allocation is. Taken
     on trust, an id from another institution would be written onto the
     script, and the script would then be markable by nobody inside
     this one. */
  if (evaluatorId) {
    const who = await User.findOne({
      _id: evaluatorId, ...tenant(req), status: 'active',
    }).select('_id').lean();
    if (!who) throw badRequest('That re-evaluator is not an active member of staff here');
  }

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
