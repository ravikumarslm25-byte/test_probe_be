import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import QRCode from 'qrcode';
import { Exam, Question, Room, Attempt, UploadPass } from '../models/exam.js';
import { Institution, Student } from '../models/core.js';
import { authenticate, studentOnly, tenant } from '../middleware/auth.js';
import { wrap, notFound, badRequest, forbidden, conflict } from '../utils/http.js';
import { parse } from '../utils/validate.js';
import {
  hasContent, SEVERITY_WEIGHT, VIOLATION_CATALOGUE,
} from '../utils/grading.js';
import { storage, evidenceKey, decodeDataUrl, validateUpload } from '../services/storage.js';
import { pushToWatchers } from '../realtime/live.js';
import { formatInZone } from '../utils/time.js';
import { sittingFor } from '../utils/sitting.js';
import { choiceLabel } from '../utils/choice.js';
import { assertChoiceAllows } from '../services/choiceGuard.js';
import { env } from '../config/env.js';
import { sanitiseAnswerHtml } from '../utils/sanitise.js';
import { finaliseAttempt, gradeObjective } from '../services/finalise.js';

const r = Router();
r.use(authenticate, studentOnly);

const now = () => new Date();

/* Long enough to photograph several pages and upload them over a
   phone connection; short enough that a code photographed off
   someone else's screen is worthless by the time it is used. */
const PASS_MINUTES = 15;

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
      await finaliseAttempt(attempt, exam, { auto: true });
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
    choiceGroup: q.choiceGroup,
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
/* ============================================================
   WHO THE CANDIDATE IS

   The portal shows them their own record — the one the examination
   cell holds, and the one printed on their hall ticket. A candidate
   who finds their department or class wrong here can raise it before
   the examination rather than at the door.

   Read-only on purpose. A candidate correcting their own register
   number is not a feature.
   ============================================================ */
r.get('/me/profile', wrap(async (req, res) => {
  const me = await Student.findById(req.actor.id)
    .populate('batchId', 'label year section programme')
    .populate('departmentId', 'name code')
    .lean();
  if (!me) throw notFound('Your record could not be found');

  const sat = await Attempt.countDocuments({
    studentId: me._id, status: { $in: ['submitted', 'terminated'] },
  });
  const published = await Attempt.countDocuments({
    studentId: me._id, resultPublishedAt: { $ne: null },
  });

  res.json({
    student: {
      name: me.name,
      regNo: me.regNo,
      email: me.email,
      mobile: me.mobile || null,
      status: me.status,
      department: me.departmentId ? { name: me.departmentId.name, code: me.departmentId.code } : null,
      batch: me.batchId ? {
        label: me.batchId.label, year: me.batchId.year,
        section: me.batchId.section, programme: me.batchId.programme,
      } : null,
      joinedAt: me.createdAt,
    },
    counts: { sat, published },
  });
}));

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
    /* This candidate's own window, which for almost everyone is the
       examination's — and for a candidate given a sitting of their
       own is not. Reading the examination's start here would show
       them "missed" hours before their arranged time. */
    const sitting = sittingFor(a, exam);
    const startAt = sitting.startAt;
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
      sitting: sitting.isAlternate
        ? { startAt: sitting.startAt, endsAt: sitting.endsAt,
            durationMinutes: sitting.durationMinutes, reason: sitting.reason }
        : null,
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

  const sitting = sittingFor(attempt, exam);
  const startAt = sitting.startAt;

  res.json({
    ok: true,
    attempt: {
      id: String(attempt._id),
      status: attempt.status,
      identityVerified: Boolean(attempt.identity?.verifiedAt),
      sitting: sitting.isAlternate
        ? { startAt: sitting.startAt, endsAt: sitting.endsAt,
            durationMinutes: sitting.durationMinutes, reason: sitting.reason }
        : null,
    },
    exam: {
      title: exam.title, code: exam.code,
      durationMinutes: sitting.durationMinutes,
      totalMarks: exam.totalMarks,
      instructions: exam.instructions,
      startAt,
      blueprint: exam.blueprint,
      proctoring: {
        /* The candidate's screen has to know whether this paper wants
           an identity capture, not merely whether one has happened.
           Left out, every paper demanded it however the examination
           cell had set the paper up. */
        idVerification: exam.proctoring.idVerification !== false,
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

  /* The two photographs may arrive together or one at a time. Sending
     them separately halves the size of each request, which matters
     because anything between the candidate and this service can
     refuse a body without ever reaching us — and when it does, the
     browser reports it as a permissions problem and says nothing
     useful. One photograph per request keeps each one small. */
  const body = parse(z.object({
    face: z.string().min(32).optional(),
    idCard: z.string().min(32).optional(),
  }).refine((b) => b.face || b.idCard, 'Send at least one photograph'), req.body);

  const identity = { ...(attempt.identity ? attempt.identity.toObject?.() ?? attempt.identity : {}) };

  for (const [field, kind] of [['face', 'face'], ['idCard', 'id_card']]) {
    if (!body[field]) continue;

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
    identity[field === 'face' ? 'faceKey' : 'idCardKey'] = key;
  }

  /* Verified only once both are held, however they arrived. */
  const complete = Boolean(identity.faceKey && identity.idCardKey);
  identity.verifiedAt = complete ? (identity.verifiedAt || now()) : undefined;

  attempt.identity = identity;
  await attempt.save();

  res.json({
    ok: true,
    have: { face: Boolean(identity.faceKey), idCard: Boolean(identity.idCardKey) },
    complete,
    verifiedAt: identity.verifiedAt,
  });
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
  const sitting = sittingFor(attempt, exam);
  const startAt = sitting.startAt;
  const cutoff = new Date(startAt.getTime() + (institution?.settings?.entryCutoffMinutes ?? 15) * 60000);
  const t = now();

  if (t < startAt) {
    const zone = exam.timezone || institution?.settings?.timezone;
    throw badRequest(sitting.isAlternate
      ? `Your sitting begins at ${formatInZone(startAt, zone)}. The paper is sealed until then.`
      : `This examination begins at ${exam.startTime}. The paper is sealed until then.`);
  }

  if (attempt.status !== 'in_progress') {
    if (t > cutoff) {
      throw forbidden('The entry window has closed. Ask your invigilator for approval to join late.');
    }

    /* Duration runs from actual join, but is hard-stopped at room
       close so a late candidate cannot keep a room open indefinitely. */
    const buffer = institution?.settings?.roomCloseBufferMinutes ?? 45;

    /* The room's own window does not bound a candidate sitting in a
       window of their own — the hall emptied hours ago. Their hard
       stop is the end of THEIR sitting. */
    let roomClose;
    if (sitting.isAlternate) {
      roomClose = new Date(sitting.endsAt.getTime() + buffer * 60000);
    } else {
      const room = await Room.findById(attempt.roomId).lean();
      roomClose = room
        ? new Date(new Date(room.endAt).getTime() + buffer * 60000)
        : new Date(startAt.getTime() + (exam.durationMinutes + buffer) * 60000);
    }
    const personal = new Date(t.getTime() + sitting.durationMinutes * 60000);

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
      choiceMode: s.choiceMode || 'best_n',
      choiceLabel: s.type === 'desc' ? choiceLabel(s, qs) : null,
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
        /* Cleaned on the way back out as well, because this is set
           straight into the editor's innerHTML and rows written
           before the sanitiser existed are still stored. */
        selected: a.selected, text: a.text, html: sanitiseAnswerHtml(a.html),
        mode: a.mode,
        scanPages: (a.scanPages || []).length,
        markedForReview: a.markedForReview,
      })),
    },
    exam: {
      title: exam.title, code: exam.code,
      totalMarks: exam.totalMarks,
      /* The sitting's duration, which is what the clock actually runs
         on. Reporting the paper's would tell a candidate on a
         shortened sitting they had longer than they do. */
      durationMinutes: sitting.durationMinutes,
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
  const wasAnswered = hasContent(answer);
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
  /* Reduced to the markup the editor can produce, on the way in. The
     evaluator's viewer renders this as HTML, so an answer is a way to
     run script in a member of staff's session unless it is cleaned —
     and the editor can be bypassed with one request from the
     candidate's own console. */
  if (body.html !== undefined) answer.html = sanitiseAnswerHtml(body.html);
  if (body.mode !== undefined) answer.mode = body.mode;
  if (body.markedForReview !== undefined) answer.markedForReview = body.markedForReview;
  answer.answeredAt = now();

  await assertChoiceAllows(attempt, exam, question, {
    wasAnswered, willBeAnswered: hasContent(answer),
  });

  /* Forces the version into the update's filter, so two answers
     written in the same instant cannot both win. Without it, the two
     halves of an either/or pair could each be saved by a request that
     had not seen the other — and the rule then stops enforcing that
     pair at all, because neither answer can be identified as the
     one that came first. */
  attempt.increment();
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

  /* Checked BEFORE a single byte is stored. Below the store loop it
     was checked after as many as twelve files had been written, which
     left them orphaned in storage attached to nothing — and the
     comment there claimed the opposite. */
  await assertChoiceAllows(attempt, exam, question, {
    wasAnswered: hasContent(attempt.answers.find(
      (a) => String(a.questionId) === String(question._id),
    )),
    willBeAnswered: true,
  });

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
    /* `page` is assigned below, continuing from what the answer
       already holds — not from this batch's own index, which would
       collide with pages already attached. */
    stored.push({ key, mime: decoded.mime, bytes: decoded.buffer.length, uploadedAt: now() });
  }

  let answer = attempt.answers.find((a) => String(a.questionId) === String(question._id));
  if (!answer) {
    attempt.answers.push({ questionId: question._id, section: question.section });
    answer = attempt.answers[attempt.answers.length - 1];
  }
  /* A candidate may type part of an answer and upload a worked page
     for the rest. Both are kept; the evaluator sees both. */
  answer.mode = answer.html || answer.text ? 'mixed' : 'scanned';
  /* Refused at the cap rather than trimmed. `.slice(-12)` dropped the
     earliest page once a candidate sent a thirteenth, so the file
     stayed in storage while the answer stopped pointing at it and
     nobody was told. Page numbers continue from the highest already
     there, so two pages cannot share one number. */
  const held = answer.scanPages || [];
  if (held.length + stored.length > 12) {
    throw badRequest(`This answer holds ${held.length} page(s); 12 is the most one answer can carry.`);
  }
  let next = held.reduce((max, p) => Math.max(max, p.page || 0), 0);
  answer.scanPages = [...held, ...stored.map((s) => ({ ...s, page: ++next }))];
  answer.answeredAt = now();

  const win = attempt.scanWindows.find((w) => !w.closedAt);
  if (win) win.pages = stored.length;

  await attempt.save();
  res.json({ ok: true, pages: stored.length, answerPages: answer.scanPages.length });
}));

/* Taking the pages off again.

   An answer is EITHER typed OR handwritten — the client's rule, and a
   sound one: an evaluator opening a script should not have to work
   out whether the typed paragraph or the photographed page is the
   real answer, or mark both. So the examination screen locks the
   editor once pages are attached, and this is the way back out of
   that: remove the pages, and the editor is editable again.

   The files themselves are left in storage. They are evidence that
   the candidate uploaded something during the examination, and a
   deletion a candidate can trigger is not evidence anyone should be
   able to destroy. The answer simply stops pointing at them. */
r.delete('/:id/scan-pages/:questionId', wrap(async (req, res) => {
  const { attempt, exam } = await loadAttempt(req, { requireActive: true });

  /* A closed section is closed for this too. Without the check, the
     one route that can take an answer apart was the one route that
     did not ask whether the section was still open. */
  const question = await Question.findOne({ _id: req.params.questionId, examId: exam._id }).lean();
  if (!question) throw notFound('Question not found');
  if (attempt.sectionState.lockedSections.includes(question.section)) {
    throw forbidden('That part of the paper is closed');
  }

  const answer = attempt.answers.find((a) => String(a.questionId) === String(req.params.questionId));
  if (!answer || !(answer.scanPages || []).length) {
    throw badRequest('There are no pages attached to this answer');
  }

  const removed = answer.scanPages.length;
  answer.removedScanPages = [...(answer.removedScanPages || []), ...answer.scanPages];
  answer.scanPages = [];
  answer.mode = 'typed';
  await attempt.save();

  res.json({ ok: true, removed });
}));

/* ============================================================
   UPLOADING AN ANSWER FROM THE CANDIDATE'S OWN PHONE

   Writing a long answer with a mouse is not writing. The candidate
   works on paper, then uploads it — and the upload must not happen on
   the examination machine, because leaving the examination tab to
   find a file is exactly the behaviour the proctoring is there to
   stop.

   So the examination page shows a QR code. The phone opens the
   address inside it, uploads there, and the examination page is told
   over its own live socket. The candidate never leaves the paper.
   ============================================================ */
/* How many pages the ANSWER holds, which is not how many this pass
   delivered. A candidate who sends three pages, closes the dialog and
   opens it again gets a fresh pass carrying none — and the
   examination page, told only about the pass, would conclude the
   answer had no pages and quietly mark the question unanswered
   again. Every reply that the page uses to update itself carries the
   answer's own count. */
function answerPageCount(attempt, questionId) {
  const a = (attempt.answers || []).find((x) => String(x.questionId) === String(questionId));
  return (a?.scanPages || []).length;
}

r.post('/:id/upload-pass', wrap(async (req, res) => {
  const { attempt, exam } = await loadAttempt(req, { requireActive: true });
  const { questionId } = parse(z.object({ questionId: z.string() }), req.body);

  const question = await Question.findOne({ _id: questionId, examId: exam._id }).lean();
  if (!question) throw notFound('Question not found');
  if (question.type !== 'desc') throw badRequest('Only descriptive answers accept an upload');

  if (!exam.proctoring?.mobileScan) {
    throw forbidden('This paper must be answered on screen; uploading is not enabled for it');
  }

  /* Refused before the code is drawn, rather than after the candidate
     has photographed four pages on their phone. */
  const held = attempt.answers.find((a) => String(a.questionId) === String(question._id));
  await assertChoiceAllows(attempt, exam, question, {
    wasAnswered: hasContent(held), willBeAnswered: true,
  });

  /* A pass already open for this question is handed back rather than
     reissued, so a candidate who closes the dialog and reopens it
     scans the same code and does not strand a half-finished upload. */
  const existing = await UploadPass.findOne({
    attemptId: attempt._id, questionId: question._id,
    closedAt: null, expiresAt: { $gt: now() },
  }).lean();

  const pass = existing || await UploadPass.create({
    ...tenant(req),
    token: crypto.randomBytes(24).toString('base64url'),
    attemptId: attempt._id,
    examId: exam._id,
    studentId: req.actor.id,
    questionId: question._id,
    section: question.section,
    questionNumber: (question.order ?? 0) + 1,
    expiresAt: new Date(now().getTime() + PASS_MINUTES * 60000),
  });

  /* The same window the mobile-scan pathway records, so an
     invigilator's view still shows that this candidate was uploading
     rather than writing. */
  if (!existing && !attempt.scanWindows.find((w) => !w.closedAt)) {
    attempt.scanWindows.push({ questionId: question._id, openedAt: now(), pages: 0 });
    await attempt.save();
  }

  const url = `${env.appUrl}/u/${pass.token}`;
  res.status(existing ? 200 : 201).json({
    token: pass.token,
    url,
    /* Drawn on the server so the examination page carries no QR
       library and no second request. */
    qrSvg: await QRCode.toString(url, { type: 'svg', margin: 1, width: 240,
                                        errorCorrectionLevel: 'M' }),
    expiresAt: pass.expiresAt,
    files: (pass.files || []).length,
    answerPages: answerPageCount(attempt, question._id),
    maxFiles: pass.maxFiles,
    questionNumber: pass.questionNumber,
  });
}));

/* The examination page asks this while the dialog is open, as a
   fallback for a live socket that has dropped. The socket push is the
   normal path; this is what makes the feature work anyway when it
   does not arrive. */
r.get('/:id/upload-pass/:token', wrap(async (req, res) => {
  const { attempt } = await loadAttempt(req);
  const pass = await UploadPass.findOne({
    token: req.params.token, attemptId: attempt._id, ...tenant(req),
  }).lean();
  if (!pass) throw notFound('That upload has expired');

  res.json({
    files: (pass.files || []).map((f) => ({
      name: f.name, mime: f.mime, bytes: f.bytes, uploadedAt: f.uploadedAt,
    })),
    answerPages: answerPageCount(attempt, pass.questionId),
    closed: Boolean(pass.closedAt),
    expiresAt: pass.expiresAt,
  });
}));

/* Done with the phone: the pass is spent and the scan window closes. */
r.post('/:id/upload-pass/:token/close', wrap(async (req, res) => {
  const { attempt } = await loadAttempt(req, { requireActive: true });
  const pass = await UploadPass.findOne({
    token: req.params.token, attemptId: attempt._id, ...tenant(req),
  });
  if (!pass) throw notFound('That upload has expired');

  if (!pass.closedAt) { pass.closedAt = now(); await pass.save(); }
  const win = attempt.scanWindows.find((w) => !w.closedAt
    && String(w.questionId) === String(pass.questionId));
  if (win) { win.closedAt = now(); await attempt.save(); }

  res.json({
    ok: true,
    files: (pass.files || []).length,
    answerPages: answerPageCount(attempt, pass.questionId),
  });
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

  const summary = await finaliseAttempt(attempt, exam, { auto: false });
  res.json({ ok: true, ...summary });
}));

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
