import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { Exam, Attempt, Room, Question } from '../models/exam.js';
import { Student, Department, Batch, Subject, Institution } from '../models/core.js';
import { authenticate, can, tenant, resolveScope } from '../middleware/auth.js';
import { wrap, notFound, badRequest } from '../utils/http.js';
import { parse } from '../utils/validate.js';
import { VIOLATION_CATALOGUE } from '../utils/grading.js';

const r = Router();
r.use(authenticate);

const oid = (v) => new Types.ObjectId(v);
const round = (n) => Math.round(n * 100) / 100;
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

/* ============================================================
   CATALOGUE
   Every report declares the filters it honours, so the UI builds
   its own form rather than hard-coding one per report.
   ============================================================ */
export const REPORTS = [
  { key: 'student',      name: 'Student-wise performance',
    desc: 'Complete examination history for each candidate with sectional breakdown and proctoring summary',
    filters: ['department', 'batch', 'student', 'dateRange'] },
  { key: 'subject',      name: 'Subject-wise analysis',
    desc: 'Mark distribution, mean, median and question-level difficulty across all candidates',
    filters: ['department', 'subject', 'exam', 'dateRange'] },
  { key: 'batch',        name: 'Class and batch summary',
    desc: 'Aggregate performance by batch, section and department with comparative analysis',
    filters: ['department', 'batch', 'dateRange'] },
  { key: 'schedule',     name: 'Schedule and room register',
    desc: 'Every examination by date and room with allocation, invigilator coverage and completion',
    filters: ['department', 'dateRange'] },
  { key: 'attendance',   name: 'Attendance register',
    desc: 'Present, absent, late entry and disqualified counts by examination, room and batch',
    filters: ['department', 'batch', 'exam', 'dateRange'] },
  { key: 'outcome',      name: 'Pass and fail analysis',
    desc: 'Outcome by subject, batch and department against the configured pass mark',
    filters: ['department', 'batch', 'subject', 'dateRange'] },
  { key: 'toppers',      name: 'Top performers',
    desc: 'Ranked listing by subject, batch and overall, to a configurable cut-off',
    filters: ['department', 'batch', 'subject', 'limit', 'dateRange'] },
  { key: 'intervention', name: 'Below-threshold performance',
    desc: 'Candidates scoring under a defined threshold, for academic intervention',
    filters: ['department', 'batch', 'threshold', 'dateRange'] },
  { key: 'proctoring',   name: 'Proctoring and violations',
    desc: 'Flag summary by type and severity across candidates, rooms and examinations',
    filters: ['department', 'exam', 'dateRange'] },
  { key: 'consolidated', name: 'Consolidated statement',
    desc: 'Institution-wide summary across departments and terms, for statutory reporting',
    filters: ['dateRange'] },
];

const filterSchema = z.object({
  departmentId: z.string().optional(),
  batchId: z.string().optional(),
  subjectId: z.string().optional(),
  examId: z.string().optional(),
  studentId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  threshold: z.coerce.number().min(0).optional(),
});

/* Resolves the exams a report should cover, honouring both the
   filters and the actor's own data scope. */
async function examScope(req, f) {
  const scope = await resolveScope(req.actor);
  const q = { ...tenant(req) };

  if (f.examId) q._id = oid(f.examId);
  if (f.subjectId) q.subjectId = oid(f.subjectId);
  if (f.batchId) q.batchIds = oid(f.batchId);
  if (f.from || f.to) {
    q.date = {};
    if (f.from) q.date.$gte = f.from;
    if (f.to) q.date.$lte = f.to;
  }
  if (scope) q.subjectId = { $in: scope.subjectIds.map(oid) };

  if (f.departmentId) {
    const subjects = await Subject.find({ ...tenant(req), departmentId: oid(f.departmentId) })
      .select('_id').lean();
    const ids = subjects.map((s) => s._id);
    q.subjectId = q.subjectId?.$in
      ? { $in: q.subjectId.$in.filter((x) => ids.some((y) => String(y) === String(x))) }
      : { $in: ids };
  }

  return Exam.find(q).populate('subjectId', 'code title departmentId').populate('batchIds', 'label').lean();
}

r.get('/', can('report:view'), wrap(async (req, res) => {
  const t = tenant(req);
  const [departments, batches, subjects, exams] = await Promise.all([
    Department.find(t).select('name code').sort({ name: 1 }).lean(),
    Batch.find(t).select('label').sort({ year: 1, section: 1 }).lean(),
    Subject.find(t).select('code title').sort({ code: 1 }).lean(),
    Exam.find(t).select('title code date').sort({ date: -1 }).limit(60).lean(),
  ]);

  res.json({
    reports: REPORTS,
    options: {
      departments: departments.map((d) => ({ id: String(d._id), label: `${d.name} (${d.code})` })),
      batches: batches.map((b) => ({ id: String(b._id), label: b.label })),
      subjects: subjects.map((s) => ({ id: String(s._id), label: `${s.code} — ${s.title}` })),
      exams: exams.map((e) => ({ id: String(e._id), label: `${e.code} · ${e.date}` })),
    },
  });
}));

/* ============================================================
   BUILDERS
   Each returns { title, subtitle, columns, rows, summary }.
   Columns carry an align hint so the table and the CSV agree.
   ============================================================ */
const N = (key, label) => ({ key, label, align: 'right' });
const T = (key, label) => ({ key, label });

const builders = {
  /* ---- R1 student-wise ---- */
  async student(req, f) {
    const exams = await examScope(req, f);
    const examIds = exams.map((e) => e._id);
    const byExam = new Map(exams.map((e) => [String(e._id), e]));

    const sFilter = { ...tenant(req) };
    if (f.batchId) sFilter.batchId = oid(f.batchId);
    if (f.studentId) sFilter._id = oid(f.studentId);
    if (f.departmentId) sFilter.departmentId = oid(f.departmentId);

    const scope = await resolveScope(req.actor);
    if (scope) sFilter.batchId = { $in: scope.batchIds.map(oid) };

    const students = await Student.find(sFilter).populate('batchId', 'label').lean();
    const attempts = await Attempt.find({
      examId: { $in: examIds },
      studentId: { $in: students.map((s) => s._id) },
    }).lean();

    const rows = [];
    for (const a of attempts) {
      const st = students.find((s) => String(s._id) === String(a.studentId));
      const ex = byExam.get(String(a.examId));
      if (!st || !ex) continue;
      rows.push({
        regNo: st.regNo, name: st.name, batch: st.batchId?.label || '',
        exam: `${ex.code} — ${ex.title}`, date: ex.date,
        sectionA: a.marks?.sectionA ?? 0,
        sectionB: a.marks?.sectionB ?? 0,
        sectionC: a.marks?.sectionC ?? 0,
        total: a.marks?.total ?? 0,
        outOf: ex.totalMarks,
        percentage: pct(a.marks?.total ?? 0, ex.totalMarks),
        outcome: a.evaluation?.state === 'submitted' ? (a.marks?.passed ? 'Pass' : 'Fail') : 'Pending',
        flags: a.flagScore || 0,
        status: a.status,
      });
    }
    rows.sort((x, y) => x.regNo.localeCompare(y.regNo) || x.date.localeCompare(y.date));

    return {
      title: 'Student-wise performance',
      subtitle: `${new Set(rows.map((x) => x.regNo)).size} candidate(s) across ${exams.length} examination(s)`,
      columns: [T('regNo', 'Register number'), T('name', 'Name'), T('batch', 'Batch'),
        T('exam', 'Examination'), T('date', 'Date'),
        N('sectionA', 'Part A'), N('sectionB', 'Part B'), N('sectionC', 'Part C'),
        N('total', 'Total'), N('outOf', 'Out of'), N('percentage', '%'),
        T('outcome', 'Outcome'), N('flags', 'Flags')],
      rows,
      summary: {
        Records: rows.length,
        Candidates: new Set(rows.map((x) => x.regNo)).size,
        'Average %': rows.length ? round(rows.reduce((s, x) => s + x.percentage, 0) / rows.length) : 0,
      },
    };
  },

  /* ---- R2 subject-wise, with question difficulty ---- */
  async subject(req, f) {
    const exams = await examScope(req, f);
    const rows = [];

    for (const ex of exams) {
      const attempts = await Attempt.find({ examId: ex._id, 'evaluation.state': 'submitted' }).lean();
      const totals = attempts.map((a) => a.marks?.total ?? 0);
      const sorted = [...totals].sort((a, b) => a - b);

      rows.push({
        subject: ex.subjectId ? `${ex.subjectId.code} — ${ex.subjectId.title}` : ex.code,
        exam: ex.title, date: ex.date,
        appeared: attempts.length,
        outOf: ex.totalMarks,
        mean: totals.length ? round(totals.reduce((s, n) => s + n, 0) / totals.length) : 0,
        median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
        highest: totals.length ? Math.max(...totals) : 0,
        lowest: totals.length ? Math.min(...totals) : 0,
        passed: attempts.filter((a) => a.marks?.passed).length,
        passRate: pct(attempts.filter((a) => a.marks?.passed).length, attempts.length),
      });
    }

    /* Question-level difficulty, for a single examination only —
       across several papers the figures would not be comparable. */
    let difficulty = null;
    if (exams.length === 1) {
      const ex = exams[0];
      const questions = await Question.find({ examId: ex._id }).sort({ section: 1, order: 1 }).lean();
      const attempts = await Attempt.find({ examId: ex._id }).lean();

      difficulty = {
        columns: [T('q', 'Question'), T('section', 'Part'), N('marks', 'Marks'),
          N('attempted', 'Attempted'), N('correct', 'Full marks'), N('facility', 'Facility %'), T('verdict', 'Verdict')],
        rows: questions.map((q, i) => {
          let attempted = 0, full = 0;
          for (const a of attempts) {
            const ans = (a.answers || []).find((x) => String(x.questionId) === String(q._id));
            if (!ans) continue;
            const has = ans.selected?.length || (ans.text || '').trim() || (ans.html || '').trim() || ans.scanPages?.length;
            if (!has) continue;
            attempted++;
            if ((ans.awarded ?? 0) >= q.marks) full++;
          }
          const facility = pct(full, attempted);
          return {
            q: `Q${i + 1}`, section: q.section, marks: q.marks,
            attempted, correct: full, facility,
            verdict: attempted === 0 ? 'Not attempted'
              : facility >= 80 ? 'Easy' : facility >= 40 ? 'Moderate' : 'Hard',
          };
        }),
      };
    }

    return {
      title: 'Subject-wise analysis',
      subtitle: `${exams.length} examination(s)`,
      columns: [T('subject', 'Subject'), T('exam', 'Examination'), T('date', 'Date'),
        N('appeared', 'Appeared'), N('outOf', 'Out of'), N('mean', 'Mean'), N('median', 'Median'),
        N('highest', 'Highest'), N('lowest', 'Lowest'), N('passed', 'Passed'), N('passRate', 'Pass %')],
      rows,
      extra: difficulty ? { title: 'Question-level difficulty', ...difficulty } : null,
      summary: {
        Examinations: rows.length,
        'Scripts evaluated': rows.reduce((s, x) => s + x.appeared, 0),
        'Overall pass %': rows.length ? round(rows.reduce((s, x) => s + x.passRate, 0) / rows.length) : 0,
      },
    };
  },

  /* ---- R3 batch summary ---- */
  async batch(req, f) {
    const exams = await examScope(req, f);
    const examIds = exams.map((e) => e._id);

    const bFilter = { ...tenant(req) };
    if (f.batchId) bFilter._id = oid(f.batchId);
    if (f.departmentId) bFilter.departmentId = oid(f.departmentId);
    const batches = await Batch.find(bFilter).populate('departmentId', 'name').lean();

    const rows = [];
    for (const b of batches) {
      const students = await Student.find({ ...tenant(req), batchId: b._id }).select('_id').lean();
      const attempts = await Attempt.find({
        examId: { $in: examIds }, studentId: { $in: students.map((s) => s._id) },
        'evaluation.state': 'submitted',
      }).lean();
      if (!attempts.length && !students.length) continue;

      const totals = attempts.map((a) => a.marks?.total ?? 0);
      const passed = attempts.filter((a) => a.marks?.passed).length;

      rows.push({
        batch: b.label, department: b.departmentId?.name || '',
        enrolled: students.length,
        scripts: attempts.length,
        mean: totals.length ? round(totals.reduce((s, n) => s + n, 0) / totals.length) : 0,
        highest: totals.length ? Math.max(...totals) : 0,
        passed, failed: attempts.length - passed,
        passRate: pct(passed, attempts.length),
        flagged: attempts.filter((a) => (a.flagScore || 0) > 0).length,
      });
    }
    rows.sort((x, y) => y.passRate - x.passRate);

    return {
      title: 'Class and batch summary',
      subtitle: `${rows.length} batch(es)`,
      columns: [T('batch', 'Batch'), T('department', 'Department'), N('enrolled', 'Enrolled'),
        N('scripts', 'Scripts'), N('mean', 'Mean'), N('highest', 'Highest'),
        N('passed', 'Passed'), N('failed', 'Failed'), N('passRate', 'Pass %'), N('flagged', 'Flagged')],
      rows,
      summary: {
        Batches: rows.length,
        Enrolled: rows.reduce((s, x) => s + x.enrolled, 0),
        Scripts: rows.reduce((s, x) => s + x.scripts, 0),
      },
    };
  },

  /* ---- R4 schedule and room register ---- */
  async schedule(req, f) {
    const exams = await examScope(req, f);
    const rows = [];

    for (const ex of exams) {
      const rooms = await Room.find({ examId: ex._id }).populate('invigilatorId', 'name').lean();
      for (const rm of rooms) {
        const stats = await Attempt.aggregate([
          { $match: { roomId: rm._id } },
          { $group: {
            _id: null,
            total: { $sum: 1 },
            started: { $sum: { $cond: [{ $ne: ['$status', 'not_started'] }, 1, 0] } },
            submitted: { $sum: { $cond: [{ $eq: ['$status', 'submitted'] }, 1, 0] } },
          } },
        ]);
        const s = stats[0] || {};
        rows.push({
          date: ex.date,
          exam: `${ex.code} — ${ex.title}`,
          room: rm.name,
          time: `${new Date(rm.startAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} – ${new Date(rm.endAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
          invigilator: rm.invigilatorId?.name || 'Unassigned',
          capacity: rm.capacity,
          allocated: (rm.studentIds || []).length,
          started: s.started || 0,
          submitted: s.submitted || 0,
          status: ex.status,
        });
      }
      if (!rooms.length) {
        rows.push({
          date: ex.date, exam: `${ex.code} — ${ex.title}`, room: 'No rooms built',
          time: ex.startTime, invigilator: '—', capacity: 0, allocated: 0,
          started: 0, submitted: 0, status: ex.status,
        });
      }
    }
    rows.sort((x, y) => y.date.localeCompare(x.date) || x.room.localeCompare(y.room));

    return {
      title: 'Schedule and room register',
      subtitle: `${rows.length} room(s) across ${exams.length} examination(s)`,
      columns: [T('date', 'Date'), T('exam', 'Examination'), T('room', 'Room'), T('time', 'Time'),
        T('invigilator', 'Invigilator'), N('capacity', 'Capacity'), N('allocated', 'Allocated'),
        N('started', 'Started'), N('submitted', 'Submitted'), T('status', 'Status')],
      rows,
      summary: {
        Rooms: rows.length,
        Allocated: rows.reduce((s, x) => s + x.allocated, 0),
        Unassigned: rows.filter((x) => x.invigilator === 'Unassigned').length,
      },
    };
  },

  /* ---- R5 attendance ---- */
  async attendance(req, f) {
    const exams = await examScope(req, f);
    const rows = [];

    for (const ex of exams) {
      const attempts = await Attempt.find({ examId: ex._id }).lean();
      const absent = attempts.filter((a) => a.status === 'not_started').length;
      const late = attempts.filter((a) =>
        a.startedAt && new Date(a.startedAt) > new Date(`${ex.date}T${ex.startTime}:00`).getTime() + 15 * 60000).length;

      rows.push({
        date: ex.date,
        exam: `${ex.code} — ${ex.title}`,
        batches: (ex.batchIds || []).map((b) => b.label).join(', '),
        scheduled: attempts.length,
        present: attempts.filter((a) => ['in_progress', 'submitted', 'flagged'].includes(a.status)).length,
        absent,
        late,
        disqualified: attempts.filter((a) => a.status === 'terminated').length,
        attendance: pct(attempts.length - absent, attempts.length),
      });
    }
    rows.sort((x, y) => y.date.localeCompare(x.date));

    return {
      title: 'Attendance register',
      subtitle: `${exams.length} examination(s)`,
      columns: [T('date', 'Date'), T('exam', 'Examination'), T('batches', 'Batches'),
        N('scheduled', 'Scheduled'), N('present', 'Present'), N('absent', 'Absent'),
        N('late', 'Late entry'), N('disqualified', 'Disqualified'), N('attendance', 'Attendance %')],
      rows,
      summary: {
        Scheduled: rows.reduce((s, x) => s + x.scheduled, 0),
        Present: rows.reduce((s, x) => s + x.present, 0),
        Absent: rows.reduce((s, x) => s + x.absent, 0),
        Disqualified: rows.reduce((s, x) => s + x.disqualified, 0),
      },
    };
  },

  /* ---- R6 pass and fail ---- */
  async outcome(req, f) {
    const exams = await examScope(req, f);
    const rows = [];

    for (const ex of exams) {
      const attempts = await Attempt.find({ examId: ex._id, 'evaluation.state': 'submitted' }).lean();
      const passed = attempts.filter((a) => a.marks?.passed).length;
      const bands = { '0-39': 0, '40-49': 0, '50-59': 0, '60-74': 0, '75-100': 0 };
      for (const a of attempts) {
        const p = pct(a.marks?.total ?? 0, ex.totalMarks);
        const band = p < 40 ? '0-39' : p < 50 ? '40-49' : p < 60 ? '50-59' : p < 75 ? '60-74' : '75-100';
        bands[band]++;
      }
      rows.push({
        date: ex.date,
        exam: `${ex.code} — ${ex.title}`,
        passMark: ex.passMark, outOf: ex.totalMarks,
        evaluated: attempts.length,
        passed, failed: attempts.length - passed,
        passRate: pct(passed, attempts.length),
        ...bands,
      });
    }

    return {
      title: 'Pass and fail analysis',
      subtitle: `${exams.length} examination(s), banded by percentage`,
      columns: [T('date', 'Date'), T('exam', 'Examination'), N('passMark', 'Pass mark'),
        N('evaluated', 'Evaluated'), N('passed', 'Passed'), N('failed', 'Failed'), N('passRate', 'Pass %'),
        N('0-39', '0–39%'), N('40-49', '40–49%'), N('50-59', '50–59%'), N('60-74', '60–74%'), N('75-100', '75–100%')],
      rows,
      summary: {
        Evaluated: rows.reduce((s, x) => s + x.evaluated, 0),
        Passed: rows.reduce((s, x) => s + x.passed, 0),
        Failed: rows.reduce((s, x) => s + x.failed, 0),
      },
    };
  },

  /* ---- R7 top performers ---- */
  async toppers(req, f) {
    const exams = await examScope(req, f);
    const examIds = exams.map((e) => e._id);
    const byExam = new Map(exams.map((e) => [String(e._id), e]));
    const limit = f.limit || 25;

    const attempts = await Attempt.find({
      examId: { $in: examIds }, 'evaluation.state': 'submitted',
    }).populate('studentId', 'name regNo batchId').lean();

    const batches = await Batch.find(tenant(req)).select('label').lean();
    const batchLabel = Object.fromEntries(batches.map((b) => [String(b._id), b.label]));

    const rows = attempts
      .map((a) => {
        const ex = byExam.get(String(a.examId));
        return {
          regNo: a.studentId?.regNo || '',
          name: a.studentId?.name || '',
          batch: batchLabel[String(a.studentId?.batchId)] || '',
          exam: ex ? `${ex.code} — ${ex.title}` : '',
          total: a.marks?.total ?? 0,
          outOf: ex?.totalMarks ?? 0,
          percentage: pct(a.marks?.total ?? 0, ex?.totalMarks ?? 1),
          flags: a.flagScore || 0,
        };
      })
      .sort((x, y) => y.percentage - x.percentage)
      .slice(0, limit)
      .map((x, i) => ({ rank: i + 1, ...x }));

    return {
      title: 'Top performers',
      subtitle: `Highest ${rows.length} of ${attempts.length} evaluated script(s)`,
      columns: [N('rank', 'Rank'), T('regNo', 'Register number'), T('name', 'Name'), T('batch', 'Batch'),
        T('exam', 'Examination'), N('total', 'Total'), N('outOf', 'Out of'), N('percentage', '%'), N('flags', 'Flags')],
      rows,
      summary: {
        Listed: rows.length,
        'Highest %': rows[0]?.percentage ?? 0,
        'Cut-off %': rows[rows.length - 1]?.percentage ?? 0,
      },
    };
  },

  /* ---- R8 below threshold ---- */
  async intervention(req, f) {
    const exams = await examScope(req, f);
    const examIds = exams.map((e) => e._id);
    const byExam = new Map(exams.map((e) => [String(e._id), e]));
    const threshold = f.threshold ?? 40;

    const attempts = await Attempt.find({
      examId: { $in: examIds }, 'evaluation.state': 'submitted',
    }).populate('studentId', 'name regNo email batchId').lean();

    const batches = await Batch.find(tenant(req)).select('label').lean();
    const batchLabel = Object.fromEntries(batches.map((b) => [String(b._id), b.label]));

    const rows = attempts
      .map((a) => {
        const ex = byExam.get(String(a.examId));
        return {
          regNo: a.studentId?.regNo || '',
          name: a.studentId?.name || '',
          email: a.studentId?.email || '',
          batch: batchLabel[String(a.studentId?.batchId)] || '',
          exam: ex ? `${ex.code} — ${ex.title}` : '',
          total: a.marks?.total ?? 0,
          outOf: ex?.totalMarks ?? 0,
          percentage: pct(a.marks?.total ?? 0, ex?.totalMarks ?? 1),
          sectionC: a.marks?.sectionC ?? 0,
        };
      })
      .filter((x) => x.percentage < threshold)
      .sort((x, y) => x.percentage - y.percentage);

    // a candidate below threshold in more than one subject needs more
    const repeat = {};
    rows.forEach((x) => { repeat[x.regNo] = (repeat[x.regNo] || 0) + 1; });
    rows.forEach((x) => { x.subjectsBelow = repeat[x.regNo]; });

    return {
      title: 'Below-threshold performance',
      subtitle: `Candidates under ${threshold}% · ${new Set(rows.map((x) => x.regNo)).size} individual(s)`,
      columns: [T('regNo', 'Register number'), T('name', 'Name'), T('batch', 'Batch'), T('email', 'Email'),
        T('exam', 'Examination'), N('total', 'Total'), N('outOf', 'Out of'), N('percentage', '%'),
        N('subjectsBelow', 'Subjects below')],
      rows,
      summary: {
        Records: rows.length,
        Candidates: new Set(rows.map((x) => x.regNo)).size,
        'In two or more subjects': Object.values(repeat).filter((n) => n > 1).length,
      },
    };
  },

  /* ---- R9 proctoring ---- */
  async proctoring(req, f) {
    const exams = await examScope(req, f);
    const examIds = exams.map((e) => e._id);
    const byExam = new Map(exams.map((e) => [String(e._id), e]));

    const attempts = await Attempt.find({
      examId: { $in: examIds }, 'violations.0': { $exists: true },
    }).populate('studentId', 'name regNo').populate('roomId', 'name').lean();

    const rows = [];
    const tally = {};

    for (const a of attempts) {
      const ex = byExam.get(String(a.examId));
      for (const v of a.violations || []) {
        tally[v.type] = (tally[v.type] || 0) + 1;
        rows.push({
          date: ex?.date || '',
          exam: ex ? ex.code : '',
          room: a.roomId?.name || '',
          regNo: a.studentId?.regNo || '',
          name: a.studentId?.name || '',
          event: VIOLATION_CATALOGUE[v.type]?.label || v.type,
          severity: v.severity,
          weight: v.weight,
          at: new Date(v.at).toLocaleString('en-GB'),
          outcome: a.status === 'terminated' ? 'Attempt ended' : 'Recorded',
        });
      }
    }
    rows.sort((x, y) => y.at.localeCompare(x.at));

    return {
      title: 'Proctoring and violations',
      subtitle: `${rows.length} event(s) across ${attempts.length} attempt(s)`,
      columns: [T('date', 'Date'), T('exam', 'Exam'), T('room', 'Room'),
        T('regNo', 'Register number'), T('name', 'Name'), T('event', 'Event'),
        T('severity', 'Severity'), N('weight', 'Weight'), T('at', 'Recorded at'), T('outcome', 'Outcome')],
      rows,
      extra: {
        title: 'By event type',
        columns: [T('event', 'Event'), T('severity', 'Severity'), N('count', 'Occurrences')],
        rows: Object.entries(tally)
          .map(([k, count]) => ({
            event: VIOLATION_CATALOGUE[k]?.label || k,
            severity: VIOLATION_CATALOGUE[k]?.severity || '',
            count,
          }))
          .sort((x, y) => y.count - x.count),
      },
      summary: {
        Events: rows.length,
        'Attempts affected': attempts.length,
        'Attempts ended': attempts.filter((a) => a.status === 'terminated').length,
        Critical: rows.filter((x) => x.severity === 'critical').length,
      },
    };
  },

  /* ---- R10 consolidated ---- */
  async consolidated(req, f) {
    const exams = await examScope(req, f);
    const departments = await Department.find(tenant(req)).lean();
    const subjects = await Subject.find(tenant(req)).select('departmentId').lean();
    const deptOfSubject = Object.fromEntries(subjects.map((s) => [String(s._id), String(s.departmentId)]));

    const rows = [];
    for (const d of departments) {
      const deptExams = exams.filter((e) => deptOfSubject[String(e.subjectId?._id)] === String(d._id));
      if (!deptExams.length) continue;

      const attempts = await Attempt.find({ examId: { $in: deptExams.map((e) => e._id) } }).lean();
      const evaluated = attempts.filter((a) => a.evaluation?.state === 'submitted');
      const passed = evaluated.filter((a) => a.marks?.passed).length;
      const totals = evaluated.map((a) => a.marks?.total ?? 0);

      rows.push({
        department: d.name, code: d.code,
        examinations: deptExams.length,
        scheduled: attempts.length,
        appeared: attempts.filter((a) => a.status !== 'not_started').length,
        evaluated: evaluated.length,
        passed, failed: evaluated.length - passed,
        passRate: pct(passed, evaluated.length),
        mean: totals.length ? round(totals.reduce((s, n) => s + n, 0) / totals.length) : 0,
        violations: attempts.reduce((s, a) => s + (a.violations?.length || 0), 0),
        disqualified: attempts.filter((a) => a.status === 'terminated').length,
      });
    }

    const inst = await Institution.findById(req.actor.institutionId).lean();

    return {
      title: 'Consolidated statement',
      subtitle: `${inst?.name || ''} · ${rows.length} department(s)`,
      columns: [T('department', 'Department'), T('code', 'Code'), N('examinations', 'Examinations'),
        N('scheduled', 'Scheduled'), N('appeared', 'Appeared'), N('evaluated', 'Evaluated'),
        N('passed', 'Passed'), N('failed', 'Failed'), N('passRate', 'Pass %'), N('mean', 'Mean'),
        N('violations', 'Violations'), N('disqualified', 'Disqualified')],
      rows,
      summary: {
        Departments: rows.length,
        Examinations: rows.reduce((s, x) => s + x.examinations, 0),
        Scheduled: rows.reduce((s, x) => s + x.scheduled, 0),
        Appeared: rows.reduce((s, x) => s + x.appeared, 0),
        'Licences consumed': inst?.licence?.consumed ?? 0,
      },
    };
  },
};

/* ============================================================
   RUN + EXPORT
   ============================================================ */
r.get('/:key', can('report:view'), wrap(async (req, res) => {
  const build = builders[req.params.key];
  if (!build) throw notFound(`No report called "${req.params.key}"`);

  const f = parse(filterSchema, req.query);
  const out = await build(req, f);

  res.json({
    ...out,
    key: req.params.key,
    generatedAt: new Date(),
    filters: f,
  });
}));

r.get('/:key/export', can('report:view'), wrap(async (req, res) => {
  const build = builders[req.params.key];
  if (!build) throw notFound(`No report called "${req.params.key}"`);

  const format = (req.query.format || 'csv').toLowerCase();
  if (format !== 'csv') {
    throw badRequest('Only CSV export is available in this build. It opens directly in Excel.');
  }

  const f = parse(filterSchema, req.query);
  const out = await build(req, f);

  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [];
  lines.push(esc(out.title));
  if (out.subtitle) lines.push(esc(out.subtitle));
  lines.push(esc(`Generated ${new Date().toLocaleString('en-GB')}`));
  lines.push('');
  lines.push(out.columns.map((c) => esc(c.label)).join(','));
  for (const row of out.rows) {
    lines.push(out.columns.map((c) => esc(row[c.key])).join(','));
  }
  if (out.summary) {
    lines.push('');
    lines.push('Summary');
    for (const [k, v] of Object.entries(out.summary)) lines.push(`${esc(k)},${esc(v)}`);
  }
  if (out.extra) {
    lines.push('');
    lines.push(esc(out.extra.title));
    lines.push(out.extra.columns.map((c) => esc(c.label)).join(','));
    for (const row of out.extra.rows) {
      lines.push(out.extra.columns.map((c) => esc(row[c.key])).join(','));
    }
  }

  const name = `${req.params.key}-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send('\uFEFF' + lines.join('\n'));   // BOM so Excel reads UTF-8
}));

export default r;
