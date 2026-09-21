import { Router } from 'express';
import { z } from 'zod';
import { Exam, Question, Room, Attempt } from '../models/exam.js';
import { Institution, Student, User } from '../models/core.js';
import { authenticate, studentOnly, tenant } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { wrap, notFound, badRequest, forbidden, conflict } from '../utils/http.js';
import { parse } from '../utils/validate.js';
import {
  gradeMcq, gradeFib, suggestDescriptive, applyBestN, hasContent,
  SEVERITY_WEIGHT, VIOLATION_CATALOGUE,
} from '../utils/grading.js';
import { storage, evidenceKey, decodeDataUrl, validateUpload } from '../services/storage.js';
import { pushToWatchers } from '../realtime/live.js';

const r = Router();
r.use(authenticate, studentOnly);

const now = () => new Date();

/* ============================================================
   Loads the attempt and refuses anything that is not the signed-in
   candidate's own. Every route below goes through this.
   ============================================================ */
async function loadAttempt(req, { requireActive = false } = {}) {
  const attempt = await Attempt.findOne({
    _id: req.params.id,
    studentId: req.actor.id,
    ...tenant(req),
  });
  if (!attempt) throw notFound('Examination not found');

  const exam = await Exam.findById(attempt.examId);
  if (!exam) throw notFound('Examination not found');

  if (requireActive) {
    if (attempt.status === 'submitted') throw forbidden('You have already submitted this paper');
    if (attempt.status === 'terminated') throw forbidden('This attempt was ended by the invigilator');
    if (attempt.status !== 'in_progress') throw forbidden('This examination has not started');

    // The timer is authoritative on the server. A client with a
    // frozen clock cannot buy itself extra time.
    if (attempt.timerEndsAt && now() > attempt.timerEndsAt) {
      await finalise(attempt, exam, { auto: true });
      throw forbidden('Your time has ended and the paper was submitted automatically');
    }
  }
  return { attempt, exam };
}

/* Strips everything a candidate must not see. This is the single
   most important function in the runtime — the paper travels to the
   browser, so any key left in the payload is readable. */
function sanitiseQuestion(q, exam) {
  const out = {
    id: String(q._id),
    section: q.section,
    type: q.type,
    order: q.order,
    text: q.text,
    marks: q.marks,
  };
  if (q.type === 'mcq') {
    let options = (q.options || []).map((o) => ({ key: o.key, text: o.text }));
    if (exam.randomisation?.shuffleOptions) options = shuffleWithSeed(options, String(q._id));
    out.options = options;
    out.multiSelect = q.multiSelect;
  }
  // correctOptions, acceptedAnswers, keywords, modelAnswer, markingGuidance
  // are deliberately absent.
  return out;
}

/* Deterministic shuffle so a candidate who reloads sees the same
   order they started with. */
function shuffleWithSeed(arr, seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    const j = h % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ============================================================
   MY EXAMINATIONS
   ============================================================ */
r.get('/mine', wrap(async (req, res) => {
  const attempts = await Attempt.find({ studentId: req.actor.id, ...tenant(req) })
    .populate('examId')
    .populate('roomId', 'name startAt endAt')
    .sort({ createdAt: -1 }).lean();

  const institution = await Institution.findById(req.actor.institutionId).lean();
  const windowMin = institution?.settings?.verificationWindowMinutes ?? 15;
  const cutoffMin = institution?.settings?.entryCutoffMinutes ?? 15;

  const items = attempts.filter((a) => a.examId).map((a) => {
    const exam = a.examId;
    const startAt = new Date(`${exam.date}T${exam.startTime}:00`);
    const opensAt = new Date(startAt.getTime() - windowMin * 60000);
    const closesAt = new Date(startAt.getTime() + cutoffMin * 60000);
    const t = now();

    let phase = 'upcoming';
    if (a.status === 'submitted' || a.status === 'terminated') phase = 'done';
    else if (a.status === 'in_progress') phase = 'resume';
    else if (t >= opensAt && t <= closesAt) phase = 'open';
    else if (t > closesAt) phase = 'missed';

    return {
      attemptId: String(a._id),
      status: a.status,
      phase,
      exam: {
        id: String(exam._id),
        title: exam.title, code: exam.code,
        date: exam.date, startTime: exam.startTime,
        durationMinutes: exam.durationMinutes,
        totalMarks: exam.totalMarks,
      },
      room: a.roomId ? { name: a.roomId.name } : null,
      opensAt, startAt, closesAt,
      result: a.resultPublishedAt ? {
        total: a.marks?.total ?? 0,
        outOf: exam.totalMarks,
        passed: Boolean(a.marks?.passed),
      } : null,
    };
  });

  res.json({
    student: { name: req.actor.name, regNo: req.actor.regNo },
    attempts: items,
  });
}));

/* ============================================================
   JOIN — environment and platform gate
   ============================================================ */
const joinSchema = z.object({
  platform: z.string().min(1),
  browser: z.string().optional(),
  screen: z.string().optional(),
  displays: z.number().int().optional(),
  virtualMachine: z.boolean().optional(),
  bandwidthMbps: z.number().optional(),
  location: z.object({ lat: z.number(), lng: z.number() }).nullable().optional(),
});

r.post('/:id/join', wrap(async (req, res) => {
  const { attempt, exam } = await loadAttempt(req);
  const body = parse(joinSchema, req.body);

  if (['submitted', 'terminated'].includes(attempt.status)) {
    throw forbidden('This attempt is closed');
  }

  const allowed = exam.proctoring?.allowedPlatforms?.length
    ? exam.proctoring.allowedPlatforms
    : ['windows'];

  const platform = body.platform.toLowerCase();
  const permitted = allowed.some((p) => platform.includes(p.toLowerCase()));

  attempt.environment = {
    platform: body.platform,
    browser: body.browser,
    screen: body.screen,
    displays: body.displays,
    virtualMachine: body.virtualMachine,
    ip: req.ip,
    location: body.location || undefined,
  };

  if (!permitted) {
    // Recorded as a violation even though entry is refused, so the
    // examination cell can see the attempt was made.
    attempt.violations.push({
      type: 'platform_violation', severity: 'critical', weight: 0,
      note: `Attempted from ${body.platform}; permitted: ${allowed.join(', ')}`,
    });
    await attempt.save();
    throw forbidden(
      `This examination may only be taken on ${allowed.join(' or ')}. You are on ${body.platform}. Raise a support ticket if this is wrong.`,
    );
  }

  if (attempt.status === 'not_started') attempt.status = 'verifying';
  attempt.joinedAt = attempt.joinedAt || now();
  await attempt.save();

  const startAt = new Date(`${exam.date}T${exam.startTime}:00`);

  res.json({
    ok: true,
    attempt: {
      id: String(attempt._id),
      status: attempt.status,
      identityVerified: Boolean(attempt.identity?.verifiedAt),
    },
    exam: {
      title: exam.title, code: exam.code,
      durationMinutes: exam.durationMinutes,
      totalMarks: exam.totalMarks,
      instructions: exam.instructions,
      startAt,
      blueprint: exam.blueprint,
      proctoring: {
        faceTracking: exam.proctoring.faceTracking,
        audioMonitoring: exam.proctoring.audioMonitoring,
        browserLock: exam.proctoring.browserLock,
        mobileScan: exam.proctoring.mobileScan,
        freehandCanvas: exam.proctoring.freehandCanvas,
        captureIntervalSeconds: exam.proctoring.captureIntervalSeconds,
        flagCeiling: exam.proctoring.flagCeiling,
        lookAwaySeconds: exam.proctoring.lookAwaySeconds,
      },
    },
  });
}));

/* ============================================================
   IDENTITY — live face + ID card
   ============================================================ */
r.post('/:id/identity', wrap(async (req, res) => {
  const { attempt } = await loadAttempt(req);
  const body = parse(z.object({
    face: z.string().min(32),
    idCard: z.string().min(32),
  }), req.body);

  const saved = {};
  for (const [field, kind] of [['face', 'face'], ['idCard', 'id_card']]) {
    const decoded = decodeDataUrl(body[field]);
    if (!decoded) throw badRequest(`${field} must be a base64 image`);

    const err = validateUpload(kind, decoded.mime, decoded.buffer.length);
    if (err) throw badRequest(err);

    const key = evidenceKey({
      institutionId: req.actor.institutionId,
      examId: attempt.examId, attemptId: attempt._id,
      kind, ext: decoded.mime.split('/')[1],
    });
    await storage.put(key, decoded.buffer, decoded.mime);
    saved[field] = key;
  }

  attempt.identity = {
    faceKey: saved.face,
    idCardKey: saved.idCard,
    verifiedAt: now(),
  };
  await attempt.save();

  res.json({ ok: true, verifiedAt: attempt.identity.verifiedAt });
}));

/* ============================================================
   START — releases the paper and fixes the timer
   ============================================================ */
r.post('/:id/start', wrap(async (req, res) => {
  const { attempt, exam } = await loadAttempt(req);

  if (attempt.status === 'submitted') throw forbidden('You have already submitted this paper');
  if (attempt.status === 'terminated') throw forbidden('This attempt was ended by the invigilator');

  if (!attempt.identity?.verifiedAt && exam.proctoring?.idVerification) {
    throw badRequest('Complete the identity check before starting');
  }

  const institution = await Institution.findById(req.actor.institutionId).lean();
  const startAt = new Date(`${exam.date}T${exam.startTime}:00`);
  const cutoff = new Date(startAt.getTime() + (institution?.settings?.entryCutoffMinutes ?? 15) * 60000);
  const t = now();

  if (t < startAt) {
    throw badRequest(`This examination begins at ${exam.startTime}. The paper is sealed until then.`);
  }

  if (attempt.status !== 'in_progress') {
    if (t > cutoff) {
      throw forbidden('The entry window has closed. Ask your invigilator for approval to join late.');
    }

    /* Duration runs from actual join, but is hard-stopped at room
       close so a late candidate cannot keep a room open indefinitely. */
    const room = await Room.findById(attempt.roomId).lean();
    const buffer = institution?.settings?.roomCloseBufferMinutes ?? 45;
    const roomClose = room
      ? new Date(new Date(room.endAt).getTime() + buffer * 60000)
      : new Date(startAt.getTime() + (exam.durationMinutes + buffer) * 60000);
    const personal = new Date(t.getTime() + exam.durationMinutes * 60000);

    attempt.status = 'in_progress';
    attempt.startedAt = t;
    attempt.timerEndsAt = personal < roomClose ? personal : roomClose;
    attempt.sectionState = { current: 'A', lockedSections: [], gatePassedAt: undefined };

    if (!attempt.licenceConsumed) {
      attempt.licenceConsumed = true;
      await Institution.findByIdAndUpdate(req.actor.institutionId, {
        $inc: { 'licence.consumed': 1, 'licence.reserved': -1, 'licence.balance': -1 },
      });
    }
    await attempt.save();
  }

  const questions = await Question.find({
    examId: exam._id,
    $or: [{ setLabel: attempt.setLabel }, { setLabel: { $exists: false } }],
  }).sort({ section: 1, order: 1 }).lean();

  const sections = exam.blueprint.sections.map((s) => {
    let qs = questions.filter((q) => q.section === s.key);
    if (exam.randomisation?.shuffleQuestions) qs = shuffleWithSeed(qs, String(attempt._id) + s.key);
    return {
      key: s.key, title: s.title, type: s.type,
      marksEach: s.marksEach, answerCount: s.answerCount,
      instruction: s.instruction,
      questions: qs.map((q) => sanitiseQuestion(q, exam)),
    };
  });

  res.json({
    attempt: {
      id: String(attempt._id),
      status: attempt.status,
      startedAt: attempt.startedAt,
      timerEndsAt: attempt.timerEndsAt,
      serverTime: now(),
      flagScore: attempt.flagScore,
      lockedSections: attempt.sectionState.lockedSections,
      answers: attempt.answers.map((a) => ({
        questionId: String(a.questionId),
        selected: a.selected, text: a.text, html: a.html,
        mode: a.mode,
        scanPages: (a.scanPages || []).length,
        markedForReview: a.markedForReview,
      })),
    },
    exam: {
      title: exam.title, code: exam.code,
      totalMarks: exam.totalMarks,
      durationMinutes: exam.durationMinutes,
      proctoring: exam.proctoring,
    },
    sections,
  });
}));

/* ============================================================
   SAVE ANSWER — idempotent per question
   ============================================================ */
r.patch('/:id/answers/:questionId', wrap(async (req, res) => {
  const { attempt, exam } = await loadAttempt(req, { requireActive: true });

  const question = await Question.findOne({ _id: req.params.questionId, examId: exam._id }).lean();
  if (!question) throw notFound('Question not found');

  // A locked section cannot be written to, whatever the client sends.
  if (attempt.sectionState.lockedSections.includes(question.section)) {
    throw forbidden(`Part ${question.section} is closed and cannot be changed`);
  }

  const body = parse(z.object({
    selected: z.array(z.string()).optional(),
    text: z.string().max(20000).optional(),
    html: z.string().max(200000).optional(),
    mode: z.enum(['typed', 'scanned', 'mixed']).optional(),
    markedForReview: z.boolean().optional(),
  }), req.body);

  let answer = attempt.answers.find((a) => String(a.questionId) === String(question._id));
  if (!answer) {
    answer = { questionId: question._id, section: question.section };
    attempt.answers.push(answer);
    answer = attempt.answers[attempt.answers.length - 1];
  }

  if (body.selected !== undefined) {
    const keys = (question.options || []).map((o) => o.key);
    const bad = body.selected.filter((k) => !keys.includes(k));
    if (bad.length) throw badRequest('That option does not exist on this question');
    if (!question.multiSelect && body.selected.length > 1) {
      throw badRequest('This question takes a single answer');
    }
    answer.selected = body.selected;
  }
  if (body.text !== undefined) answer.text = body.text;
  if (body.html !== undefined) answer.html = body.html;
  if (body.mode !== undefined) answer.mode = body.mode;
  if (body.markedForReview !== undefined) answer.markedForReview = body.markedForReview;
  answer.answeredAt = now();

  await attempt.save();

  res.json({
    ok: true,
    savedAt: answer.answeredAt,
    answered: hasContent(answer),
    timeRemainingMs: attempt.timerEndsAt - now(),
  });
}));

/* ============================================================
   SECTION GATE — one way, irreversible
   ============================================================ */
r.post('/:id/gate', wrap(async (req, res) => {
  const { attempt, exam } = await loadAttempt(req, { requireActive: true });
  const { target } = parse(z.object({ target: z.enum(['A', 'B', 'C']) }), req.body);

  if (attempt.sectionState.lockedSections.includes(target)) {
    throw forbidden(`Part ${target} is closed`);
  }

  // Entering the descriptive part closes the objective parts for good.
  const descKey = exam.blueprint.sections.find((s) => s.type === 'desc')?.key;
  if (target === descKey) {
    const toLock = exam.blueprint.sections
      .filter((s) => s.type !== 'desc')
      .map((s) => s.key);
    attempt.sectionState.lockedSections = [...new Set([...attempt.sectionState.lockedSections, ...toLock])];
    attempt.sectionState.gatePassedAt = now();
  }

  attempt.sectionState.current = target;
  await attempt.save();

  res.json({
    ok: true,
    current: target,
    lockedSections: attempt.sectionState.lockedSections,
  });
}));

/* ============================================================
   VIOLATIONS
   Severity comes from the server catalogue, never from the client.
   ============================================================ */
r.post('/:id/violations', wrap(async (req, res) => {
  const { attempt, exam } = await loadAttempt(req, { requireActive: true });
  const body = parse(z.object({
    type: z.string().min(2),
    note: z.string().max(500).optional(),
    cameraFrame: z.string().optional(),
    screenFrame: z.string().optional(),
  }), req.body);

  const spec = VIOLATION_CATALOGUE[body.type];
  if (!spec) throw badRequest(`Unknown violation type "${body.type}"`);

  const weight = SEVERITY_WEIGHT[spec.severity] ?? 1;

  const keys = {};
  for (const [field, kind] of [['cameraFrame', 'frame'], ['screenFrame', 'screen']]) {
    if (!body[field]) continue;
    const decoded = decodeDataUrl(body[field]);
    if (!decoded) continue;
    if (validateUpload(kind, decoded.mime, decoded.buffer.length)) continue;
    const key = evidenceKey({
      institutionId: req.actor.institutionId,
      examId: attempt.examId, attemptId: attempt._id,
      kind, ext: decoded.mime.split('/')[1],
    });
    await storage.put(key, decoded.buffer, decoded.mime);
    keys[field === 'cameraFrame' ? 'cameraKey' : 'screenKey'] = key;
  }

  attempt.violations.push({
    type: body.type,
    severity: spec.severity,
    weight,
    at: now(),
    note: body.note,
    ...keys,
  });
  attempt.flagScore = (attempt.flagScore || 0) + weight;

  const ceiling = exam.proctoring?.flagCeiling ?? 3;
  let terminated = false;

  /* Institution-wide switch wins over the per-paper setting, so an
     evaluation deployment can record everything without ending
     attempts while it is being tested. */
  const institution = await Institution.findById(req.actor.institutionId).select('settings').lean();
  const enforcing = institution?.settings?.enforcementMode === 'terminate';

  if (enforcing && exam.proctoring?.terminateOnCeiling && attempt.flagScore >= ceiling) {
    attempt.status = 'terminated';
    attempt.terminationReason = `Flag score ${attempt.flagScore} reached the limit of ${ceiling}`;
    attempt.submittedAt = now();
    await gradeObjective(attempt, exam);
    terminated = true;
  }

  await attempt.save();

  res.json({
    ok: true,
    label: spec.label,
    severity: spec.severity,
    flagScore: attempt.flagScore,
    ceiling,
    remaining: Math.max(0, ceiling - attempt.flagScore),
    terminated,
    enforcing,
  });
}));

/* ============================================================
   INTERVAL EVIDENCE
   ============================================================ */
r.post('/:id/evidence', wrap(async (req, res) => {
  const { attempt } = await loadAttempt(req, { requireActive: true });
  const body = parse(z.object({
    cameraFrame: z.string().optional(),
    screenFrame: z.string().optional(),
  }), req.body);

  let stored = 0;
  for (const [field, kind] of [['cameraFrame', 'frame'], ['screenFrame', 'screen']]) {
    if (!body[field]) continue;
    const decoded = decodeDataUrl(body[field]);
    if (!decoded) continue;
    if (validateUpload(kind, decoded.mime, decoded.buffer.length)) continue;
    const key = evidenceKey({
      institutionId: req.actor.institutionId,
      examId: attempt.examId, attemptId: attempt._id,
      kind, ext: decoded.mime.split('/')[1],
    });
    await storage.put(key, decoded.buffer, decoded.mime);
    const at = now();

    /* A capture taken close to a violation is marked, so a reviewer
       sees the moment rather than scrolling for it. */
    const near = (attempt.violations || []).find(
      (v) => Math.abs(new Date(v.at) - at) < 15000);

    attempt.captures.push({
      key, at, kind,
      flagged: Boolean(near),
      violationType: near?.type,
    });

    // keep the timeline bounded; flagged captures are never dropped
    if (attempt.captures.length > 800) {
      const flagged = attempt.captures.filter((c) => c.flagged);
      const recent = attempt.captures.slice(-600);
      const seen = new Set(recent.map((c) => c.key));
      attempt.captures = [...flagged.filter((c) => !seen.has(c.key)), ...recent];
    }

    if (kind === 'frame') attempt.latestFrame = { key, at };
    stored++;
  }

  attempt.lastSeenAt = now();

  /* Messages from the invigilator ride back on the evidence
     heartbeat, so the candidate needs no separate poll. */
  const unread = attempt.chat.filter((c) => c.from === 'invigilator' && !c.readByStudent);
  unread.forEach((c) => { c.readByStudent = true; });

  const pendingWarning = attempt.warnings.find((w) => !w.acknowledgedAt);

  await attempt.save();

  res.json({
    ok: true, stored,
    timeRemainingMs: attempt.timerEndsAt - now(),
    messages: unread.map((c) => ({ body: c.body, at: c.at })),
    warning: pendingWarning ? { body: pendingWarning.body, by: pendingWarning.byName } : null,
    micGranted: attempt.micGrantedUntil && attempt.micGrantedUntil > now(),
    terminated: attempt.status === 'terminated',
    terminationReason: attempt.terminationReason,
  });
}));

/* ============================================================
   CHAT + WARNING ACKNOWLEDGEMENT
   ============================================================ */
r.post('/:id/chat', wrap(async (req, res) => {
  const { attempt } = await loadAttempt(req, { requireActive: true });
  const { body } = parse(z.object({ body: z.string().min(1).max(600) }), req.body);

  const at = now();
  attempt.chat.push({ from: 'student', body, at, readByStudent: true });
  await attempt.save();

  pushToWatchers(attempt._id, {
    type: 'chat', attemptId: String(attempt._id), from: 'student', body, at,
  });
  res.json({ ok: true });
}));

r.get('/:id/chat', wrap(async (req, res) => {
  const { attempt } = await loadAttempt(req);
  res.json({
    chat: attempt.chat.map((c) => ({ from: c.from, body: c.body, at: c.at })),
    micGranted: Boolean(attempt.micGrantedUntil && attempt.micGrantedUntil > now()),
  });
}));

r.post('/:id/acknowledge-warning', wrap(async (req, res) => {
  const { attempt } = await loadAttempt(req, { requireActive: true });
  const pending = attempt.warnings.find((w) => !w.acknowledgedAt);
  if (pending) { pending.acknowledgedAt = now(); await attempt.save(); }
  res.json({ ok: true });
}));

/* ============================================================
   SCAN WINDOW
   Look-away tolerance is relaxed while this is open, because
   looking down at paper is the expected behaviour.
   ============================================================ */
r.post('/:id/scan-window', wrap(async (req, res) => {
  const { attempt, exam } = await loadAttempt(req, { requireActive: true });
  const { action, questionId } = parse(z.object({
    action: z.enum(['open', 'close']),
    questionId: z.string(),
  }), req.body);

  if (!exam.proctoring?.mobileScan) throw forbidden('The scan pathway is not enabled for this paper');

  if (action === 'open') {
    const open = attempt.scanWindows.find((w) => !w.closedAt);
    if (open) throw conflict('A scan window is already open');
    attempt.scanWindows.push({ questionId, openedAt: now(), pages: 0 });
  } else {
    const open = attempt.scanWindows.find((w) => !w.closedAt);
    if (open) open.closedAt = now();
  }
  await attempt.save();

  res.json({
    ok: true,
    scanWindowOpen: action === 'open',
    windows: attempt.scanWindows.length,
  });
}));

/* Pages arrive here from the mobile app, or from the browser in
   this build until the app ships. */
r.post('/:id/scan-pages/:questionId', wrap(async (req, res) => {
  const { attempt, exam } = await loadAttempt(req, { requireActive: true });
  const { pages } = parse(z.object({
    pages: z.array(z.string().min(32)).min(1).max(12),
  }), req.body);

  const question = await Question.findOne({ _id: req.params.questionId, examId: exam._id }).lean();
  if (!question) throw notFound('Question not found');
  if (question.type !== 'desc') throw badRequest('Only descriptive answers accept a scan');

  const stored = [];
  for (const [i, dataUrl] of pages.entries()) {
    const decoded = decodeDataUrl(dataUrl);
    if (!decoded) throw badRequest(`Page ${i + 1} is not a valid image`);
    const err = validateUpload('scan', decoded.mime, decoded.buffer.length);
    if (err) throw badRequest(`Page ${i + 1}: ${err}`);

    const key = evidenceKey({
      institutionId: req.actor.institutionId,
      examId: attempt.examId, attemptId: attempt._id,
      kind: 'scan', ext: decoded.mime.split('/')[1],
    });
    await storage.put(key, decoded.buffer, decoded.mime);
    stored.push({ key, page: i + 1, uploadedAt: now() });
  }

  let answer = attempt.answers.find((a) => String(a.questionId) === String(question._id));
  if (!answer) {
    attempt.answers.push({ questionId: question._id, section: question.section });
    answer = attempt.answers[attempt.answers.length - 1];
  }
  /* A candidate may type part of an answer and upload a worked page
     for the rest. Both are kept; the evaluator sees both. */
  answer.mode = answer.html || answer.text ? 'mixed' : 'scanned';
  answer.scanPages = [...(answer.scanPages || []), ...stored].slice(-12);
  answer.answeredAt = now();

  const win = attempt.scanWindows.find((w) => !w.closedAt);
  if (win) win.pages = stored.length;

  await attempt.save();
  res.json({ ok: true, pages: stored.length });
}));

/* ============================================================
   SUBMIT
   ============================================================ */
r.post('/:id/submit', wrap(async (req, res) => {
  const { attempt, exam } = await loadAttempt(req);
  if (attempt.status === 'submitted') {
    return res.json({ ok: true, alreadySubmitted: true, submittedAt: attempt.submittedAt });
  }
  if (attempt.status !== 'in_progress') throw forbidden('This examination is not in progress');

  const summary = await finalise(attempt, exam, { auto: false });
  res.json({ ok: true, ...summary });
}));

/* Grades the objective parts, applies best-N to the choice section
   and seals the attempt. Descriptive answers stay pending. */
async function gradeObjective(attempt, exam) {
  const questions = await Question.find({ examId: exam._id }).lean();
  const byId = new Map(questions.map((q) => [String(q._id), q]));

  let a = 0, b = 0;
  let descNeedsEval = false;

  for (const ans of attempt.answers) {
    const q = byId.get(String(ans.questionId));
    if (!q) continue;

    if (q.type === 'mcq') {
      const g = gradeMcq(q, ans);
      ans.autoAwarded = g.awarded; ans.awarded = g.awarded;
      a += g.awarded;
    } else if (q.type === 'fib') {
      const g = gradeFib(q, ans);
      ans.autoAwarded = g.awarded;
      ans.awarded = g.awarded;
      ans.needsReview = g.needsReview && hasContent(ans);
      b += g.awarded;
    } else if (q.type === 'desc') {
      const s = suggestDescriptive(q, ans);
      ans.suggested = s.suggested;
      ans.keywordHits = s.hits;
      if (hasContent(ans)) descNeedsEval = true;
    }
  }

  // best-N across the descriptive section
  const descSection = exam.blueprint.sections.find((s) => s.type === 'desc');
  if (descSection) {
    const descAnswers = attempt.answers.filter((x) => {
      const q = byId.get(String(x.questionId));
      return q?.type === 'desc';
    });
    applyBestN(descAnswers, descSection.answerCount || descAnswers.length);
  }

  attempt.marks.sectionA = Math.round(a * 100) / 100;
  attempt.marks.sectionB = Math.round(b * 100) / 100;
  attempt.marks.sectionC = 0;
  attempt.marks.total = attempt.marks.sectionA + attempt.marks.sectionB;
  attempt.marks.passed = false;   // undecidable until Part C is evaluated

  attempt.evaluation.state = descNeedsEval ? 'pending' : 'submitted';
  return { a, b, descNeedsEval };
}

async function finalise(attempt, exam, { auto }) {
  const counts = await gradeObjective(attempt, exam);
  attempt.status = 'submitted';
  attempt.submittedAt = now();
  attempt.autoSubmitted = auto;
  await attempt.save();

  const answered = attempt.answers.filter(hasContent).length;
  return {
    submittedAt: attempt.submittedAt,
    autoSubmitted: auto,
    answered,
    flagScore: attempt.flagScore,
    awaitingEvaluation: counts.descNeedsEval,
  };
}

/* ============================================================
   RESULT
   ============================================================ */
r.get('/:id/result', wrap(async (req, res) => {
  const { attempt, exam } = await loadAttempt(req);

  if (!attempt.resultPublishedAt) {
    return res.json({
      published: false,
      status: attempt.status,
      submittedAt: attempt.submittedAt,
      exam: { title: exam.title, code: exam.code, date: exam.date },
    });
  }

  const questions = await Question.find({ examId: exam._id }).lean();
  const byId = new Map(questions.map((q) => [String(q._id), q]));

  const sections = exam.blueprint.sections.map((s) => {
    const answers = attempt.answers.filter((a) => {
      const q = byId.get(String(a.questionId));
      return q?.section === s.key;
    });
    const counted = s.type === 'desc' ? answers.filter((a) => a.countedInBestN) : answers;
    const got = counted.reduce((sum, a) => sum + (a.awarded ?? 0), 0);
    const max = s.type === 'desc' ? (s.answerCount || s.count) * s.marksEach : s.count * s.marksEach;

    return {
      key: s.key, title: s.title, max,
      got: Math.round(got * 100) / 100,
      mode: s.type === 'mcq' ? 'Auto graded'
        : s.type === 'fib' ? `Auto matched${answers.some((a) => a.needsReview) ? ', some reviewed' : ''}`
        : 'Evaluated by faculty',
      remarks: counted.map((a) => a.remarks).filter(Boolean),
    };
  });

  res.json({
    published: true,
    exam: {
      title: exam.title, code: exam.code, date: exam.date,
      totalMarks: exam.totalMarks, passMark: exam.passMark,
    },
    scored: attempt.marks.total,
    passed: attempt.marks.passed,
    sections,
    proctoring: {
      flagScore: attempt.flagScore,
      verdict: attempt.flagScore === 0
        ? 'No violations recorded'
        : `${attempt.violations.length} event(s) recorded, flag score ${attempt.flagScore}`,
    },
    publishedAt: attempt.resultPublishedAt,
  });
}));

export default r;
