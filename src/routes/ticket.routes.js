import { Router } from 'express';
import { z } from 'zod';
import { Ticket, Exam, Attempt } from '../models/exam.js';
import { authenticate, can, tenant, studentOnly } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { wrap, notFound, forbidden, badRequest } from '../utils/http.js';
import { parse } from '../utils/validate.js';

const r = Router();
r.use(authenticate);

const now = () => new Date();
const ref = () => `TK-${Date.now().toString(36).toUpperCase().slice(-6)}`;

const CATEGORIES = [
  { key: 'access',   label: 'I cannot open or start the examination' },
  { key: 'device',   label: 'My camera, microphone or device is not working' },
  { key: 'schedule', label: 'Something about my examination schedule' },
  { key: 'result',   label: 'A question about my result' },
  { key: 'other',    label: 'Something else' },
];

/* Priority is derived, not chosen by the candidate. A candidate who
   cannot start a paper due in ten minutes is critical whether or not
   they say so. */
function derivePriority(category, exam) {
  if (['result', 'other'].includes(category)) return 'low';
  if (!exam) return 'medium';

  const startAt = new Date(`${exam.date}T${exam.startTime}:00`);
  const minutesAway = (startAt - now()) / 60000;

  if (category === 'access' || category === 'device') {
    if (minutesAway <= 30 && minutesAway >= -30) return 'critical';
    if (minutesAway <= 240 && minutesAway > 0) return 'high';
  }
  return 'medium';
}

/* ============================================================
   CANDIDATE SIDE
   ============================================================ */
r.get('/categories', wrap(async (_req, res) => res.json({ categories: CATEGORIES })));

r.get('/mine', studentOnly, wrap(async (req, res) => {
  const tickets = await Ticket.find({ ...tenant(req), 'raisedBy.id': req.actor.id })
    .populate('examId', 'title code date')
    .sort({ createdAt: -1 }).lean();

  res.json({
    tickets: tickets.map((t) => ({
      id: String(t._id), ref: t.ref,
      subject: t.subject, body: t.body,
      category: t.category, priority: t.priority, status: t.status,
      exam: t.examId ? { title: t.examId.title, code: t.examId.code } : null,
      thread: (t.thread || []).map((m) => ({ from: m.from, body: m.body, at: m.at })),
      createdAt: t.createdAt, resolvedAt: t.resolvedAt,
    })),
  });
}));

/* A candidate may raise a ticket before or after an examination.
   During one, the invigilator chat is the channel — raising a ticket
   would mean leaving the examination environment. */
r.post('/', studentOnly, wrap(async (req, res) => {
  const body = parse(z.object({
    category: z.enum(CATEGORIES.map((c) => c.key)),
    subject: z.string().min(5, 'Say briefly what is wrong').max(200),
    body: z.string().max(3000).optional(),
    examId: z.string().optional(),
    diagnostics: z.object({
      platform: z.string().optional(), browser: z.string().optional(),
      screen: z.string().optional(), camera: z.boolean().optional(),
      microphone: z.boolean().optional(), bandwidthMbps: z.number().optional(),
    }).optional(),
  }), req.body);

  const active = await Attempt.findOne({
    ...tenant(req), studentId: req.actor.id, status: 'in_progress',
  }).lean();
  if (active) {
    throw forbidden('You are sitting an examination. Use the invigilator chat — raising a ticket would mean leaving the examination.');
  }

  const exam = body.examId ? await Exam.findOne({ _id: body.examId, ...tenant(req) }).lean() : null;

  const ticket = await Ticket.create({
    ...tenant(req),
    ref: ref(),
    raisedBy: { kind: 'student', id: req.actor.id, name: req.actor.name },
    examId: exam?._id,
    category: body.category,
    subject: body.subject,
    body: body.body,
    diagnostics: body.diagnostics,
    priority: derivePriority(body.category, exam),
    status: 'open',
  });

  res.status(201).json({
    ticket: { id: String(ticket._id), ref: ticket.ref, priority: ticket.priority, status: ticket.status },
  });
}));

r.post('/:id/reply', wrap(async (req, res) => {
  const filter = { _id: req.params.id, ...tenant(req) };
  if (req.actor.kind === 'student') filter['raisedBy.id'] = req.actor.id;

  const ticket = await Ticket.findOne(filter);
  if (!ticket) throw notFound('Ticket not found');
  if (['resolved', 'closed'].includes(ticket.status) && req.actor.kind === 'staff') {
    throw badRequest('This ticket is closed. Reopen it before replying.');
  }

  const { body } = parse(z.object({ body: z.string().min(1).max(3000) }), req.body);

  ticket.thread.push({
    from: req.actor.kind === 'student' ? ticket.raisedBy.name : req.actor.name,
    body, at: now(),
  });
  if (req.actor.kind === 'staff' && ticket.status === 'open') ticket.status = 'in_progress';
  if (req.actor.kind === 'student' && ticket.status === 'resolved') ticket.status = 'in_progress';
  await ticket.save();

  res.json({ ok: true, status: ticket.status });
}));

/* ============================================================
   INSTITUTION QUEUE
   ============================================================ */
r.get('/', can('ticket:view'), wrap(async (req, res) => {
  const filter = { ...tenant(req) };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.priority) filter.priority = req.query.priority;

  const tickets = await Ticket.find(filter)
    .populate('examId', 'title code date startTime')
    .populate('assignedTo', 'name')
    .sort({ status: 1, priority: 1, createdAt: -1 }).limit(300).lean();

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  const open = tickets.filter((t) => ['open', 'in_progress'].includes(t.status));
  open.sort((a, b) => order[a.priority] - order[b.priority]);

  res.json({
    counts: {
      open: tickets.filter((t) => t.status === 'open').length,
      inProgress: tickets.filter((t) => t.status === 'in_progress').length,
      resolved: tickets.filter((t) => t.status === 'resolved').length,
      critical: open.filter((t) => t.priority === 'critical').length,
    },
    tickets: [...open, ...tickets.filter((t) => !['open', 'in_progress'].includes(t.status))]
      .map((t) => ({
        id: String(t._id), ref: t.ref,
        raisedBy: t.raisedBy,
        subject: t.subject, body: t.body,
        category: t.category, priority: t.priority, status: t.status,
        exam: t.examId ? {
          title: t.examId.title, code: t.examId.code,
          date: t.examId.date, startTime: t.examId.startTime,
        } : null,
        diagnostics: t.diagnostics,
        assignedTo: t.assignedTo ? { id: String(t.assignedTo._id), name: t.assignedTo.name } : null,
        thread: (t.thread || []).map((m) => ({ from: m.from, body: m.body, at: m.at })),
        createdAt: t.createdAt, resolvedAt: t.resolvedAt,
      })),
  });
}));

r.patch('/:id', can('ticket:edit'), wrap(async (req, res) => {
  const ticket = await Ticket.findOne({ _id: req.params.id, ...tenant(req) });
  if (!ticket) throw notFound('Ticket not found');

  const body = parse(z.object({
    status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    assignedTo: z.string().nullable().optional(),
  }), req.body);

  const before = { status: ticket.status, priority: ticket.priority };
  Object.assign(ticket, body);
  if (body.status === 'resolved' && !ticket.resolvedAt) ticket.resolvedAt = now();
  if (body.status && body.status !== 'resolved') ticket.resolvedAt = undefined;
  await ticket.save();

  await audit(req, {
    action: 'ticket.updated', entity: 'Ticket', entityId: ticket._id, before, after: body,
  });
  res.json({ ok: true, status: ticket.status, priority: ticket.priority });
}));

export default r;
