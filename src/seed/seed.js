import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { connectDb } from '../config/db.js';
import {
  Institution, Role, User, Department, Batch, Subject, Mapping, Student,
} from '../models/core.js';
import { Exam, Question, Room, Attempt, Ticket, Audit } from '../models/exam.js';
import { SYSTEM_ROLES } from '../utils/permissions.js';
import { samplePaper } from '../data/sample-bank.js';

const AY = '2026-27';
/* Demo password for every seeded account. Local development uses a
   default; a production seed must set its own, so a publicly reachable
   server never carries a password printed in this repository. */
const PW = process.env.SEED_PASSWORD || 'TestProbe@2026';

const FIRST = ['Keerthana','Aravind','Divya','Surya','Nandhini','Karthik','Priyadharshini','Vignesh','Sandhiya','Mohan','Abinaya','Hariharan','Swetha','Gokul','Janani','Prasanth','Meenakshi','Rahul','Deepika','Ashwin','Yazhini','Naveen','Kavya','Balaji','Sneha','Manoj','Ramya','Vishal','Anitha','Sathish','Bhavana','Dinesh','Harini','Jeyanth','Kalaiselvi','Lokesh','Monisha','Nithish','Pavithra','Raghul'];
const LAST = ['R','S','K','M','P','V','A','N','T','B'];

const hash = (p) => bcrypt.hash(p, 10);

/* Refuses to wipe a database that already holds data unless the
   operator says so explicitly. Losing a real institution's exam
   records to a stray `npm run seed` is not a recoverable mistake. */
/* Runs before any connection is made, so a refused production seed
   says so at once instead of after a database timeout. */
function preflight() {
  /* Production is allowed only on purpose: an explicit flag, and a
     password of the operator's own choosing. The empty-database check
     below still applies on top of this. */
  if (process.env.NODE_ENV === 'production') {
    const allowed = process.argv.includes('--allow-production');
    if (!allowed) {
      console.error('\n[seed] NODE_ENV is production. Seeding creates demo accounts with a shared password.');
      console.error('       To set up a demonstration server on purpose, run:');
      console.error('         SEED_PASSWORD=\'a-strong-password\' npm run seed -- --allow-production\n');
      process.exit(1);
    }
    if (!process.env.SEED_PASSWORD || process.env.SEED_PASSWORD.length < 10) {
      console.error('\n[seed] a production seed needs SEED_PASSWORD of at least 10 characters.\n');
      process.exit(1);
    }
    console.log('[seed] production seed confirmed (--allow-production)');
  }
}

async function guard() {

  const counts = await Promise.all([
    Institution.countDocuments(), Student.countDocuments(), Attempt.countDocuments(),
  ]);
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return;

  const forced = process.argv.includes('--force') || process.env.SEED_CONFIRM === 'yes';
  if (!forced) {
    console.error('\n[seed] this database already holds data:');
    console.error(`        ${counts[0]} institution(s), ${counts[1]} student(s), ${counts[2]} attempt(s)`);
    console.error('\n        Seeding wipes all of it. If that is what you want, run:');
    console.error('          npm run seed -- --force\n');
    process.exit(1);
  }
  console.log('[seed] existing data will be replaced (--force)');
}

async function wipe() {
  await Promise.all([
    Institution.deleteMany({}), Role.deleteMany({}), User.deleteMany({}),
    Department.deleteMany({}), Batch.deleteMany({}), Subject.deleteMany({}),
    Mapping.deleteMany({}), Student.deleteMany({}),
    Exam.deleteMany({}), Question.deleteMany({}), Room.deleteMany({}),
    Attempt.deleteMany({}), Ticket.deleteMany({}), Audit.deleteMany({}),
  ]);
  console.log('[seed] cleared');
}

async function run() {
  const t0 = Date.now();
  preflight();
  await connectDb();
  await guard();
  await wipe();

  /* ---------- institution ---------- */
  const inst = await Institution.create({
    name: 'Sathyabama Institute of Science and Technology',
    shortName: 'Sathyabama',
    code: 'SIST',
    contactEmail: 'coe@sathyabama.ac.in',
    settings: {
      verificationWindowMinutes: 15,
      entryCutoffMinutes: 15,
      roomCapacity: 30,
      invigilatorRatio: 30,
      roomCloseBufferMinutes: 45,
      allowedPlatforms: ['windows'],
      evidenceRetentionDays: 120,
      captureIntervalSeconds: 20,
      enforcementMode: 'flag_only',
    },
    licence: { balance: 5000, reserved: 0, consumed: 0, mobileScanEnabled: true },
  });
  const t = { institutionId: inst._id };
  console.log('[seed] institution');

  /* ---------- roles ---------- */
  const roles = {};
  for (const spec of SYSTEM_ROLES) {
    const role = await Role.create({ ...spec, ...t });
    roles[spec.name] = role;
  }
  console.log(`[seed] ${Object.keys(roles).length} roles`);

  /* ---------- departments ---------- */
  const deptSpecs = [
    ['Computer Science & Engineering', 'CSE'],
    ['Information Technology', 'IT'],
    ['Electronics & Communication', 'ECE'],
    ['Mechanical Engineering', 'MECH'],
  ];
  const depts = {};
  for (const [name, code] of deptSpecs) {
    depts[code] = await Department.create({ ...t, name, code });
  }

  /* ---------- batches ---------- */
  const batchSpecs = [
    ['CSE', 'B.E. CSE', 3, 'A', 5], ['CSE', 'B.E. CSE', 3, 'B', 5],
    ['CSE', 'B.E. CSE', 1, 'A', 1],
    ['IT',  'B.Tech IT', 2, 'A', 3],
    ['ECE', 'B.E. ECE', 2, 'A', 3],
  ];
  const batches = [];
  for (const [dept, programme, year, section, semester] of batchSpecs) {
    batches.push(await Batch.create({
      ...t, departmentId: depts[dept]._id, programme, year, section,
      academicYear: AY, semester,
    }));
  }
  const [cseA, cseB, cse1A, it2A, ece2A] = batches;

  /* ---------- subjects ---------- */
  const subjectSpecs = [
    ['CSE', '19CSC201', 'Foundations of Computing', 5],
    ['CSE', '19CSC305', 'Database Management Systems', 5],
    ['CSE', '19MAB102', 'Engineering Mathematics II', 1],
    ['IT',  '19ITC304', 'Python Programming', 3],
    ['ECE', '19ECC202', 'Digital Electronics', 3],
  ];
  const subjects = {};
  for (const [dept, code, title, semester] of subjectSpecs) {
    subjects[code] = await Subject.create({
      ...t, departmentId: depts[dept]._id, code, title, semester, credits: 3,
    });
  }
  console.log('[seed] academic structure');

  /* ---------- staff ---------- */
  const passwordHash = await hash(PW);
  const staffSpecs = [
    ['STF-100', 'Platform Administrator', 'admin@sathyabama.ac.in', 'CSE', ['Administrator']],
    ['STF-142', 'Dr. A. Ramkumar', 'ramkumar@sathyabama.ac.in', 'CSE', ['Controller of Examinations']],
    ['STF-101', 'Dr. S. Ananth', 'ananth@sathyabama.ac.in', 'CSE', ['Examination Coordinator']],
    ['STF-118', 'Prof. R. Lakshmi', 'lakshmi@sathyabama.ac.in', 'CSE', ['Subject Staff', 'Evaluator', 'Class Advisor']],
    ['STF-124', 'Dr. M. Venkatesh', 'venkatesh@sathyabama.ac.in', 'IT', ['Subject Staff', 'Invigilator', 'Class Advisor']],
    ['STF-131', 'Prof. K. Bhuvaneswari', 'bhuvana@sathyabama.ac.in', 'ECE', ['Subject Staff', 'Invigilator']],
    ['STF-155', 'Prof. D. Sujatha', 'sujatha@sathyabama.ac.in', 'MECH', ['Invigilator', 'Evaluator']],
    ['STF-160', 'Prof. G. Kalyani', 'kalyani@sathyabama.ac.in', 'CSE', ['Invigilator', 'Evaluator']],
    ['STF-161', 'Dr. P. Srinivasan', 'srinivasan@sathyabama.ac.in', 'CSE', ['Invigilator']],
  ];
  const staff = {};
  for (const [employeeId, name, email, dept, roleNames] of staffSpecs) {
    staff[email] = await User.create({
      ...t, employeeId, name, email, passwordHash,
      departmentId: depts[dept]._id,
      roleIds: roleNames.map((n) => roles[n]._id),
      mustResetPassword: false,
      status: 'active',
    });
  }
  console.log(`[seed] ${staffSpecs.length} staff`);

  /* ---------- mappings ---------- */
  const mapSpecs = [
    ['lakshmi@sathyabama.ac.in', '19CSC201', cseA, 'subject_staff'],
    ['lakshmi@sathyabama.ac.in', '19CSC305', cseA, 'subject_staff'],
    ['lakshmi@sathyabama.ac.in', null,       cseA, 'class_advisor'],
    ['venkatesh@sathyabama.ac.in', '19ITC304', it2A, 'subject_staff'],
    ['venkatesh@sathyabama.ac.in', null,       it2A, 'class_advisor'],
    ['bhuvana@sathyabama.ac.in', '19ECC202', ece2A, 'subject_staff'],
  ];
  for (const [email, code, batch, kind] of mapSpecs) {
    await Mapping.create({
      ...t, staffId: staff[email]._id,
      subjectId: code ? subjects[code]._id : undefined,
      batchId: batch._id, kind, academicYear: AY,
    });
  }

  /* ---------- students ---------- */
  const studentDocs = [];
  let n = 0;
  for (const [batch, count, base] of [[cseA, 40, 41720104031], [it2A, 34, 41720105001], [ece2A, 28, 41720106001]]) {
    for (let i = 0; i < count; i++) {
      const regNo = String(base + i);
      studentDocs.push({
        ...t, regNo,
        name: `${FIRST[n % FIRST.length]} ${LAST[i % LAST.length]}`,
        email: `${regNo}@sathyabama.ac.in`,
        mobile: `98${String(40000000 + n).slice(0, 8)}`,
        batchId: batch._id,
        departmentId: batch.departmentId,
        passwordHash,
        photoKey: i % 4 === 3 ? undefined : `seed/photos/${regNo}.jpg`,
        idProofKey: i % 5 === 4 ? undefined : `seed/ids/${regNo}.jpg`,
      });
      n++;
    }
  }
  // one round trip instead of 102 — matters over Atlas latency
  const students = await Student.insertMany(studentDocs);
  console.log(`[seed] ${students.length} students`);

  /* ---------- the Sathyabama 50-mark blueprint ---------- */
  const blueprint = {
    sections: [
      { key: 'A', title: 'Part A — Multiple choice', type: 'mcq', count: 10, marksEach: 1,
        instruction: 'Answer all questions. Each question carries 1 mark.' },
      { key: 'B', title: 'Part B — Fill in the blanks', type: 'fib', count: 10, marksEach: 2,
        instruction: 'Answer all questions. Each question carries 2 marks.' },
      { key: 'C', title: 'Part C — Descriptive', type: 'desc', count: 4, marksEach: 10, answerCount: 2,
        instruction: 'Answer any two questions. Each question carries 10 marks.' },
    ],
  };

  const today = new Date();
  const iso = (offsetDays) => new Date(today.getTime() + offsetDays * 864e5).toISOString().slice(0, 10);

  const examSpecs = [
    { code: '19CSC201', subject: subjects['19CSC201'], batches: [cseA], title: 'Foundations of Computing',
      date: iso(0), startTime: '10:00', status: 'live' },
    { code: '19ITC304', subject: subjects['19ITC304'], batches: [it2A], title: 'Python Programming',
      date: iso(2), startTime: '14:00', status: 'scheduled' },
    { code: '19CSC305', subject: subjects['19CSC305'], batches: [cseA], title: 'Database Management Systems',
      date: iso(-5), startTime: '10:00', status: 'evaluation' },
    { code: '19ECC202', subject: subjects['19ECC202'], batches: [ece2A], title: 'Digital Electronics',
      date: iso(-9), startTime: '10:00', status: 'published' },
  ];

  const invigilators = ['venkatesh@sathyabama.ac.in', 'bhuvana@sathyabama.ac.in',
                        'sujatha@sathyabama.ac.in', 'kalyani@sathyabama.ac.in', 'srinivasan@sathyabama.ac.in'];

  for (const spec of examSpecs) {
    const exam = await Exam.create({
      ...t,
      subjectId: spec.subject._id,
      batchIds: spec.batches.map((b) => b._id),
      title: spec.title, code: spec.code, type: 'internal',
      date: spec.date, startTime: spec.startTime,
      durationMinutes: 120, totalMarks: 50, passMark: 20,
      blueprint,
      instructions: 'Read all questions before answering. Parts A and B close permanently once you enter Part C. Keep your face within the camera frame throughout. The room must remain silent.',
      status: spec.status,
      publishedAt: spec.status === 'draft' ? undefined : new Date(),
      sealedUntil: new Date(`${spec.date}T${spec.startTime}:00`),
      createdBy: staff['ananth@sathyabama.ac.in']._id,
    });

    await seedQuestions(exam, t, spec.code);

    // rooms
    const cohort = students.filter((s) => spec.batches.some((b) => String(b._id) === String(s.batchId)));
    const startAt = new Date(`${spec.date}T${spec.startTime}:00`);
    const endAt = new Date(startAt.getTime() + 120 * 60000);
    const roomCount = Math.ceil(cohort.length / 30);
    const roomDocs = [];
    for (let i = 0; i < roomCount; i++) {
      roomDocs.push({
        ...t, examId: exam._id,
        name: `Room ${i + 1}`, capacity: 30, startAt, endAt,
        invigilatorId: staff[invigilators[i % invigilators.length]]._id,
        studentIds: cohort.slice(i * 30, (i + 1) * 30).map((s) => s._id),
      });
    }
    const rooms = await Room.insertMany(roomDocs);

    // attempts — built in memory, written in one batch per exam
    const questions = await Question.find({ examId: exam._id }).sort({ section: 1, order: 1 }).lean();
    const attemptDocs = [];
    for (const room of rooms) {
      for (const [idx, sid] of room.studentIds.entries()) {
        attemptDocs.push(buildAttempt({ t, exam, room, sid, idx, questions, status: spec.status, startAt }));
      }
    }
    if (attemptDocs.length) await Attempt.insertMany(attemptDocs);

    if (spec.status !== 'draft') {
      await Institution.findByIdAndUpdate(inst._id, { $inc: { 'licence.reserved': cohort.length } });
    }
    console.log(`[seed] exam ${spec.code} · ${rooms.length} rooms · ${cohort.length} candidates`);
  }

  /* ---------- tickets ---------- */
  await Ticket.create([
    { ...t, ref: 'TK-4021', raisedBy: { kind: 'student', id: students[1]._id, name: students[1].name },
      category: 'device', subject: 'Camera not detected on the check screen',
      body: 'The system check says no camera found but it works in other applications.',
      diagnostics: { platform: 'Windows 11', browser: 'Chrome 129', camera: false, microphone: true, bandwidthMbps: 22 },
      priority: 'high', status: 'open' },
    { ...t, ref: 'TK-4020', raisedBy: { kind: 'student', id: students[2]._id, name: students[2].name },
      category: 'access', subject: 'Exam link opens a blank page',
      priority: 'high', status: 'open' },
    { ...t, ref: 'TK-4018', raisedBy: { kind: 'student', id: students[5]._id, name: students[5].name },
      category: 'schedule', subject: 'Requesting a change of examination slot',
      priority: 'low', status: 'resolved', resolvedAt: new Date() },
  ]);

  console.log('\n──────────────────────────────────────────');
  console.log(` Test Probe seed complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('──────────────────────────────────────────');
  console.log(' Staff sign in (all use the same password):');
  staffSpecs.forEach(([, name, email, , r]) => console.log(`   ${email.padEnd(34)} ${r.join(', ')}`));
  console.log(`\n   Password: ${PW}`);
  console.log(`\n Student sign in:`);
  console.log(`   Register number: ${students[0].regNo}   Password: ${PW}`);
  console.log('──────────────────────────────────────────\n');

  await mongoose.connection.close();
  process.exit(0);
}

/* ---------------- question content ---------------- */
async function seedQuestions(exam, t, subjectCode) {
  /* Drawn from the per-subject bank, so a Python paper asks about
     Python and a digital electronics paper about flip flops, rather
     than every subject receiving the same computer science set. */
  const rows = samplePaper(subjectCode, exam.blueprint);
  let order = 0;
  let lastSection = null;
  const docs = rows.map((r) => {
    if (r.section !== lastSection) { order = 0; lastSection = r.section; }
    return { ...t, examId: exam._id, subjectId: exam.subjectId, order: order++, ...r };
  });
  await Question.insertMany(docs);
  return docs.length;
}

function buildAttempt({ t, exam, room, sid, idx, questions, status, startAt }) {
  const base = {
    ...t, examId: exam._id, roomId: room._id, studentId: sid, setLabel: 'A',
  };

  if (status === 'scheduled') return { ...base, status: 'not_started' };

  const answers = [];
  let a = 0, b = 0, c = 0;

  for (const q of questions) {
    if (q.section === 'A') {
      const right = (idx + q.order) % 3 !== 0;
      const chosen = right ? q.correctOptions[0] : q.options[(q.order + 1) % 4].key;
      const awarded = right ? q.marks : 0;
      a += awarded;
      answers.push({ questionId: q._id, section: 'A', selected: [chosen], mode: 'typed',
        autoAwarded: awarded, awarded, answeredAt: new Date() });
    }
    if (q.section === 'B') {
      const right = (idx + q.order) % 4 !== 0;
      const text = right ? q.acceptedAnswers[0] : 'not sure';
      const awarded = right ? q.marks : 0;
      b += awarded;
      answers.push({ questionId: q._id, section: 'B', text, mode: 'typed',
        autoAwarded: awarded, awarded, needsReview: !right, answeredAt: new Date() });
    }
    if (q.section === 'C' && q.order < 2) {
      const scanned = idx % 3 === 0;
      const hits = q.keywords.slice(0, 4).map((k) => k.term);
      const suggested = Math.round(q.marks * 0.65 * 2) / 2;
      const evaluated = ['evaluation', 'published'].includes(status) && idx % 3 !== 1;
      const awarded = evaluated ? Math.min(q.marks, suggested + (idx % 3)) : undefined;
      if (evaluated) c += awarded;
      answers.push({
        questionId: q._id, section: 'C',
        mode: scanned ? 'scanned' : 'typed',
        html: scanned ? undefined : `<p>${hits.join('. ')}. The model is applied in stages and each stage is reviewed before the next begins.</p>`,
        scanPages: scanned ? [1, 2, 3].map((p) => ({ key: `seed/scans/${sid}-${q.order}-${p}.jpg`, page: p, uploadedAt: new Date() })) : [],
        suggested, keywordHits: hits, awarded,
        countedInBestN: true, answeredAt: new Date(),
      });
    }
  }

  const violations = [];
  let flagScore = 0;
  if (idx % 7 === 3) {
    violations.push({ type: 'looking_away', severity: 'medium', weight: 1, at: new Date(startAt.getTime() + 12 * 60000) });
    flagScore += 1;
  }
  if (idx % 11 === 9) {
    violations.push({ type: 'multiple_faces', severity: 'critical', weight: 3, at: new Date(startAt.getTime() + 24 * 60000) });
    flagScore += 3;
  }
  if (idx % 13 === 5) {
    violations.push({ type: 'room_noise', severity: 'medium', weight: 1, at: new Date(startAt.getTime() + 31 * 60000) });
    flagScore += 1;
  }

  const total = a + b + c;
  const evalState = status === 'published' ? 'submitted'
    : status === 'evaluation' ? (idx % 3 === 1 ? 'pending' : 'submitted')
    : 'pending';

  return {
    ...base,
    status: status === 'live' ? (idx % 12 === 11 ? 'submitted' : 'in_progress') : 'submitted',
    joinedAt: startAt,
    startedAt: startAt,
    timerEndsAt: new Date(startAt.getTime() + exam.durationMinutes * 60000),
    submittedAt: status === 'live' ? undefined : new Date(startAt.getTime() + 105 * 60000),
    identity: { faceKey: `seed/face/${sid}.jpg`, idCardKey: `seed/id/${sid}.jpg`, verifiedAt: startAt },
    environment: { platform: 'Windows 11', browser: 'Chrome 129', screen: '1920x1080', displays: 1, virtualMachine: false },
    sectionState: { current: status === 'live' ? 'C' : 'C', lockedSections: ['A', 'B'], gatePassedAt: startAt },
    answers, violations, flagScore,
    marks: {
      sectionA: a, sectionB: b, sectionC: c, total,
      passed: total >= exam.passMark,
    },
    evaluation: { state: evalState, submittedAt: evalState === 'submitted' ? new Date() : undefined },
    resultPublishedAt: status === 'published' ? new Date() : undefined,
    licenceConsumed: true,
  };
}

run().catch(async (e) => {
  console.error('[seed] failed', e);
  await mongoose.connection.close();
  process.exit(1);
});
