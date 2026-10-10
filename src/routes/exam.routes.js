import { Router } from 'express';
import { z } from 'zod';
import { Exam, Question, Room, Attempt } from '../models/exam.js';
import { Student, Institution } from '../models/core.js';
import { authenticate, can, tenant, resolveScope } from '../middleware/auth.js';
import { samplePaper } from '../data/sample-bank.js';
import { audit } from '../middleware/audit.js';
import { wrap, notFound, badRequest, conflict, forbidden } from '../utils/http.js';
import { parse } from '../utils/validate.js';
import { syncExamStatuses, syncExamStatus } from '../utils/examStatus.js';
import { examStartAt, zonedToUtc, DEFAULT_TIMEZONE } from '../utils/time.js';
import { sittingFor, lastSittingEnd } from '../utils/sitting.js';
import { closeExam, mayContinue, recomputeWritingUntil } from '../services/closeExam.js';
import { storage } from '../services/storage.js';

const r = Router();
r.use(authenticate);



/* ============================ EXAMS ============================ */

r.get('/', can('exam:view'), wrap(async (req, res) => {
  const scope = await resolveScope(req.actor);
  const filter = { ...tenant(req) };
  if (req.query.status) filter.status = req.query.status;
  if (scope) filter.subjectId = { $in: scope.subjectIds };

  const exams = await Exam.find(filter)
    .populate('subjectId', 'code title')
    .populate('batchIds', 'label')
    .sort({ date: -1, startTime: -1 }).limit(300).lean();

  const ids = exams.map((e) => e._id);
  const stats = await Attempt.aggregate([
    { $match: { examId: { $in: ids } } },
    { $group: {
      _id: '$examId',
      candidates: { $sum: 1 },
      present: { $sum: { $cond: [{ $in: ['$status', ['in_progress', 'submitted', 'flagged']] }, 1, 0] } },
      submitted: { $sum: { $cond: [{ $eq: ['$status', 'submitted'] }, 1, 0] } },
      flagged: { $sum: { $cond: [{ $gt: ['$flagScore', 0] }, 1, 0] } },
    } },
  ]);
  const byExam = Object.fromEntries(stats.map((s) => [String(s._id), s]));
  const roomCounts = await Room.aggregate([
    { $match: { examId: { $in: ids } } },
    { $group: { _id: '$examId', rooms: { $sum: 1 } } },
  ]);
  const roomsBy = Object.fromEntries(roomCounts.map((s) => [String(s._id), s.rooms]));

  const institution = await Institution.findById(req.actor.institutionId).lean();
  await syncExamStatuses(Exam, exams, institution);

  res.json({
    exams: exams.map((e) => ({
      id: String(e._id),
      title: e.title, code: e.code, type: e.type,
      subject: e.subjectId ? { id: String(e.subjectId._id), code: e.subjectId.code, title: e.subjectId.title } : null,
      batches: (e.batchIds || []).map((b) => ({ id: String(b._id), label: b.label })),
      date: e.date, startTime: e.startTime, durationMinutes: e.durationMinutes,
      totalMarks: e.totalMarks, passMark: e.passMark,
      status: e.status,
      /* So the list can say at a glance that this paper has
         candidates sitting outside the hall's window. */
      alternateSittings: e.alternateSittings || 0,
      lastSittingEndsAt: e.lastSittingEndsAt || null,
      rooms: roomsBy[String(e._id)] || 0,
      candidates: byExam[String(e._id)]?.candidates || 0,
      present: byExam[String(e._id)]?.present || 0,
      submitted: byExam[String(e._id)]?.submitted || 0,
      flagged: byExam[String(e._id)]?.flagged || 0,
    })),
  });
}));

r.get('/:id', can('exam:view'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.id, ...tenant(req) })
    .populate('subjectId', 'code title')
    .populate('batchIds', 'label');
  if (!exam) throw notFound('Examination not found');

  const [questions, rooms] = await Promise.all([
    Question.find({ examId: exam._id }).sort({ section: 1, order: 1 }).lean(),
    Room.find({ examId: exam._id }).populate('invigilatorId', 'name email').sort({ name: 1 }).lean(),
  ]);

  const counts = { A: 0, B: 0, C: 0 };
  questions.forEach((q) => { counts[q.section] = (counts[q.section] || 0) + 1; });

  res.json({
    exam: {
      ...exam.toObject(),
      id: String(exam._id),
      blueprintTotal: exam.blueprintTotal(),
      questionCounts: counts,
    },
    rooms: rooms.map((x) => ({
      id: String(x._id), name: x.name, capacity: x.capacity,
      startAt: x.startAt, endAt: x.endAt,
      invigilator: x.invigilatorId ? { id: String(x.invigilatorId._id), name: x.invigilatorId.name } : null,
      allocated: (x.studentIds || []).length,
    })),
  });
}));

const sectionSchema = z.object({
  key: z.enum(['A', 'B', 'C']),
  title: z.string(),
  type: z.enum(['mcq', 'fib', 'desc']),
  count: z.number().int().min(1),
  marksEach: z.number().min(0.5),
  answerCount: z.number().int().min(1).optional(),
  choiceMode: z.enum(['best_n', 'any_n', 'either_or']).optional(),
  instruction: z.string().optional(),
}).superRefine((s, ctx) => {
  /* A paper that cannot be answered as written is caught here rather
     than discovered by a candidate in a hall. */
  if (s.answerCount != null && s.answerCount > s.count) {
    ctx.addIssue({ code: 'custom', path: ['answerCount'],
      message: `Part ${s.key} sets ${s.count} question(s); it cannot ask for ${s.answerCount} answers` });
  }
  if (s.choiceMode && s.choiceMode !== 'best_n' && s.type !== 'desc') {
    ctx.addIssue({ code: 'custom', path: ['choiceMode'],
      message: 'A choice rule applies to a descriptive part only' });
  }
  if (s.choiceMode === 'either_or') {
    if (s.count % 2 !== 0) {
      /* An odd question out has no alternative, so it is compulsory —
         on a paper whose own instruction says "answer one from each
         pair". The rule handles an existing odd paper by widening the
         last pair; a new one is simply refused. */
      ctx.addIssue({ code: 'custom', path: ['count'],
        message: `Part ${s.key} pairs its questions, so it needs an even number of them` });
    }
    const pairs = Math.ceil(s.count / 2);
    if (s.answerCount != null && s.answerCount !== pairs) {
      ctx.addIssue({ code: 'custom', path: ['answerCount'],
        message: `Part ${s.key} has ${pairs} pair(s), so it takes exactly ${pairs} answer(s)` });
    }
  }
});

const examSchema = z.object({
  subjectId: z.string().min(1, 'Choose a subject'),
  batchIds: z.array(z.string()).min(1, 'Choose at least one batch'),
  title: z.string().min(2, 'Give the examination a title'),
  code: z.string().min(2, 'Enter the subject code'),
  type: z.enum(['internal', 'model', 'end_semester']).default('internal'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date'),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Choose a start time'),
  durationMinutes: z.number().int().min(10).max(360),
  totalMarks: z.number().min(1),
  /* Not `min(0)`. A cleared field arrives as 0, and a pass mark of
     zero passes every candidate who turned up — the builder sends
     `Number('') || 0`, so the paper looked configured. */
  passMark: z.number().positive('Set a pass mark above zero'),
  blueprint: z.object({ sections: z.array(sectionSchema).min(1) }),
  proctoring: z.record(z.any()).optional(),
  randomisation: z.record(z.any()).optional(),
  instructions: z.string().optional(),
});

/* A pass mark nobody can reach is a paper that fails everyone, and
   it reads as configured. Checked wherever either number moves. */
function assertPassMarkIsReachable(exam) {
  if (exam.passMark > exam.totalMarks) {
    throw badRequest(
      `The pass mark of ${exam.passMark} is above the paper's total of ${exam.totalMarks}`,
      { passMark: 'No candidate could reach it' },
    );
  }
}

r.post('/', can('exam:create'), wrap(async (req, res) => {
  const body = parse(examSchema, req.body);

  /* The date and time the cell typed are a wall clock in the
     institution's own zone. Stamping it on the paper is what turns
     them into an instant the server can compare against. */
  const institution = await Institution.findById(req.actor.institutionId).lean();
  const timezone = institution?.settings?.timezone || DEFAULT_TIMEZONE;

  const exam = new Exam({
    ...body, ...tenant(req), createdBy: req.actor.id, status: 'draft', timezone,
  });
  const total = exam.blueprintTotal();
  if (total !== body.totalMarks) {
    throw badRequest(
      `The blueprint adds up to ${total} marks but the paper is set to ${body.totalMarks}`,
      { blueprint: 'Adjust the section counts or the total marks so they agree' },
    );
  }
  assertPassMarkIsReachable(exam);
  await exam.save();

  await audit(req, { action: 'exam.created', entity: 'Exam', entityId: exam._id, after: { code: body.code, date: body.date } });
  res.status(201).json({ exam: { ...exam.toObject(), id: String(exam._id) } });
}));

r.patch('/:id', can('exam:edit'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.id, ...tenant(req) });
  if (!exam) throw notFound('Examination not found');
  /* A paper that rolled into its window but that nobody has started
     is still editable — otherwise a cell that typed the wrong time
     can neither run the paper nor correct it. Once a candidate has
     sat it, the paper is part of the record. */
  if (['closed', 'evaluation', 'published'].includes(exam.status)) {
    throw forbidden(`This examination is ${exam.status} and can no longer be edited`);
  }
  if (exam.status === 'live') {
    const started = await Attempt.countDocuments({ examId: exam._id, status: { $ne: 'not_started' } });
    if (started) {
      throw forbidden(`${started} candidate(s) have already started this paper; it can no longer be edited`);
    }
  }

  const body = parse(examSchema.partial(), req.body);
  const before = exam.toObject();
  Object.assign(exam, body);

  if (body.blueprint || body.totalMarks) {
    const total = exam.blueprintTotal();
    if (total !== exam.totalMarks) {
      throw badRequest(`The blueprint adds up to ${total} marks but the paper is set to ${exam.totalMarks}`);
    }
  }
  if (body.passMark || body.totalMarks || body.blueprint) assertPassMarkIsReachable(exam);

  /* Pairing a paper that was not built paired.

     Questions drawn from the bank are grouped at the moment they are
     drawn — but only if the part was already set to either/or. A cell
     that writes the questions first and chooses the rule afterwards
     (which is the ordinary way round) would otherwise have a paper
     with no pairing at all and nowhere to set one. Stamped here, in
     the order the questions are set: 1 with 2, 3 with 4. */
  if (body.blueprint) {
    for (const sec of exam.blueprint.sections) {
      if (sec.type !== 'desc' || sec.choiceMode !== 'either_or') continue;
      const qs = await Question.find({ examId: exam._id, section: sec.key })
        .sort({ order: 1 }).select('_id order choiceGroup').lean();
      const writes = qs
        .map((q, i) => ({ q, want: String(Math.floor((q.order ?? i) / 2) + 1) }))
        .filter(({ q, want }) => q.choiceGroup !== want)
        .map(({ q, want }) => ({
          updateOne: { filter: { _id: q._id }, update: { $set: { choiceGroup: want } } },
        }));
      if (writes.length) await Question.bulkWrite(writes, { ordered: false });
    }
  }

  /* Moving the paper must not leave an alternate sitting standing
     BEFORE it. "A sitting cannot begin before the examination" is
     checked when the sitting is granted; without the same check here,
     granting a 14:00 sitting on a 10:00 paper and then moving the
     paper to 16:00 would hand that candidate the real question set
     two hours before anyone else. */
  if (body.date || body.startTime || body.timezone) {
    const movedTo = examStartAt(exam);
    const early = await Attempt.countDocuments({
      examId: exam._id, ...tenant(req),
      'sitting.startsAt': { $ne: null, $lt: movedTo },
    });
    if (early) {
      throw badRequest(`${early} candidate(s) have a sitting arranged before the new start time. `
        + 'Withdraw or re-time those sittings first, under Sittings.');
    }
  }
  await exam.save();

  await audit(req, { action: 'exam.updated', entity: 'Exam', entityId: exam._id, before, after: body });
  res.json({ exam: { ...exam.toObject(), id: String(exam._id) } });
}));

/* ============================ QUESTIONS ============================ */

r.get('/:id/questions', can('question:view', 'exam:view'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.id, ...tenant(req) }).lean();
  if (!exam) throw notFound('Examination not found');

  // A paper sealed until start is not readable before then, except by
  // roles explicitly permitted to preview it. Every read is audited.
  const mayPreview = req.actor.permissions.has('exam:approve') || req.actor.permissions.has('question:edit');
  if (exam.sealedUntil && new Date() < exam.sealedUntil && !mayPreview) {
    throw forbidden('This question paper is sealed until the examination begins');
  }
  if (exam.sealedUntil && new Date() < exam.sealedUntil) {
    await audit(req, { action: 'exam.paper_previewed', entity: 'Exam', entityId: exam._id });
  }

  const questions = await Question.find({ examId: exam._id, ...tenant(req) })
    .sort({ section: 1, order: 1 }).lean();

  res.json({
    questions: questions.map((q) => ({ ...q, id: String(q._id) })),
    blueprint: exam.blueprint,
  });
}));

const questionSchema = z.object({
  section: z.enum(['A', 'B', 'C']),
  type: z.enum(['mcq', 'fib', 'desc']),
  text: z.string().min(5, 'Enter the question'),
  marks: z.number().min(0.5),
  order: z.number().int().default(0),
  setLabel: z.string().default('A'),
  /* Which question this one stands against under an either/or
     section. Two questions sharing it are alternatives. */
  choiceGroup: z.string().max(40).optional(),
  options: z.array(z.object({ key: z.string(), text: z.string() })).optional(),
  correctOptions: z.array(z.string()).optional(),
  multiSelect: z.boolean().optional(),
  acceptedAnswers: z.array(z.string()).optional(),
  keywords: z.array(z.object({ term: z.string(), weight: z.number().default(1) })).optional(),
  modelAnswer: z.string().optional(),
  markingGuidance: z.string().optional(),
  unit: z.string().optional(),
  difficulty: z.enum(['easy', 'moderate', 'hard']).optional(),
});

/* Validates a question against the blueprint and its own type rules. */
function validateQuestion(q, blueprint) {
  const section = blueprint.sections.find((s) => s.key === q.section);
  if (!section) throw badRequest(`This paper has no Part ${q.section}`);
  if (section.type !== q.type) {
    throw badRequest(`Part ${q.section} takes ${section.type} questions, not ${q.type}`);
  }
  if (q.marks !== section.marksEach) {
    throw badRequest(`Questions in Part ${q.section} carry ${section.marksEach} marks`);
  }
  if (q.type === 'mcq') {
    if (!q.options?.length || q.options.length < 2) throw badRequest('Give at least two options');
    if (!q.correctOptions?.length) throw badRequest('Mark the correct option');
    const keys = q.options.map((o) => o.key);
    const bad = q.correctOptions.filter((k) => !keys.includes(k));
    if (bad.length) throw badRequest(`Correct option ${bad.join(', ')} is not among the options`);
  }
  if (q.type === 'fib' && !q.acceptedAnswers?.length) {
    throw badRequest('Give at least one accepted answer so this can be graded automatically');
  }
  if (q.type === 'desc' && !q.keywords?.length) {
    throw badRequest('Give keywords so the evaluator gets a suggested mark');
  }
}

r.post('/:id/questions', can('question:create'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.id, ...tenant(req) });
  if (!exam) throw notFound('Examination not found');
  if (exam.status !== 'draft') throw forbidden('Questions can only be changed while the paper is a draft');

  const body = parse(questionSchema, req.body);
  validateQuestion(body, exam.blueprint);

  const section = exam.blueprint.sections.find((s) => s.key === body.section);
  const existing = await Question.countDocuments({ examId: exam._id, section: body.section, setLabel: body.setLabel });
  if (existing >= section.count) {
    throw conflict(`Part ${body.section} already has its ${section.count} questions`);
  }

  const q = await Question.create({
    ...body, ...tenant(req),
    examId: exam._id, subjectId: exam.subjectId,
    order: body.order || existing,
    createdBy: req.actor.id,
  });

  res.status(201).json({ question: { ...q.toObject(), id: String(q._id) } });
}));

/* A complete paper matching the examination's own blueprint, drawn
   from the subject's sample bank. For demonstrations: one click raises
   a full 50-mark paper rather than three example rows that fail
   validation against a 24-question pattern. */
r.get('/:id/sample-paper', can('question:create', 'exam:edit'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.id, ...tenant(req) })
    .populate('subjectId', 'code title').lean();
  if (!exam) throw notFound('Examination not found');

  const rows = samplePaper(exam.subjectId?.code || exam.code, exam.blueprint);
  res.json({
    subject: exam.subjectId?.code || exam.code,
    count: rows.length,
    rows,
  });
}));

r.post('/:id/questions/bulk', can('question:create'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.id, ...tenant(req) });
  if (!exam) throw notFound('Examination not found');
  if (exam.status !== 'draft') throw forbidden('Questions can only be changed while the paper is a draft');

  const rows = z.array(questionSchema).max(500).parse(req.body?.rows || []);
  const errors = [];
  const valid = [];

  // validate everything first — nothing is written if the file is wrong
  const tally = {};
  for (const [i, row] of rows.entries()) {
    try {
      validateQuestion(row, exam.blueprint);
      tally[row.section] = (tally[row.section] || 0) + 1;
      valid.push({ ...row, order: tally[row.section] - 1 });
    } catch (e) {
      errors.push({ row: i + 1, error: e.message });
    }
  }

  for (const s of exam.blueprint.sections) {
    const got = tally[s.key] || 0;
    if (got && got > s.count) errors.push({ row: null, error: `Part ${s.key} expects ${s.count} questions, the file has ${got}` });
  }

  if (errors.length) return res.status(400).json({ created: 0, errors });

  await Question.deleteMany({ examId: exam._id, ...tenant(req) });
  const docs = await Question.insertMany(valid.map((v) => ({
    ...v, ...tenant(req), examId: exam._id, subjectId: exam.subjectId, createdBy: req.actor.id,
  })));

  await audit(req, { action: 'question.bulk_uploaded', entity: 'Exam', entityId: exam._id, after: { count: docs.length } });
  res.json({ created: docs.length, errors: [] });
}));

r.patch('/:examId/questions/:qid', can('question:edit'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.examId, ...tenant(req) });
  if (!exam) throw notFound('Examination not found');
  if (exam.status !== 'draft') throw forbidden('Questions can only be changed while the paper is a draft');

  const q = await Question.findOne({ _id: req.params.qid, examId: exam._id });
  if (!q) throw notFound('Question not found');

  const body = parse(questionSchema.partial(), req.body);
  Object.assign(q, body);
  validateQuestion(q.toObject(), exam.blueprint);
  await q.save();

  res.json({ question: { ...q.toObject(), id: String(q._id) } });
}));

r.delete('/:examId/questions/:qid', can('question:delete'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.examId, ...tenant(req) });
  if (!exam) throw notFound('Examination not found');
  if (exam.status !== 'draft') throw forbidden('Questions can only be changed while the paper is a draft');

  await Question.deleteOne({ _id: req.params.qid, examId: exam._id });
  res.json({ ok: true });
}));

/* ============================================================
   DRAWING FROM THE BANK

   The paper takes a copy. A bank question edited or retired next term
   must not alter a paper already sat, and the paper needs its own
   order and set label. `sourceId` keeps the thread back so the bank
   can show where a question has been used.
   ============================================================ */
r.post('/:id/questions/from-bank', can('question:create'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.id, ...tenant(req) });
  if (!exam) throw notFound('Examination not found');
  if (['live', 'closed', 'evaluation', 'published'].includes(exam.status)) {
    throw forbidden(`A ${exam.status} examination can no longer take new questions`);
  }

  const body = parse(z.object({
    ids: z.array(z.string()).min(1).max(300),
    setLabel: z.string().default('A'),
  }), req.body);

  const picked = await Question.find({
    _id: { $in: body.ids }, ...tenant(req), examId: null, status: 'approved',
  }).lean();

  if (!picked.length) throw badRequest('None of those questions are in the bank and approved');

  const wrongSubject = picked.filter((q) => String(q.subjectId) !== String(exam.subjectId));
  if (wrongSubject.length) {
    throw badRequest(`${wrongSubject.length} of those questions belong to another subject`);
  }

  /* The direct upload path validates every row against the blueprint.
     This path inserts copies, so without the same check a bank
     question could land in a Part that does not take its kind.

     A mismatch of KIND is an error — a descriptive question cannot
     sit in a multiple-choice part. A mismatch of MARKS is not: how
     much a question is worth is a property of the paper's pattern,
     not of the question, so the copy takes the Part's mark. */
  const parts = new Map((exam.blueprint?.sections || []).map((s) => [s.key, s]));
  const noPart = picked.filter((q) => !parts.has(q.section));
  if (noPart.length) {
    throw badRequest(`This paper has no Part ${[...new Set(noPart.map((q) => q.section))].join(', ')}`);
  }
  const wrongKind = picked.filter((q) => parts.get(q.section).type !== q.type);
  if (wrongKind.length) {
    const q = wrongKind[0];
    throw badRequest(`Part ${q.section} of this paper takes ${parts.get(q.section).type} questions`
      + `, but ${wrongKind.length} of those drawn ${wrongKind.length === 1 ? 'is' : 'are'} ${q.type}`);
  }

  /* Each part of the paper keeps its own numbering, continuing after
     whatever is already there. */
  const existing = await Question.find({ examId: exam._id, setLabel: body.setLabel })
    .select('section order').lean();
  const nextOrder = {};
  for (const sec of ['A', 'B', 'C']) {
    nextOrder[sec] = existing.filter((e) => e.section === sec)
      .reduce((max, e) => Math.max(max, e.order + 1), 0);
  }

  /* The pattern is a ceiling, not a suggestion. The direct upload path
     enforces it; without the same check here a second draw could put
     fifteen questions into a Part of five — and nothing downstream
     would catch it, because the publication check looks at rooms and
     candidates, never at question counts. The candidate would then be
     served all fifteen and could score three times the stated mark
     for that Part. */
  const drawnPerSection = {};
  for (const q of picked) drawnPerSection[q.section] = (drawnPerSection[q.section] || 0) + 1;
  for (const [sec, n] of Object.entries(drawnPerSection)) {
    const already = existing.filter((e) => e.section === sec).length;
    const allowed = parts.get(sec).count;
    if (already + n > allowed) {
      throw badRequest(`Part ${sec} takes ${allowed} question(s) and already has ${already}. `
        + `Drawing ${n} more would make ${already + n}.`);
    }
  }

  const copies = picked.map((q) => {
    const { _id, createdAt, updatedAt, status, reviewedBy, reviewedAt, reviewNote,
            submittedAt, usedCount, lastUsedAt, ...rest } = q;
    const order = nextOrder[q.section]++;
    const part = parts.get(q.section);
    return {
      ...rest,
      examId: exam._id,
      sourceId: _id,
      setLabel: body.setLabel,
      order,
      /* Drawn into an either/or part, a question is paired with its
         neighbour — "1 or 2, 3 or 4", which is what the phrase means.
         The cell can repair the pairing in the builder; this is only
         the sensible opening position. A bank question's own group,
         if it somehow has one, is not carried into a paper. */
      choiceGroup: part?.choiceMode === 'either_or' ? String(Math.floor(order / 2) + 1) : undefined,
      marks: part.marksEach,
      status: 'approved',
    };
  });

  const made = await Question.insertMany(copies);
  await Question.updateMany(
    { _id: { $in: picked.map((q) => q._id) } },
    { $inc: { usedCount: 1 }, $set: { lastUsedAt: new Date() } },
  );

  await audit(req, { action: 'exam.questions_from_bank', entity: 'Exam', entityId: exam._id,
    after: { drawn: made.length, setLabel: body.setLabel } });

  const counts = {};
  for (const c of copies) counts[c.section] = (counts[c.section] || 0) + 1;
  res.status(201).json({ drawn: made.length, bySection: counts });
}));

/* ============================ ROOMS & SCHEDULING ============================ */

r.post('/:id/rooms/auto', can('schedule:create'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.id, ...tenant(req) });
  if (!exam) throw notFound('Examination not found');
  if (exam.status !== 'draft') throw forbidden('Rooms can only be built while the paper is a draft');

  const institution = await Institution.findById(req.actor.institutionId).lean();
  const capacity = Number(req.body?.capacity) || institution?.settings?.roomCapacity || 30;

  const students = await Student.find({
    ...tenant(req), batchId: { $in: exam.batchIds }, status: 'active',
  }).sort({ regNo: 1 }).select('_id regNo').lean();

  if (!students.length) throw badRequest('No active students are enrolled in the selected batches');

  await Room.deleteMany({ examId: exam._id });

  const startAt = examStartAt(exam);
  const endAt = new Date(startAt.getTime() + exam.durationMinutes * 60000);
  const roomCount = Math.ceil(students.length / capacity);

  const rooms = [];
  for (let i = 0; i < roomCount; i++) {
    const slice = students.slice(i * capacity, (i + 1) * capacity);
    rooms.push({
      ...tenant(req), examId: exam._id,
      name: `Room ${i + 1}`, capacity,
      startAt, endAt,
      studentIds: slice.map((s) => s._id),
    });
  }
  const created = await Room.insertMany(rooms);

  await audit(req, { action: 'schedule.rooms_built', entity: 'Exam', entityId: exam._id,
    after: { rooms: created.length, students: students.length } });

  res.status(201).json({
    rooms: created.map((x) => ({ id: String(x._id), name: x.name, allocated: x.studentIds.length })),
    students: students.length,
  });
}));

r.patch('/:examId/rooms/:roomId', can('schedule:edit'), wrap(async (req, res) => {
  const room = await Room.findOne({ _id: req.params.roomId, examId: req.params.examId, ...tenant(req) });
  if (!room) throw notFound('Room not found');

  const body = parse(z.object({
    name: z.string().optional(),
    invigilatorId: z.string().nullable().optional(),
    startAt: z.string().optional(),
    endAt: z.string().optional(),
  }), req.body);

  if (body.invigilatorId) {
    const clash = await findInvigilatorClash(req.actor.institutionId, body.invigilatorId, room);
    if (clash) {
      throw conflict(
        `That invigilator is already assigned to ${clash.name} at the same time`,
        { invigilatorId: `Clashes with ${clash.name}` },
      );
    }
  }

  Object.assign(room, body);
  await room.save();
  await audit(req, { action: 'schedule.room_updated', entity: 'Room', entityId: room._id, after: body });
  res.json({ room: { id: String(room._id), name: room.name } });
}));

/* Two rooms clash when their time windows overlap. The same invigilator
   is free to take another room on the same day at a different time. */
async function findInvigilatorClash(institutionId, invigilatorId, room) {
  return Room.findOne({
    institutionId,
    _id: { $ne: room._id },
    invigilatorId,
    startAt: { $lt: room.endAt },
    endAt: { $gt: room.startAt },
  }).lean();
}

/* ---------------- conflict report ----------------
   Runs before publication. Publication is blocked while any
   blocking conflict remains.                                */
r.get('/:id/conflicts', can('schedule:view', 'exam:view'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.id, ...tenant(req) });
  if (!exam) throw notFound('Examination not found');

  const conflicts = await collectConflicts(exam, req.actor.institutionId);
  res.json({ conflicts, publishable: conflicts.filter((c) => c.blocking).length === 0 });
}));

async function collectConflicts(exam, institutionId) {
  const out = [];
  const rooms = await Room.find({ examId: exam._id }).populate('invigilatorId', 'name').lean();

  if (!rooms.length) {
    out.push({ kind: 'no_rooms', blocking: true, message: 'No rooms have been created for this examination' });
  }

  // 1. rooms without an invigilator
  for (const room of rooms) {
    if (!room.invigilatorId) {
      out.push({ kind: 'invigilator_missing', blocking: true, roomId: String(room._id),
        message: `${room.name} has no invigilator assigned` });
    }
    if (room.studentIds.length > room.capacity) {
      out.push({ kind: 'over_capacity', blocking: true, roomId: String(room._id),
        message: `${room.name} holds ${room.studentIds.length} candidates but its capacity is ${room.capacity}` });
    }
  }

  // 2. one invigilator in two overlapping rooms
  const seen = new Map();
  for (const room of rooms) {
    if (!room.invigilatorId) continue;
    const key = String(room.invigilatorId._id);
    const prior = seen.get(key) || [];
    for (const other of prior) {
      if (room.startAt < other.endAt && room.endAt > other.startAt) {
        out.push({ kind: 'invigilator_clash', blocking: true,
          message: `${room.invigilatorId.name} is assigned to both ${other.name} and ${room.name} at the same time` });
      }
    }
    seen.set(key, [...prior, room]);
  }

  // 3. invigilator already booked on another examination
  for (const room of rooms) {
    if (!room.invigilatorId) continue;

    /* A room's window is the ordinary one. If candidates in it have
       been given sittings of their own, the invigilator is needed
       until the last of those ends — and a clash check that stopped
       at the room's own endAt would happily double-book them for the
       afternoon. */
    const sittings = await Attempt.find({
      roomId: room._id, 'sitting.startsAt': { $ne: null },
    }).select('sitting').lean();

    let watchUntil = new Date(room.endAt);
    for (const a of sittings) {
      const ends = new Date(new Date(a.sitting.startsAt).getTime()
        + (a.sitting.durationMinutes || exam.durationMinutes) * 60000);
      if (ends > watchUntil) watchUntil = ends;
    }

    const clash = await Room.findOne({
      institutionId,
      examId: { $ne: exam._id },
      invigilatorId: room.invigilatorId._id,
      startAt: { $lt: watchUntil },
      endAt: { $gt: room.startAt },
    }).populate('examId', 'title').lean();
    if (clash) {
      out.push({ kind: 'invigilator_clash_other_exam', blocking: true,
        message: `${room.invigilatorId.name} is already invigilating ${clash.examId?.title || 'another examination'} at this time` });
    }
  }

  // 4. a candidate scheduled into two rooms at once
  const allStudentIds = rooms.flatMap((x) => x.studentIds.map(String));
  const dupes = allStudentIds.filter((id, i) => allStudentIds.indexOf(id) !== i);
  if (dupes.length) {
    out.push({ kind: 'student_duplicate', blocking: true,
      message: `${new Set(dupes).size} candidate(s) are allocated to more than one room` });
  }

  const overlapping = await Room.find({
    institutionId,
    examId: { $ne: exam._id },
    studentIds: { $in: allStudentIds },
    startAt: { $lt: rooms[0]?.endAt },
    endAt: { $gt: rooms[0]?.startAt },
  }).populate('examId', 'title').lean();
  for (const o of overlapping) {
    out.push({ kind: 'student_clash_other_exam', blocking: true,
      message: `Some candidates are also scheduled for ${o.examId?.title || 'another examination'} at this time` });
  }

  // 5. blueprint not fully authored
  const counts = await Question.aggregate([
    { $match: { examId: exam._id } },
    { $group: { _id: '$section', n: { $sum: 1 } } },
  ]);
  const have = Object.fromEntries(counts.map((c) => [c._id, c.n]));
  for (const s of exam.blueprint.sections) {
    const got = have[s.key] || 0;
    if (got < s.count) {
      out.push({ kind: 'questions_missing', blocking: true,
        message: `Part ${s.key} has ${got} of ${s.count} questions authored` });
    }
  }

  // 6. licence balance
  const institution = await Institution.findById(institutionId).lean();
  const needed = allStudentIds.length;
  const available = (institution?.licence?.balance || 0) - (institution?.licence?.reserved || 0);
  if (needed > available) {
    out.push({ kind: 'licence_short', blocking: true,
      message: `${needed} licences are needed but only ${available} remain. Publication is blocked so that no examination can fail on the day for want of licences.` });
  }

  return out;
}

/* ---------------- publish ----------------
   Creates one attempt per candidate and reserves licences. */
/* ============================================================
   ENDING A PAPER

   "Hand in your papers." There was no way to say it, and a paper
   nobody ends never ends: a candidate who shuts the laptop stays in
   progress for ever, because their attempt is only auto-submitted
   when their own browser next calls the API.

   Open to the invigilator as well as the cell — the person standing
   in the hall is the one who knows the paper is over.
   ============================================================ */

/* An invigilator may end the paper they are standing in front of —
   and only that one.

   `can('exam:edit', 'invigilation:edit')` is an OR, so without this
   an invigilator assigned to one morning room could POST the id of
   the afternoon paper and force-submit every candidate sitting it.
   The preview is just as bad: it lists every candidate's name and
   register number.

   Someone holding `exam:edit` is the examination cell and is
   institution-wide by design. */
async function assertMayEndThisExam(req, exam) {
  if (req.actor.permissions.has('exam:edit')) return;
  if (req.actor.scope === 'institution') return;

  const mine = await Room.countDocuments({
    examId: exam._id, ...tenant(req), invigilatorId: req.actor.id,
  });
  if (!mine) {
    throw forbidden('You are not invigilating this examination, so you cannot end it.');
  }
}

/* What ending it now would do, before anyone commits to it. */
r.get('/:id/close-preview', can('exam:edit', 'invigilation:edit'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.id, ...tenant(req) }).lean();
  if (!exam) throw notFound('Examination not found');
  await assertMayEndThisExam(req, exam);

  const writing = await Attempt.find({ examId: exam._id, ...tenant(req), status: 'in_progress' })
    .populate('studentId', 'name regNo')
    .populate('roomId', 'name')
    .lean();

  const at = new Date();
  const seal = [];
  const keep = [];

  for (const a of writing) {
    const allowed = mayContinue(a, exam, at);
    const row = {
      attemptId: String(a._id),
      student: a.studentId ? { name: a.studentId.name, regNo: a.studentId.regNo } : null,
      room: a.roomId?.name || null,
      answered: (a.answers || []).filter((x) => x.selected?.length || (x.text || '').trim()
        || (x.html || '').trim() || x.scanPages?.length).length,
      timerEndsAt: a.timerEndsAt,
    };
    if (allowed.yes) keep.push({ ...row, why: allowed.why, until: allowed.until,
                                 minutes: allowed.minutes || null });
    else seal.push(row);
  }

  /* Split, because a candidate with a sitting arranged for this
     afternoon is NOT absent — telling the cell they are is how a
     paper gets ended out from under two people who were promised a
     different time. */
  const notYetStarted = await Attempt.find({
    examId: exam._id, ...tenant(req), status: { $in: ['not_started', 'verifying'] },
  }).populate('studentId', 'name regNo').select('sitting studentId').lean();

  const dueLater = notYetStarted
    .filter((a) => a.sitting?.startsAt && new Date(a.sitting.startsAt) > at)
    .map((a) => ({
      attemptId: String(a._id),
      student: a.studentId ? { name: a.studentId.name, regNo: a.studentId.regNo } : null,
      startsAt: a.sitting.startsAt,
    }));
  const notStarted = notYetStarted.length - dueLater.length;

  res.json({
    exam: {
      id: String(exam._id), title: exam.title, code: exam.code, status: exam.status,
      startsAt: examStartAt(exam), durationMinutes: exam.durationMinutes,
      closedAt: exam.closedAt || null,
    },
    /* Three groups, because they are three different things and the
       cell has to see which is which before pressing anything. */
    willBeSealed: seal,
    willKeepWriting: keep,
    /* Arranged for later, and unaffected by ending the paper now. */
    dueLater,
    neverStarted: notStarted,
  });
}));

r.post('/:id/close', can('exam:edit', 'invigilation:edit'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.id, ...tenant(req) });
  if (!exam) throw notFound('Examination not found');
  await assertMayEndThisExam(req, exam);

  /* Brought up to date first. The stored status only advances when
     somebody loads a list, so a paper being sat right now can still
     read 'scheduled' — and refusing to end it with "this examination
     has not started" would be both wrong and baffling. */
  const institution = await Institution.findById(req.actor.institutionId).lean();
  await syncExamStatus(exam, institution);

  if (['draft', 'scheduled'].includes(exam.status) && !exam.closedAt) {
    throw badRequest('This examination has not started, so there is nothing to end. '
      + 'Delete it, or move its date.');
  }
  if (exam.closedAt) {
    throw badRequest(`This examination was already ended on `
      + `${new Date(exam.closedAt).toLocaleString('en-GB')}.`);
  }

  const { reason } = parse(z.object({
    reason: z.string().min(3, 'State why the paper is being ended').max(300),
  }), req.body);

  const result = await closeExam(exam, { actorId: req.actor.id, reason });

  await audit(req, {
    action: 'exam.closed', entity: 'Exam', entityId: exam._id,
    after: { reason, sealed: result.sealed, stillWriting: result.continuing.length },
  });

  res.json({
    ok: true,
    sealed: result.sealed,
    stillWriting: result.continuing.length,
    /* Named, because "two candidates are still writing" is something
       the invigilator has to act on — they are still being watched. */
    continuing: result.continuing,
    status: exam.status,
  });
}));

/* ============================================================
   ALTERNATE SITTINGS

   The request, in the cell's own words: the paper runs 10:00 to
   12:00, but two candidates are working professionals who can only
   sit it between 14:00 and 16:00. Same examination, same paper, same
   marks — a different window, for those two.

   This is not the late-entry extension, which stretches the existing
   window and still begins from the examination's own start. It
   replaces the window for one candidate.
   ============================================================ */

/* Who is sitting this paper, and when. */
r.get('/:id/sittings', can('exam:view', 'schedule:view'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.id, ...tenant(req) })
    .populate('subjectId', 'code title').lean();
  if (!exam) throw notFound('Examination not found');

  const attempts = await Attempt.find({ examId: exam._id, ...tenant(req) })
    .populate('studentId', 'name regNo')
    .populate('roomId', 'name')
    .lean();

  const ordinary = examStartAt(exam);

  res.json({
    exam: {
      id: String(exam._id), title: exam.title, code: exam.code, status: exam.status,
      date: exam.date, startTime: exam.startTime, timezone: exam.timezone,
      durationMinutes: exam.durationMinutes,
      startsAt: ordinary,
      endsAt: ordinary ? new Date(ordinary.getTime() + exam.durationMinutes * 60000) : null,
      alternateSittings: exam.alternateSittings || 0,
    },
    candidates: attempts.map((a) => {
      const s = sittingFor(a, exam);
      return {
        attemptId: String(a._id),
        student: a.studentId
          ? { id: String(a.studentId._id), name: a.studentId.name, regNo: a.studentId.regNo }
          : null,
        room: a.roomId?.name || null,
        status: a.status,
        /* A candidate who has already begun cannot be moved: their
           clock is running and their paper is open. */
        movable: ['not_started', 'verifying'].includes(a.status),
        sitting: s.isAlternate
          ? {
            startsAt: s.startAt, endsAt: s.endsAt,
            durationMinutes: s.durationMinutes, reason: s.reason,
            grantedAt: a.sitting?.grantedAt,
          }
          : null,
      };
    }).sort((x, y) => (x.student?.regNo || '').localeCompare(y.student?.regNo || '')),
  });
}));

/* Grant, change or withdraw a sitting for one or more candidates. */
r.post('/:id/sittings', can('schedule:edit', 'exam:edit'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.id, ...tenant(req) });
  if (!exam) throw notFound('Examination not found');
  if (['closed', 'evaluation', 'published'].includes(exam.status)) {
    throw forbidden(`A ${exam.status} examination can no longer be re-timed`);
  }

  const body = parse(z.object({
    attemptIds: z.array(z.string()).min(1, 'Choose at least one candidate'),
    /* Absent means withdraw the sitting and put them back in the
       examination's own window. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-08').optional(),
    startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Use a time like 14:00').optional(),
    durationMinutes: z.number().int().min(5).max(600).optional(),
    reason: z.string().min(5, 'State why this sitting is arranged').max(500).optional(),
  }), req.body);

  const withdrawing = !body.date || !body.startTime;

  const attempts = await Attempt.find({
    _id: { $in: body.attemptIds }, examId: exam._id, ...tenant(req),
  });
  if (attempts.length !== new Set(body.attemptIds).size) {
    throw badRequest('One of those candidates is not sitting this examination');
  }

  /* A candidate already writing cannot be re-timed: the clock is
     running and the paper is open in front of them. */
  const started = attempts.filter((a) => !['not_started', 'verifying'].includes(a.status));
  if (started.length) {
    throw badRequest(`${started.length} of those have already started or finished.`
      + ' Their sitting cannot be changed.');
  }

  let startsAt = null;
  let duration = exam.durationMinutes;

  if (!withdrawing) {
    if (!body.reason) throw badRequest('State why this sitting is arranged');
    const zone = exam.timezone || DEFAULT_TIMEZONE;
    startsAt = zonedToUtc(body.date, body.startTime, zone);
    if (!startsAt) throw badRequest('That date and time could not be read');
    duration = body.durationMinutes || exam.durationMinutes;

    /* A sitting before the paper itself opens would hand the
       questions out early. */
    const ordinary = examStartAt(exam);
    if (ordinary && startsAt < ordinary) {
      throw badRequest('A sitting cannot begin before the examination itself. '
        + 'The paper is sealed until then.');
    }
  }

  const update = withdrawing
    ? { $unset: { sitting: '' } }
    : {
      $set: {
        sitting: {
          startsAt,
          durationMinutes: duration,
          reason: body.reason,
          grantedBy: req.actor.id,
          grantedAt: new Date(),
        },
      },
    };

  /* The status filter is repeated IN the write, not only in the check
     above. A candidate who presses Start between the read and the
     write would otherwise end up in progress with a future sitting —
     and `/start` refuses a paper whose sitting has not begun, so they
     would be locked out of their own open paper while its clock ran
     down to an auto-submit. */
  const result = await Attempt.updateMany({
    _id: { $in: attempts.map((a) => a._id) }, ...tenant(req),
    status: { $in: ['not_started', 'verifying'] },
  }, update);

  /* Not an error — the rest were changed. But silence here would
     leave the cell believing a candidate was re-timed when they were
     not, because they pressed Start a moment before the write. */
  const skipped = attempts.length - result.matchedCount;
  if (skipped > 0) {
    await audit(req, { action: 'exam.sitting_partial', entity: 'Exam', entityId: exam._id,
      after: { requested: attempts.length, changed: result.matchedCount } });
  }

  /* The paper has to know how far its sittings now reach, or it files
     itself under past papers while someone is still writing. */
  const withSittings = await Attempt.find({
    examId: exam._id, ...tenant(req), 'sitting.startsAt': { $ne: null },
  }).select('sitting').lean();

  const ends = withSittings.map((a) => new Date(
    new Date(a.sitting.startsAt).getTime()
    + (a.sitting.durationMinutes || exam.durationMinutes) * 60000,
  ));
  exam.alternateSittings = withSittings.length;
  exam.lastSittingEndsAt = lastSittingEnd(exam, ends);
  await recomputeWritingUntil(exam);
  await exam.save();

  await audit(req, {
    action: withdrawing ? 'exam.sitting_withdrawn' : 'exam.sitting_granted',
    entity: 'Exam', entityId: exam._id,
    after: { candidates: attempts.length, date: body.date, startTime: body.startTime,
             durationMinutes: duration, reason: body.reason },
  });

  res.json({
    ok: true,
    changed: result.matchedCount,
    skippedBecauseStarted: skipped,
    withdrawn: withdrawing,
    startsAt,
    endsAt: startsAt ? new Date(startsAt.getTime() + duration * 60000) : null,
    alternateSittings: exam.alternateSittings,
  });
}));

r.post('/:id/publish', can('exam:publish', 'schedule:publish'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.id, ...tenant(req) });
  if (!exam) throw notFound('Examination not found');
  if (exam.status !== 'draft') throw badRequest('This examination has already been published');

  const conflicts = await collectConflicts(exam, req.actor.institutionId);
  const blocking = conflicts.filter((c) => c.blocking);
  if (blocking.length) {
    return res.status(409).json({ error: 'Resolve the conflicts before publishing', conflicts: blocking });
  }

  const rooms = await Room.find({ examId: exam._id }).lean();
  const startAt = examStartAt(exam);

  const attempts = [];
  for (const room of rooms) {
    for (const sid of room.studentIds) {
      attempts.push({
        ...tenant(req),
        examId: exam._id, roomId: room._id, studentId: sid,
        status: 'not_started',
        setLabel: exam.randomisation?.paperSets?.length
          ? exam.randomisation.paperSets[attempts.length % exam.randomisation.paperSets.length]
          : 'A',
      });
    }
  }
  await Attempt.insertMany(attempts, { ordered: false }).catch((e) => {
    if (e.code !== 11000) throw e;    // re-publish of an existing set
  });

  exam.status = 'scheduled';
  exam.publishedAt = new Date();
  exam.sealedUntil = startAt;
  await exam.save();

  await Institution.findByIdAndUpdate(req.actor.institutionId, {
    $inc: { 'licence.reserved': attempts.length },
  });

  await audit(req, { action: 'exam.published', entity: 'Exam', entityId: exam._id,
    after: { candidates: attempts.length, rooms: rooms.length } });

  res.json({
    ok: true,
    status: exam.status,
    candidates: attempts.length,
    rooms: rooms.length,
    notified: attempts.length,
  });
}));


/* A draft or scheduled paper may be deleted outright. Once a candidate
   has started it, it is part of the record and can only be closed. */
r.delete('/:id', can('exam:delete'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.id, ...tenant(req) });
  if (!exam) throw notFound('Examination not found');

  const institution = await Institution.findById(req.actor.institutionId).lean();
  await syncExamStatus(exam, institution);

  /* A paper being sat right now is the one thing that cannot be
     deleted: candidates are mid-answer and their attempts are open.
     Everything else may go, because a demonstration institution has
     to be clearable and a cell that scheduled the wrong paper should
     not be stuck with it for ever. */
  if (exam.status === 'live') {
    const sitting = await Attempt.countDocuments({ examId: exam._id, status: 'in_progress' });
    if (sitting) {
      throw badRequest(`${sitting} candidate(s) are sitting this paper right now. Close it first.`);
    }
  }

  const [attempts, started] = await Promise.all([
    Attempt.countDocuments({ examId: exam._id }),
    Attempt.countDocuments({ examId: exam._id, status: { $ne: 'not_started' } }),
  ]);

  /* Records exist, so say exactly what will be destroyed and make
     the caller ask again. The web app turns this into a second
     confirmation naming the same numbers. */
  if (started > 0 && req.query.force !== 'true') {
    throw conflict(
      `This examination holds ${started} sat attempt(s), with their marks and proctoring evidence. `
      + 'Deleting it destroys all of that permanently.',
      { requiresForce: true, attempts, started, title: exam.title, code: exam.code },
    );
  }

  await Promise.all([
    Question.deleteMany({ examId: exam._id }),
    Room.deleteMany({ examId: exam._id }),
    Attempt.deleteMany({ examId: exam._id }),
  ]);

  /* Captures outlive the database rows unless they are removed too. */
  try {
    await storage.remove(`${req.actor.institutionId}/${exam._id}`);
  } catch (e) {
    console.warn('[exam.delete] evidence not removed:', e.message);
  }

  if (['scheduled', 'live'].includes(exam.status) && attempts) {
    await Institution.findByIdAndUpdate(req.actor.institutionId, {
      $inc: { 'licence.reserved': -attempts },
    });
  }

  await exam.deleteOne();
  await audit(req, { action: 'exam.deleted', entity: 'Exam', entityId: exam._id,
    before: { title: exam.title, code: exam.code, status: exam.status, attempts, started } });
  res.json({ ok: true, deleted: { attempts, started } });
}));

export default r;
