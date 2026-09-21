import { Router } from 'express';
import { z } from 'zod';
import { Exam, Room, Attempt } from '../models/exam.js';
import { authenticate, can, tenant } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { wrap, notFound, forbidden, badRequest } from '../utils/http.js';
import { parse } from '../utils/validate.js';
import { storage } from '../services/storage.js';
import { VIOLATION_CATALOGUE } from '../utils/grading.js';
import { pushToCandidate } from '../realtime/live.js';

const r = Router();
r.use(authenticate);

const now = () => new Date();

/* An invigilator sees only the rooms allocated to them. Examination
   administration sees every room. */
async function roomsForActor(req) {
  const wide = req.actor.permissions.has('exam:publish')
    || req.actor.permissions.has('schedule:publish')
    || req.actor.scope === 'institution';

  const filter = { ...tenant(req) };
  if (!wide) filter.invigilatorId = req.actor.id;
  return { filter, wide };
}

/* ============================================================
   MY ROOMS
   ============================================================ */
r.get('/rooms', can('invigilation:view'), wrap(async (req, res) => {
  const { filter, wide } = await roomsForActor(req);

  const rooms = await Room.find(filter)
    .populate('examId', 'title code date startTime durationMinutes status')
    .populate('invigilatorId', 'name')
    .sort({ startAt: -1 }).limit(60).lean();

  const live = rooms.filter((x) => x.examId && ['live', 'scheduled'].includes(x.examId.status));

  const counts = await Attempt.aggregate([
    { $match: { roomId: { $in: rooms.map((x) => x._id) } } },
    { $group: {
      _id: '$roomId',
      total: { $sum: 1 },
      present: { $sum: { $cond: [{ $in: ['$status', ['in_progress', 'submitted', 'flagged']] }, 1, 0] } },
      submitted: { $sum: { $cond: [{ $eq: ['$status', 'submitted'] }, 1, 0] } },
      flagged: { $sum: { $cond: [{ $gt: ['$flagScore', 0] }, 1, 0] } },
    } },
  ]);
  const byRoom = Object.fromEntries(counts.map((c) => [String(c._id), c]));

  res.json({
    scopedToMe: !wide,
    rooms: rooms.map((x) => ({
      id: String(x._id),
      name: x.name,
      startAt: x.startAt, endAt: x.endAt,
      invigilator: x.invigilatorId ? { id: String(x.invigilatorId._id), name: x.invigilatorId.name } : null,
      exam: x.examId ? {
        id: String(x.examId._id), title: x.examId.title, code: x.examId.code,
        date: x.examId.date, startTime: x.examId.startTime,
        durationMinutes: x.examId.durationMinutes, status: x.examId.status,
      } : null,
      stats: byRoom[String(x._id)] || { total: 0, present: 0, submitted: 0, flagged: 0 },
    })),
    liveCount: live.length,
  });
}));

/* ============================================================
   WALL
   One query returns every tile. Frames come from the interval
   captures the candidate is already uploading, so the wall needs
   no separate media path.
   ============================================================ */
r.get('/rooms/:roomId/wall', can('invigilation:view'), wrap(async (req, res) => {
  const { filter } = await roomsForActor(req);
  const room = await Room.findOne({ _id: req.params.roomId, ...filter })
    .populate('examId')
    .lean();
  if (!room) throw notFound('Room not found, or it is not allocated to you');

  const attempts = await Attempt.find({ roomId: room._id, ...tenant(req) })
    .populate('studentId', 'name regNo')
    .lean();

  const exam = room.examId;
  const ceiling = exam?.proctoring?.flagCeiling ?? 3;
  const stale = 45000;   // no heartbeat for 45s reads as disconnected

  const tiles = await Promise.all(attempts.map(async (a) => {
    const openScan = (a.scanWindows || []).find((w) => !w.closedAt);
    const seen = a.lastSeenAt ? now() - new Date(a.lastSeenAt) : null;

    let state = 'not_started';
    if (a.status === 'submitted') state = 'submitted';
    else if (a.status === 'terminated') state = 'terminated';
    else if (a.status === 'in_progress') {
      if (seen !== null && seen > stale) state = 'disconnected';
      else if (openScan) state = 'scanning';
      else if (a.flagScore > 0) state = 'flagged';
      else state = 'ok';
    } else if (a.status === 'verifying') state = 'verifying';

    const answered = (a.answers || []).filter((x) =>
      x.selected?.length || (x.text || '').trim() || (x.html || '').trim() || x.scanPages?.length).length;

    return {
      attemptId: String(a._id),
      student: a.studentId ? { name: a.studentId.name, regNo: a.studentId.regNo } : null,
      status: a.status,
      state,
      flagScore: a.flagScore || 0,
      ceiling,
      answered,
      section: a.sectionState?.current || 'A',
      lastSeenAt: a.lastSeenAt,
      frameUrl: a.latestFrame?.key ? await storage.urlFor(a.latestFrame.key) : null,
      frameAt: a.latestFrame?.at || null,
      unreadFromStudent: (a.chat || []).filter((c) => c.from === 'student').length,
      latestViolation: (a.violations || []).length
        ? (() => {
            const v = a.violations[a.violations.length - 1];
            return { label: VIOLATION_CATALOGUE[v.type]?.label || v.type, severity: v.severity, at: v.at };
          })()
        : null,
    };
  }));

  // flagged first, then disconnected — the invigilator should never
  // have to scan a grid to find the candidate who needs attention
  const rank = { flagged: 0, disconnected: 1, scanning: 2, verifying: 3, ok: 4, submitted: 5, terminated: 6, not_started: 7 };
  tiles.sort((a, b) => (rank[a.state] - rank[b.state]) || b.flagScore - a.flagScore);

  const startAt = exam ? new Date(`${exam.date}T${exam.startTime}:00`) : null;

  res.json({
    room: { id: String(room._id), name: room.name, capacity: room.capacity },
    exam: exam ? {
      id: String(exam._id), title: exam.title, code: exam.code,
      status: exam.status, durationMinutes: exam.durationMinutes,
      startAt,
      elapsedMinutes: startAt ? Math.max(0, Math.floor((now() - startAt) / 60000)) : 0,
    } : null,
    summary: {
      total: tiles.length,
      present: tiles.filter((t) => ['ok', 'flagged', 'scanning', 'submitted'].includes(t.state)).length,
      submitted: tiles.filter((t) => t.state === 'submitted').length,
      flagged: tiles.filter((t) => t.flagScore > 0).length,
      scanning: tiles.filter((t) => t.state === 'scanning').length,
      disconnected: tiles.filter((t) => t.state === 'disconnected').length,
      terminated: tiles.filter((t) => t.state === 'terminated').length,
    },
    tiles,
    serverTime: now(),
  });
}));

/* ============================================================
   FOCUS — one candidate in detail
   ============================================================ */
r.get('/attempts/:id', can('invigilation:view'), wrap(async (req, res) => {
  const attempt = await Attempt.findOne({ _id: req.params.id, ...tenant(req) })
    .populate('studentId', 'name regNo email photoKey')
    .populate('examId', 'title code proctoring durationMinutes')
    .populate('roomId', 'name invigilatorId')
    .lean();
  if (!attempt) throw notFound('Attempt not found');

  const wide = req.actor.permissions.has('exam:publish') || req.actor.scope === 'institution';
  if (!wide && String(attempt.roomId?.invigilatorId) !== req.actor.id) {
    throw forbidden('That candidate is not in a room allocated to you');
  }

  const url = async (k) => (k ? storage.urlFor(k) : null);

  res.json({
    attempt: {
      id: String(attempt._id),
      status: attempt.status,
      student: attempt.studentId,
      exam: attempt.examId,
      room: attempt.roomId ? { name: attempt.roomId.name } : null,
      startedAt: attempt.startedAt,
      timerEndsAt: attempt.timerEndsAt,
      flagScore: attempt.flagScore,
      ceiling: attempt.examId?.proctoring?.flagCeiling ?? 3,
      section: attempt.sectionState?.current,
      lockedSections: attempt.sectionState?.lockedSections || [],
      lastSeenAt: attempt.lastSeenAt,
      environment: attempt.environment,
      micGranted: Boolean(attempt.micGrantedUntil && new Date(attempt.micGrantedUntil) > now()),
      timeExtension: attempt.timeExtension,
      terminationReason: attempt.terminationReason,
    },
    identity: {
      faceUrl: await url(attempt.identity?.faceKey),
      idCardUrl: await url(attempt.identity?.idCardKey),
      verifiedAt: attempt.identity?.verifiedAt,
    },
    latestFrameUrl: await url(attempt.latestFrame?.key),
    violations: await Promise.all((attempt.violations || []).map(async (v) => ({
      type: v.type,
      label: VIOLATION_CATALOGUE[v.type]?.label || v.type,
      severity: v.severity, weight: v.weight, at: v.at, note: v.note,
      cameraUrl: await url(v.cameraKey),
      screenUrl: await url(v.screenKey),
    }))),
    chat: (attempt.chat || []).map((c) => ({ from: c.from, body: c.body, at: c.at })),
    warnings: (attempt.warnings || []).map((w) => ({
      body: w.body, byName: w.byName, at: w.at, acknowledgedAt: w.acknowledgedAt,
    })),
    scanWindows: attempt.scanWindows || [],
  });
}));

/* ============================================================
   CAPTURE TIMELINE
   Evidence was being written to storage with nothing recording where
   it went. This is what makes an attempt reviewable afterwards.
   ============================================================ */
r.get('/attempts/:id/captures', can('invigilation:view', 'evaluation:view'), wrap(async (req, res) => {
  const attempt = await Attempt.findOne({ _id: req.params.id, ...tenant(req) })
    .populate('studentId', 'name regNo')
    .populate('roomId', 'name invigilatorId')
    .lean();
  if (!attempt) throw notFound('Attempt not found');

  const wide = req.actor.permissions.has('exam:publish')
    || req.actor.permissions.has('evaluation:view')
    || req.actor.scope === 'institution';
  if (!wide && String(attempt.roomId?.invigilatorId) !== req.actor.id) {
    throw forbidden('That candidate is not in a room allocated to you');
  }

  const onlyFlagged = req.query.flagged === 'true';
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(120, Number(req.query.size) || 60);

  let all = [...(attempt.captures || [])].sort((a, b) => new Date(a.at) - new Date(b.at));
  if (onlyFlagged) all = all.filter((c) => c.flagged);

  const slice = all.slice((page - 1) * size, page * size);

  res.json({
    student: attempt.studentId,
    room: attempt.roomId ? { name: attempt.roomId.name } : null,
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    total: all.length,
    flaggedTotal: (attempt.captures || []).filter((c) => c.flagged).length,
    page, size,
    captures: await Promise.all(slice.map(async (c) => ({
      at: c.at,
      kind: c.kind,
      flagged: c.flagged,
      violation: c.violationType ? (VIOLATION_CATALOGUE[c.violationType]?.label || c.violationType) : null,
      url: await storage.urlFor(c.key),
      // seconds from the start of the attempt, for the timeline scrubber
      offset: attempt.startedAt
        ? Math.max(0, Math.round((new Date(c.at) - new Date(attempt.startedAt)) / 1000))
        : null,
    }))),
  });
}));

/* ============================================================
   CONTROLS
   ============================================================ */
async function loadForControl(req) {
  const attempt = await Attempt.findOne({ _id: req.params.id, ...tenant(req) })
    .populate('roomId', 'invigilatorId');
  if (!attempt) throw notFound('Attempt not found');

  const wide = req.actor.permissions.has('exam:publish') || req.actor.scope === 'institution';
  if (!wide && String(attempt.roomId?.invigilatorId) !== req.actor.id) {
    throw forbidden('That candidate is not in a room allocated to you');
  }
  return attempt;
}

r.post('/attempts/:id/message', can('invigilation:edit'), wrap(async (req, res) => {
  const attempt = await loadForControl(req);
  const { body } = parse(z.object({ body: z.string().min(1).max(600) }), req.body);

  const at = now();
  /* Marked read straight away when the socket delivers it, so the
     heartbeat does not deliver the same message a second time. */
  const delivered = pushToCandidate(attempt._id, { type: 'chat', from: 'invigilator', body, at });

  attempt.chat.push({ from: 'invigilator', body, at, readByStudent: delivered });
  await attempt.save();
  res.json({ ok: true, delivered });
}));

/* A warning blocks the candidate's screen until acknowledged, so it
   is recorded rather than merely sent. */
r.post('/attempts/:id/warn', can('invigilation:edit'), wrap(async (req, res) => {
  const attempt = await loadForControl(req);
  const { body } = parse(z.object({ body: z.string().min(1).max(600) }), req.body);

  attempt.warnings.push({ by: req.actor.id, byName: req.actor.name, body, at: now() });
  await attempt.save();

  pushToCandidate(attempt._id, { type: 'warning', body, by: req.actor.name });

  await audit(req, { action: 'invigilation.warned', entity: 'Attempt', entityId: attempt._id, after: { body } });
  res.json({ ok: true, warnings: attempt.warnings.length });
}));

r.post('/attempts/:id/mic', can('invigilation:edit'), wrap(async (req, res) => {
  const attempt = await loadForControl(req);
  const { minutes } = parse(z.object({
    minutes: z.number().int().min(0).max(15).default(2),
  }), req.body);

  attempt.micGrantedUntil = minutes > 0 ? new Date(now().getTime() + minutes * 60000) : null;
  await attempt.save();

  pushToCandidate(attempt._id, {
    type: 'mic',
    granted: minutes > 0,
    until: attempt.micGrantedUntil,
    by: req.actor.name,
  });

  await audit(req, {
    action: minutes > 0 ? 'invigilation.mic_granted' : 'invigilation.mic_revoked',
    entity: 'Attempt', entityId: attempt._id, after: { minutes },
  });
  res.json({ ok: true, micGrantedUntil: attempt.micGrantedUntil });
}));

/* Disqualification requires a stated reason. It is preserved in full
   so the Controller can answer an appeal. */
r.post('/attempts/:id/terminate', can('invigilation:edit'), wrap(async (req, res) => {
  const attempt = await loadForControl(req);
  const { reason } = parse(z.object({
    reason: z.string().min(10, 'State the reason in at least a short sentence').max(1000),
  }), req.body);

  if (['submitted', 'terminated'].includes(attempt.status)) {
    throw badRequest('This attempt is already closed');
  }

  attempt.status = 'terminated';
  attempt.terminationReason = `${reason} — ${req.actor.name}`;
  attempt.submittedAt = now();
  await attempt.save();

  pushToCandidate(attempt._id, { type: 'terminated', reason: attempt.terminationReason });

  await audit(req, {
    action: 'invigilation.terminated', entity: 'Attempt', entityId: attempt._id,
    after: { reason, flagScore: attempt.flagScore },
  });
  res.json({ ok: true, status: attempt.status });
}));

r.post('/attempts/:id/extend', can('invigilation:edit'), wrap(async (req, res) => {
  const attempt = await loadForControl(req);
  const { minutes, reason } = parse(z.object({
    minutes: z.number().int().min(1).max(120),
    reason: z.string().min(5, 'State why the extension is granted').max(500),
  }), req.body);

  if (attempt.status !== 'in_progress') throw badRequest('This candidate is not sitting the paper');

  attempt.timerEndsAt = new Date(new Date(attempt.timerEndsAt).getTime() + minutes * 60000);
  attempt.timeExtension = { minutes, reason, approvedBy: req.actor.id, at: now() };
  await attempt.save();

  await audit(req, {
    action: 'invigilation.time_extended', entity: 'Attempt', entityId: attempt._id,
    after: { minutes, reason },
  });
  res.json({ ok: true, timerEndsAt: attempt.timerEndsAt });
}));

/* Room broadcast. One message to every candidate still working. */
r.post('/rooms/:roomId/broadcast', can('invigilation:edit'), wrap(async (req, res) => {
  const { filter } = await roomsForActor(req);
  const room = await Room.findOne({ _id: req.params.roomId, ...filter }).lean();
  if (!room) throw notFound('Room not found, or it is not allocated to you');

  const { body } = parse(z.object({ body: z.string().min(1).max(600) }), req.body);

  const live = await Attempt.find({ roomId: room._id, status: 'in_progress' }).select('_id').lean();
  const at = now();
  for (const a of live) pushToCandidate(a._id, { type: 'chat', from: 'invigilator', body, at });

  const result = await Attempt.updateMany(
    { roomId: room._id, status: 'in_progress' },
    { $push: { chat: { from: 'invigilator', body, at, readByStudent: true } } },
  );

  await audit(req, { action: 'invigilation.broadcast', entity: 'Room', entityId: room._id, after: { body } });
  res.json({ ok: true, delivered: result.modifiedCount });
}));

export default r;
