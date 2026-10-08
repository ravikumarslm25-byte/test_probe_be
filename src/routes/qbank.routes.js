/* ============================================================
   QUESTION BANK

   Papers used to be written the week they were scheduled, because a
   question could only exist inside an examination. That is backwards:
   an examination cell wants a stock of approved questions standing
   ready, written by subject staff over the term, so assembling a
   paper is a matter of choosing rather than commissioning.

   A bank question is one with no examId. It moves draft →
   pending_review → approved, and only approved questions can be drawn
   into a paper. Subject staff see and write only for the subjects
   they are mapped to; the examination cell sees everything and
   approves.

   Drawing a question into a paper COPIES it. A bank question edited
   next term must not alter a paper already sat, and a paper needs its
   own order and set label. The copy keeps `sourceId` so the bank can
   show where a question has been used.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Question, QuestionUpload } from '../models/exam.js';
import { Subject } from '../models/core.js';
import { authenticate, can, tenant, tenantAgg, resolveScope } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { wrap, notFound, badRequest, forbidden } from '../utils/http.js';
import { parse } from '../utils/validate.js';

const r = Router();
r.use(authenticate);

/* A bank question is one that belongs to no paper. */
const BANK = { examId: null };

const questionBody = z.object({
  subjectId: z.string().min(1, 'Choose a subject'),
  section: z.enum(['A', 'B', 'C']),
  type: z.enum(['mcq', 'fib', 'desc']),
  text: z.string().min(5, 'Enter the question'),
  marks: z.number().min(0.5),
  options: z.array(z.object({ key: z.string(), text: z.string() })).optional(),
  correctOptions: z.array(z.string()).optional(),
  multiSelect: z.boolean().optional(),
  acceptedAnswers: z.array(z.string()).optional(),
  keywords: z.array(z.object({ term: z.string(), weight: z.number().default(1) })).optional(),
  modelAnswer: z.string().optional(),
  markingGuidance: z.string().optional(),
  unit: z.string().optional(),
  topic: z.string().optional(),
  difficulty: z.enum(['easy', 'moderate', 'hard']).optional(),
});

/* The same rules the paper builder applies, so a question cannot be
   approved into the bank and then rejected at assembly time. */
function validateShape(q) {
  if (q.type === 'mcq') {
    if (!q.options || q.options.length < 2) throw badRequest('A multiple-choice question needs at least two options');
    if (!q.correctOptions || !q.correctOptions.length) throw badRequest('Mark which option is correct');
    const keys = q.options.map((o) => o.key);
    const stray = q.correctOptions.filter((k) => !keys.includes(k));
    if (stray.length) throw badRequest(`Correct option "${stray[0]}" is not one of the options given`);
  }
  /* `.filter(Boolean)` would keep a string of spaces, which matches
     nothing a candidate could type. */
  if (q.type === 'fib' && !(q.acceptedAnswers || []).filter((a) => a && a.trim()).length) {
    throw badRequest('A fill-in-the-blank question needs at least one accepted answer');
  }
  /* The paper builder refuses a descriptive question with no marking
     keywords, because the evaluator then gets no suggested mark. If
     the bank let one through, it would be approved here and rejected
     at assembly — so the requirement belongs at authoring time. */
  if (q.type === 'desc' && !(q.keywords || []).filter((k) => k && k.term && k.term.trim()).length) {
    throw badRequest('A descriptive question needs marking keywords, so the evaluator gets a suggested mark');
  }
}

/* Subject staff write for their mapped subjects only. The examination
   cell is institution-scoped and sees the whole bank. */
async function assertSubjectInScope(req, subjectId) {
  const scope = await resolveScope(req.actor);
  if (!scope) return;
  if (!scope.subjectIds.includes(String(subjectId))) {
    throw forbidden('You are not mapped to that subject. Ask the examination cell to map it to you.');
  }
}

/* ============================================================
   LIST
   ============================================================ */
r.get('/', can('question:view'), wrap(async (req, res) => {
  const scope = await resolveScope(req.actor);
  const filter = { ...tenant(req), ...BANK };

  /* A subject asked for narrows the scope; it never widens it. Taking
     `?subjectId=` as given would have let a scoped author read the
     bank of any subject by naming it. */
  if (req.query.subjectId) {
    if (scope && !scope.subjectIds.includes(String(req.query.subjectId))) {
      return res.json({ scopedToMe: true, outOfScope: true, questions: [] });
    }
    filter.subjectId = req.query.subjectId;
  } else if (scope) {
    filter.subjectId = { $in: scope.subjectIds.map((s) => new Types.ObjectId(s)) };
  }

  /* Scoped like everything else: `uploadId` names a batch, and a
     batch belongs to a subject. Taken on trust it would be a way to
     read another institution's bank by naming one of its batches. */
  if (req.query.uploadId) {
    const batch = await QuestionUpload.findOne({
      _id: req.query.uploadId, ...tenant(req),
    }).select('subjectId').lean();
    if (!batch) return res.json({ scopedToMe: Boolean(scope), questions: [] });
    if (scope && !scope.subjectIds.includes(String(batch.subjectId))) {
      return res.json({ scopedToMe: true, outOfScope: true, questions: [] });
    }
    filter.uploadId = batch._id;
  }
  if (req.query.status) filter.status = req.query.status;
  if (req.query.type) filter.type = req.query.type;
  if (req.query.section) filter.section = req.query.section;
  if (req.query.difficulty) filter.difficulty = req.query.difficulty;
  if (req.query.q) filter.text = { $regex: String(req.query.q).slice(0, 80), $options: 'i' };

  const rows = await Question.find(filter)
    .populate('subjectId', 'code title')
    .populate('uploadId', 'label createdAt')
    .populate('createdBy', 'name')
    .populate('reviewedBy', 'name')
    .sort({ updatedAt: -1 })
    .limit(Number(req.query.limit) || 500)
    .lean();

  res.json({
    scopedToMe: Boolean(scope),
    questions: rows.map(shape),
  });
}));

/* Counts per subject and state — what the examination cell looks at
   to see whether a paper can be assembled yet. */
r.get('/summary', can('question:view'), wrap(async (req, res) => {
  const scope = await resolveScope(req.actor);
  /* `tenantAgg`, not `tenant`: an aggregation pipeline is not cast
     against the schema, so the string form matches nothing and every
     subject reads zero. */
  const match = { ...tenantAgg(req), ...BANK };
  if (scope) match.subjectId = { $in: scope.subjectIds.map((s) => new Types.ObjectId(s)) };

  const rows = await Question.aggregate([
    { $match: match },
    { $group: { _id: { subjectId: '$subjectId', status: '$status', section: '$section' }, n: { $sum: 1 } } },
  ]);

  const subjects = await Subject.find(
    scope ? { ...tenant(req), _id: { $in: scope.subjectIds } } : tenant(req),
  ).select('code title').lean();

  const by = {};
  for (const s of subjects) {
    by[String(s._id)] = {
      subject: { id: String(s._id), code: s.code, title: s.title },
      total: 0,
      byStatus: { draft: 0, pending_review: 0, approved: 0, rejected: 0, retired: 0 },
      approvedBySection: { A: 0, B: 0, C: 0 },
    };
  }
  for (const row of rows) {
    const entry = by[String(row._id.subjectId)];
    if (!entry) continue;
    entry.total += row.n;
    entry.byStatus[row._id.status] = (entry.byStatus[row._id.status] || 0) + row.n;
    if (row._id.status === 'approved') {
      entry.approvedBySection[row._id.section] = (entry.approvedBySection[row._id.section] || 0) + row.n;
    }
  }
  res.json({ subjects: Object.values(by).sort((a, b) => a.subject.code.localeCompare(b.subject.code)) });
}));

/* ============================================================
   WRITE
   ============================================================ */
r.post('/', can('question:create'), wrap(async (req, res) => {
  const body = parse(questionBody, req.body);
  await assertSubjectInScope(req, body.subjectId);
  validateShape(body);

  const q = await Question.create({
    ...body, ...tenant(req), examId: null, status: 'draft', createdBy: req.actor.id,
  });
  await audit(req, { action: 'question.created', entity: 'Question', entityId: q._id,
    after: { subjectId: body.subjectId, section: body.section, type: body.type } });
  res.status(201).json({ question: shape(q.toObject()) });
}));

r.post('/bulk', can('question:create'), wrap(async (req, res) => {
  const { rows, label, fileName } = parse(z.object({
    rows: z.array(questionBody).min(1).max(500),
    /* What to call this batch. A subject's bank is built over a term
       in several uploads, and "Unit I and II" is how the cell refers
       to one of them. Defaulted from the file name, or the date. */
    label: z.string().max(80).optional(),
    fileName: z.string().max(200).optional(),
  }), req.body);

  /* Every row is checked before anything is written, so a bad row in
     the middle of a spreadsheet does not leave half a paper's worth
     of questions in the bank. */
  const problems = [];
  const subjects = new Set();
  rows.forEach((row, i) => {
    subjects.add(String(row.subjectId));
    try { validateShape(row); } catch (e) { problems.push({ row: i + 1, error: e.message }); }
  });
  for (const s of subjects) {
    try { await assertSubjectInScope(req, s); } catch (e) { problems.push({ row: 0, error: e.message }); }
  }
  if (problems.length) throw badRequest(`${problems.length} row(s) could not be accepted`, problems);

  /* The batch is recorded first, so every question can point at it.
     A spreadsheet that covers two subjects is unusual but legal; it
     produces one batch per subject rather than one batch holding
     questions that belong to different papers. */
  const bySubject = new Map();
  for (const row of rows) {
    const key = String(row.subjectId);
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(row);
  }

  const when = new Date();
  const stamp = when.toISOString().slice(0, 10);
  let created = 0;
  const batches = [];

  for (const [subjectId, subjectRows] of bySubject) {
    const sections = { A: 0, B: 0, C: 0 };
    for (const r2 of subjectRows) sections[r2.section] = (sections[r2.section] || 0) + 1;

    const batch = await QuestionUpload.create({
      ...tenant(req),
      subjectId,
      label: (label && label.trim())
        || (fileName ? fileName.replace(/\.[a-z0-9]+$/i, '').slice(0, 80) : '')
        || `Upload of ${stamp}`,
      fileName,
      count: subjectRows.length,
      bySection: sections,
      units: [...new Set(subjectRows.map((r2) => r2.unit).filter(Boolean))].sort(),
      createdBy: req.actor.id,
    });

    const docs = subjectRows.map((row) => ({
      ...row, ...tenant(req), examId: null, status: 'draft',
      uploadId: batch._id, createdBy: req.actor.id,
    }));

    /* The batch record is written first so the questions can point at
       it. If the questions then fail, the batch is removed rather
       than left behind claiming sixty questions that do not exist —
       it would show in the list for ever with a total of zero. */
    let made;
    try {
      made = await Question.insertMany(docs);
    } catch (e) {
      await QuestionUpload.deleteOne({ _id: batch._id }).catch(() => {});
      throw e;
    }
    created += made.length;
    batches.push({ id: String(batch._id), label: batch.label, count: made.length });
  }

  await audit(req, { action: 'question.bulk_created', entity: 'Question',
    after: { created, subjects: [...subjects], batches } });
  res.status(201).json({ created, batches });
}));

/* ============================================================
   THE BATCHES A SUBJECT'S BANK WAS BUILT FROM

   An examination cell does not assemble a paper from "the Managerial
   Economics bank". It assembles from the batch the subject staff
   uploaded for those units, this term. Four hundred questions in one
   undifferentiated list is not a bank anyone can work with.
   ============================================================ */
r.get('/uploads', can('question:view'), wrap(async (req, res) => {
  const scope = await resolveScope(req.actor);
  const filter = { ...tenant(req) };

  if (req.query.subjectId) {
    if (scope && !scope.subjectIds.includes(String(req.query.subjectId))) {
      return res.json({ uploads: [] });
    }
    filter.subjectId = req.query.subjectId;
  } else if (scope) {
    filter.subjectId = { $in: scope.subjectIds.map((x) => new Types.ObjectId(x)) };
  }

  const uploads = await QuestionUpload.find(filter)
    .populate('subjectId', 'code title')
    .populate('createdBy', 'name')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  /* Counted live rather than stored, because questions are approved,
     retired and deleted after the batch is written — a stored count
     would start lying on the first approval. */
  const counts = await Question.aggregate([
    { $match: { ...tenantAgg(req), ...BANK, uploadId: { $in: uploads.map((u) => u._id) } } },
    { $group: { _id: { uploadId: '$uploadId', status: '$status' }, n: { $sum: 1 } } },
  ]);

  const live = new Map();
  for (const c of counts) {
    const key = String(c._id.uploadId);
    if (!live.has(key)) live.set(key, { total: 0, approved: 0, pending: 0, draft: 0 });
    const e = live.get(key);
    e.total += c.n;
    if (c._id.status === 'approved') e.approved += c.n;
    else if (c._id.status === 'pending_review') e.pending += c.n;
    else if (c._id.status === 'draft') e.draft += c.n;
  }

  res.json({
    uploads: uploads.map((u) => ({
      id: String(u._id),
      label: u.label,
      fileName: u.fileName,
      uploadedAt: u.createdAt,
      by: u.createdBy?.name || null,
      subject: u.subjectId
        ? { id: String(u.subjectId._id), code: u.subjectId.code, title: u.subjectId.title }
        : null,
      bySection: u.bySection,
      units: u.units || [],
      /* `remaining` is what is still in the bank from this batch;
         `count` is what it arrived with. They differ once questions
         are deleted, and the difference is worth seeing. */
      count: u.count,
      ...(live.get(String(u._id)) || { total: 0, approved: 0, pending: 0, draft: 0 }),
    })),
  });
}));

/* ============================================================
   PUTTING RIGHT A WHOLE UPLOAD

   A bulk upload names its subject once, in the dialog. Choose the
   wrong one and sixty questions land under the wrong paper — and
   until now the only way back was to delete them one at a time, sixty
   times, through a confirm each.

   So both operations take a list. Moving is the one that matters:
   the questions are correct, only their subject is wrong, and
   re-uploading would mean re-authoring.
   ============================================================ */
const MAX_BULK = 500;

/* Loads the questions named, refusing early and by name if any is
   outside the caller's scope — rather than moving half of them and
   failing on the rest. */
async function loadForBulk(req, ids) {
  if (ids.length > MAX_BULK) throw badRequest(`That is more than ${MAX_BULK} questions at once.`);

  const found = await Question.find({ _id: { $in: ids }, ...tenant(req), ...BANK })
    .populate('subjectId', 'code').lean();

  if (found.length !== new Set(ids).size) {
    const have = new Set(found.map((q) => String(q._id)));
    const missing = [...new Set(ids)].filter((id) => !have.has(id)).length;
    throw badRequest(`${missing} of those questions are no longer in the bank. Refresh and try again.`);
  }

  const scope = await resolveScope(req.actor);
  if (scope) {
    const outside = found.filter((q) => !scope.subjectIds.includes(String(q.subjectId?._id || q.subjectId)));
    if (outside.length) {
      throw forbidden(`${outside.length} of those belong to a subject you are not mapped to.`);
    }
  }
  return found;
}

/* Move a set of questions to another subject — the fix for a bulk
   upload filed under the wrong paper. The other fields are offered
   too, because a whole upload usually shares a unit and a difficulty
   and correcting those one by one is the same tedium. */
r.patch('/many', can('question:edit'), wrap(async (req, res) => {
  const body = parse(z.object({
    ids: z.array(z.string()).min(1, 'Choose at least one question'),
    subjectId: z.string().optional(),
    unit: z.string().optional(),
    topic: z.string().optional(),
    difficulty: z.enum(['easy', 'moderate', 'hard']).optional(),
  }), req.body);

  const set = {};
  for (const k of ['subjectId', 'unit', 'topic', 'difficulty']) {
    if (body[k] !== undefined) set[k] = body[k];
  }
  if (!Object.keys(set).length) throw badRequest('Nothing to change');

  const found = await loadForBulk(req, body.ids);

  /* The destination has to be a real subject, and one the caller may
     write to — otherwise this is a way to push questions into a
     subject you are not mapped to. */
  if (set.subjectId) {
    const target = await Subject.findOne({ _id: set.subjectId, ...tenant(req) }).select('code title').lean();
    if (!target) throw badRequest('That subject does not exist');
    await assertSubjectInScope(req, set.subjectId);
    set.subjectId = new Types.ObjectId(set.subjectId);
  }

  /* An approved question is stock the cell has signed off. Changing
     its subject silently would move signed-off stock between papers,
     so it goes back to draft and must be approved again — the same
     rule the single edit applies. */
  const mayApprove = req.actor.permissions.has('question:approve');
  const approved = found.filter((q) => q.status === 'approved');
  if (approved.length && !mayApprove) {
    throw forbidden(`${approved.length} of those are approved. Only the examination cell can change them.`);
  }

  const update = { $set: set };
  if (set.subjectId) {
    update.$set.status = 'draft';
    update.$unset = { reviewedBy: '', reviewedAt: '', reviewNote: '' };
  }

  const r2 = await Question.updateMany(
    { _id: { $in: found.map((q) => q._id) }, ...tenant(req), ...BANK },
    update,
  );

  await audit(req, { action: 'question.bulk_updated', entity: 'Question',
    after: { count: r2.modifiedCount, ...body, ids: undefined } });

  res.json({
    updated: r2.modifiedCount,
    movedSubject: Boolean(set.subjectId),
    /* Said plainly, because someone who moves approved questions and
       then cannot find them under "Approved" will think they were
       lost. */
    returnedToDraft: set.subjectId ? approved.length : 0,
  });
}));

r.post('/delete-many', can('question:delete'), wrap(async (req, res) => {
  const { ids } = parse(z.object({
    ids: z.array(z.string()).min(1, 'Choose at least one question'),
  }), req.body);

  const found = await loadForBulk(req, ids);

  /* A question already drawn into a paper is part of the record. The
     paper holds its own copy, so deleting the source would not alter
     a sat paper — but it would break the thread back, and the bank is
     where "has this been used" is answered. Retiring keeps both. */
  const used = found.filter((q) => (q.usedCount || 0) > 0);
  const deletable = found.filter((q) => !(q.usedCount || 0));

  if (!deletable.length) {
    throw badRequest(`All ${used.length} of those have been used in a paper. Retire them instead.`);
  }

  const r2 = await Question.deleteMany({
    _id: { $in: deletable.map((q) => q._id) }, ...tenant(req), ...BANK,
  });

  await audit(req, { action: 'question.bulk_deleted', entity: 'Question',
    after: { deleted: r2.deletedCount, keptBecauseUsed: used.length } });

  res.json({
    deleted: r2.deletedCount,
    keptBecauseUsed: used.length,
  });
}));

r.patch('/:id', can('question:edit'), wrap(async (req, res) => {
  const q = await Question.findOne({ _id: req.params.id, ...tenant(req), ...BANK });
  if (!q) throw notFound('Question not found in the bank');
  await assertSubjectInScope(req, q.subjectId);

  /* An approved question is part of the stock the cell has signed off.
     The author reopens it by withdrawing it; an approver may edit in
     place. */
  const mayApprove = req.actor.permissions.has('question:approve');
  if (q.status === 'approved' && !mayApprove) {
    throw forbidden('This question is approved. Withdraw it first to make changes.');
  }

  const body = parse(questionBody.partial(), req.body);
  Object.assign(q, body);
  validateShape(q);

  /* An edited question goes back for review — otherwise approval
     means nothing. */
  if (q.status === 'approved' && mayApprove) q.reviewNote = 'Edited after approval';
  if (q.status === 'rejected') q.status = 'draft';
  await q.save();

  await audit(req, { action: 'question.updated', entity: 'Question', entityId: q._id, after: body });
  res.json({ question: shape(q.toObject()) });
}));

r.delete('/:id', can('question:delete'), wrap(async (req, res) => {
  const q = await Question.findOne({ _id: req.params.id, ...tenant(req), ...BANK });
  if (!q) throw notFound('Question not found in the bank');
  await assertSubjectInScope(req, q.subjectId);

  if (q.usedCount > 0) {
    throw badRequest(
      `This question has been used in ${q.usedCount} paper(s) and is part of the record. Retire it instead.`,
    );
  }
  await q.deleteOne();
  await audit(req, { action: 'question.deleted', entity: 'Question', entityId: q._id });
  res.json({ ok: true });
}));

/* ============================================================
   THE REVIEW TRAIL
   ============================================================ */
r.post('/:id/submit', can('question:create', 'question:edit'), wrap(async (req, res) => {
  const q = await Question.findOne({ _id: req.params.id, ...tenant(req), ...BANK });
  if (!q) throw notFound('Question not found in the bank');
  await assertSubjectInScope(req, q.subjectId);
  if (!['draft', 'rejected'].includes(q.status)) {
    throw badRequest(`This question is ${q.status.replace('_', ' ')} and cannot be submitted again`);
  }
  validateShape(q);
  q.status = 'pending_review';
  q.submittedAt = new Date();
  await q.save();
  await audit(req, { action: 'question.submitted', entity: 'Question', entityId: q._id });
  res.json({ question: shape(q.toObject()) });
}));

/* Several at once — a subject's whole batch of drafts in one action. */
r.post('/submit-many', can('question:create', 'question:edit'), wrap(async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(z.string()).min(1).max(500) }), req.body);
  const scope = await resolveScope(req.actor);
  const filter = { _id: { $in: ids }, ...tenant(req), ...BANK, status: { $in: ['draft', 'rejected'] } };
  if (scope) filter.subjectId = { $in: scope.subjectIds.map((s) => new Types.ObjectId(s)) };

  const out = await Question.updateMany(filter, {
    $set: { status: 'pending_review', submittedAt: new Date() },
  });
  await audit(req, { action: 'question.submitted_many', entity: 'Question', after: { count: out.modifiedCount } });
  res.json({ submitted: out.modifiedCount });
}));

r.post('/:id/review', can('question:approve'), wrap(async (req, res) => {
  const body = parse(z.object({
    decision: z.enum(['approve', 'reject']),
    note: z.string().max(500).optional(),
  }), req.body);

  const q = await Question.findOne({ _id: req.params.id, ...tenant(req), ...BANK });
  if (!q) throw notFound('Question not found in the bank');
  if (body.decision === 'reject' && !body.note) {
    throw badRequest('Say why it was rejected, so the author can correct it');
  }

  q.status = body.decision === 'approve' ? 'approved' : 'rejected';
  q.reviewedBy = req.actor.id;
  q.reviewedAt = new Date();
  q.reviewNote = body.note;
  await q.save();

  await audit(req, { action: `question.${body.decision}d`, entity: 'Question', entityId: q._id,
    after: { note: body.note, selfReview: String(q.createdBy) === req.actor.id } });
  res.json({ question: shape(q.toObject()) });
}));

r.post('/review-many', can('question:approve'), wrap(async (req, res) => {
  const body = parse(z.object({
    ids: z.array(z.string()).min(1).max(500),
    decision: z.enum(['approve', 'reject']),
    note: z.string().max(500).optional(),
  }), req.body);
  if (body.decision === 'reject' && !body.note) {
    throw badRequest('Say why they were rejected, so the authors can correct them');
  }

  const out = await Question.updateMany(
    { _id: { $in: body.ids }, ...tenant(req), ...BANK },
    { $set: {
      status: body.decision === 'approve' ? 'approved' : 'rejected',
      reviewedBy: req.actor.id, reviewedAt: new Date(), reviewNote: body.note,
    } },
  );
  await audit(req, { action: `question.${body.decision}d_many`, entity: 'Question',
    after: { count: out.modifiedCount } });
  res.json({ reviewed: out.modifiedCount });
}));

/* Withdraw an approved question from circulation without destroying
   the papers that used it. */
r.post('/:id/retire', can('question:edit'), wrap(async (req, res) => {
  const q = await Question.findOne({ _id: req.params.id, ...tenant(req), ...BANK });
  if (!q) throw notFound('Question not found in the bank');
  await assertSubjectInScope(req, q.subjectId);
  q.status = q.status === 'retired' ? 'approved' : 'retired';
  await q.save();
  await audit(req, { action: 'question.retired', entity: 'Question', entityId: q._id,
    after: { status: q.status } });
  res.json({ question: shape(q.toObject()) });
}));

/* Where a bank question has been used. */
r.get('/:id/usage', can('question:view'), wrap(async (req, res) => {
  const copies = await Question.find({ sourceId: req.params.id, ...tenant(req) })
    .populate('examId', 'title code date status')
    .select('examId').lean();

  res.json({
    papers: copies.filter((c) => c.examId).map((c) => ({
      id: String(c.examId._id), title: c.examId.title, code: c.examId.code,
      date: c.examId.date, status: c.examId.status,
    })),
  });
}));

function shape(q) {
  return {
    id: String(q._id),
    subject: q.subjectId?._id
      ? { id: String(q.subjectId._id), code: q.subjectId.code, title: q.subjectId.title }
      : { id: String(q.subjectId) },
    section: q.section, type: q.type, text: q.text, marks: q.marks,
    upload: q.uploadId?.label
      ? { id: String(q.uploadId._id), label: q.uploadId.label, at: q.uploadId.createdAt }
      : (q.uploadId ? { id: String(q.uploadId) } : null),
    options: q.options, correctOptions: q.correctOptions, multiSelect: q.multiSelect,
    acceptedAnswers: q.acceptedAnswers, keywords: q.keywords,
    modelAnswer: q.modelAnswer, markingGuidance: q.markingGuidance,
    unit: q.unit, topic: q.topic, difficulty: q.difficulty,
    status: q.status,
    author: q.createdBy?.name ? { id: String(q.createdBy._id), name: q.createdBy.name } : null,
    reviewer: q.reviewedBy?.name ? { id: String(q.reviewedBy._id), name: q.reviewedBy.name } : null,
    reviewedAt: q.reviewedAt, reviewNote: q.reviewNote, submittedAt: q.submittedAt,
    usedCount: q.usedCount || 0, lastUsedAt: q.lastUsedAt,
    updatedAt: q.updatedAt,
  };
}

export default r;
