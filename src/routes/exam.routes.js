import { Router } from 'express';
import { z } from 'zod';
import { Exam, Question, Room, Attempt } from '../models/exam.js';
import { Student, Subject, Batch, Institution, User } from '../models/core.js';
import { authenticate, can, tenant, resolveScope } from '../middleware/auth.js';
import { samplePaper } from '../data/sample-bank.js';
import { audit } from '../middleware/audit.js';
import { wrap, notFound, badRequest, conflict, forbidden } from '../utils/http.js';
import { parse } from '../utils/validate.js';

const r = Router();
r.use(authenticate);

const at = (date, time) => new Date(`${date}T${time}:00`);

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

  res.json({
    exams: exams.map((e) => ({
      id: String(e._id),
      title: e.title, code: e.code, type: e.type,
      subject: e.subjectId ? { id: String(e.subjectId._id), code: e.subjectId.code, title: e.subjectId.title } : null,
      batches: (e.batchIds || []).map((b) => ({ id: String(b._id), label: b.label })),
      date: e.date, startTime: e.startTime, durationMinutes: e.durationMinutes,
      totalMarks: e.totalMarks, passMark: e.passMark,
      status: e.status,
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
  instruction: z.string().optional(),
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
  passMark: z.number().min(0),
  blueprint: z.object({ sections: z.array(sectionSchema).min(1) }),
  proctoring: z.record(z.any()).optional(),
  randomisation: z.record(z.any()).optional(),
  instructions: z.string().optional(),
});

r.post('/', can('exam:create'), wrap(async (req, res) => {
  const body = parse(examSchema, req.body);

  const exam = new Exam({ ...body, ...tenant(req), createdBy: req.actor.id, status: 'draft' });
  const total = exam.blueprintTotal();
  if (total !== body.totalMarks) {
    throw badRequest(
      `The blueprint adds up to ${total} marks but the paper is set to ${body.totalMarks}`,
      { blueprint: 'Adjust the section counts or the total marks so they agree' },
    );
  }
  await exam.save();

  await audit(req, { action: 'exam.created', entity: 'Exam', entityId: exam._id, after: { code: body.code, date: body.date } });
  res.status(201).json({ exam: { ...exam.toObject(), id: String(exam._id) } });
}));

r.patch('/:id', can('exam:edit'), wrap(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.id, ...tenant(req) });
  if (!exam) throw notFound('Examination not found');
  if (['live', 'closed', 'evaluation', 'published'].includes(exam.status)) {
    throw forbidden('This examination has started and can no longer be edited');
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

  const startAt = at(exam.date, exam.startTime);
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
    const clash = await Room.findOne({
      institutionId,
      examId: { $ne: exam._id },
      invigilatorId: room.invigilatorId._id,
      startAt: { $lt: room.endAt },
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
  const startAt = at(exam.date, exam.startTime);

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
  if (!['draft', 'scheduled'].includes(exam.status)) {
    throw badRequest(`A ${exam.status} examination cannot be deleted; attempts exist against it.`);
  }
  const started = await Attempt.countDocuments({ examId: exam._id, status: { $ne: 'not_started' } });
  if (started) throw badRequest(`${started} candidate(s) have already started this paper.`);

  await Promise.all([
    Question.deleteMany({ examId: exam._id }),
    Room.deleteMany({ examId: exam._id }),
    Attempt.deleteMany({ examId: exam._id }),
  ]);
  if (exam.status === 'scheduled') {
    // release the licences the schedule reserved
    const n = await Attempt.countDocuments({ examId: exam._id });
    await Institution.findByIdAndUpdate(req.actor.institutionId, { $inc: { 'licence.reserved': -n } });
  }
  await exam.deleteOne();
  await audit(req, { action: 'exam.deleted', entity: 'Exam', entityId: exam._id, before: { title: exam.title, status: exam.status } });
  res.json({ ok: true });
}));

/* ============================================================
   ANSWER SHEET UPLOAD — typed and uploaded may coexist
   ============================================================ */

export default r;
