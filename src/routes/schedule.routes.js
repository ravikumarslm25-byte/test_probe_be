import { Router } from 'express';
import { Exam, Room, Attempt } from '../models/exam.js';
import { authenticate, can, tenant } from '../middleware/auth.js';
import { wrap } from '../utils/http.js';

const r = Router();
r.use(authenticate);

/* The coordinator's view across dates, rather than one paper at a
   time. Conflicts are surfaced here so the day can be corrected
   before anything is published. */
r.get('/', can('schedule:view', 'exam:view'), wrap(async (req, res) => {
  const from = req.query.from || new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  const to   = req.query.to   || new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);

  const exams = await Exam.find({ ...tenant(req), date: { $gte: from, $lte: to } })
    .populate('subjectId', 'code title')
    .populate('batchIds', 'label')
    .sort({ date: 1, startTime: 1 }).lean();

  const rooms = await Room.find({ examId: { $in: exams.map((e) => e._id) } })
    .populate('invigilatorId', 'name')
    .sort({ startAt: 1, name: 1 }).lean();

  const stats = await Attempt.aggregate([
    { $match: { roomId: { $in: rooms.map((x) => x._id) } } },
    { $group: {
      _id: '$roomId',
      total: { $sum: 1 },
      started: { $sum: { $cond: [{ $ne: ['$status', 'not_started'] }, 1, 0] } },
      submitted: { $sum: { $cond: [{ $eq: ['$status', 'submitted'] }, 1, 0] } },
      flagged: { $sum: { $cond: [{ $gt: ['$flagScore', 0] }, 1, 0] } },
    } },
  ]);
  const byRoom = Object.fromEntries(stats.map((s) => [String(s._id), s]));

  /* One invigilator cannot hold two rooms whose times overlap. They
     are free to take another room later the same day. */
  const clashes = [];
  const byInvigilator = {};
  for (const rm of rooms) {
    if (!rm.invigilatorId) continue;
    const key = String(rm.invigilatorId._id);
    for (const other of byInvigilator[key] || []) {
      if (new Date(rm.startAt) < new Date(other.endAt) && new Date(rm.endAt) > new Date(other.startAt)) {
        clashes.push({
          kind: 'invigilator',
          message: `${rm.invigilatorId.name} is assigned to both ${other.name} and ${rm.name} at the same time`,
        });
      }
    }
    byInvigilator[key] = [...(byInvigilator[key] || []), rm];
  }

  const days = {};
  for (const ex of exams) {
    days[ex.date] = days[ex.date] || { date: ex.date, exams: [] };
    const examRooms = rooms.filter((x) => String(x.examId) === String(ex._id));
    days[ex.date].exams.push({
      id: String(ex._id),
      title: ex.title, code: ex.code,
      subject: ex.subjectId ? `${ex.subjectId.code} — ${ex.subjectId.title}` : ex.code,
      batches: (ex.batchIds || []).map((b) => b.label),
      startTime: ex.startTime, durationMinutes: ex.durationMinutes,
      status: ex.status, totalMarks: ex.totalMarks,
      allowedPlatforms: ex.proctoring?.allowedPlatforms || ['windows'],
      rooms: examRooms.map((x) => ({
        id: String(x._id), name: x.name, capacity: x.capacity,
        startAt: x.startAt, endAt: x.endAt,
        invigilator: x.invigilatorId ? { id: String(x.invigilatorId._id), name: x.invigilatorId.name } : null,
        allocated: (x.studentIds || []).length,
        stats: byRoom[String(x._id)] || { total: 0, started: 0, submitted: 0, flagged: 0 },
      })),
      unassignedRooms: examRooms.filter((x) => !x.invigilatorId).length,
    });
  }

  res.json({
    range: { from, to },
    days: Object.values(days).sort((a, b) => a.date.localeCompare(b.date)),
    clashes,
    summary: {
      examinations: exams.length,
      rooms: rooms.length,
      candidates: Object.values(byRoom).reduce((s, x) => s + x.total, 0),
      unassigned: rooms.filter((x) => !x.invigilatorId).length,
    },
  });
}));

export default r;
