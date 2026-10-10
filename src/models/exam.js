import mongoose from 'mongoose';
import { zonedToUtc, DEFAULT_TIMEZONE } from '../utils/time.js';

const { Schema, model, Types } = mongoose;
const ref = (name, opts = {}) => ({ type: Types.ObjectId, ref: name, index: true, ...opts });

/* ---------------- Exam ----------------
   The blueprint is fixed by the examination coordinator.
   Subject staff author questions against it and cannot deviate. */
const blueprintSection = new Schema({
  key:   { type: String, enum: ['A', 'B', 'C'], required: true },
  title: { type: String, required: true },
  type:  { type: String, enum: ['mcq', 'fib', 'desc'], required: true },
  count:       { type: Number, required: true },   // questions set
  marksEach:   { type: Number, required: true },
  answerCount: { type: Number },                   // how many are counted; desc only
  /* HOW the candidate chooses, which is not the same question as how
     many they answer:
       best_n     answer as many as you like, the best N count
       any_n      answer any N — and only N; the rest close
       either_or  questions stand in pairs; one from each pair
     Defaulted to best_n so papers set before this existed keep
     behaving exactly as they did. New papers are built as any_n. */
  choiceMode: { type: String, enum: ['best_n', 'any_n', 'either_or'], default: 'best_n' },
  instruction: String,
}, { _id: false });

const examSchema = new Schema({
  institutionId: ref('Institution', { required: true }),
  subjectId: ref('Subject', { required: true }),
  batchIds:  [ref('Batch')],

  title: { type: String, required: true },
  code:  { type: String, required: true },
  type:  { type: String, enum: ['internal', 'model', 'end_semester'], default: 'internal' },

  date:            { type: String, required: true },  // YYYY-MM-DD, as the institution writes it
  startTime:       { type: String, required: true },  // HH:mm, wall clock in `timezone`

  /* The zone those two are read in, copied from the institution when
     the paper is created. Kept on the paper so a scheduled
     examination keeps its instant even if the institution's zone is
     changed later. */
  timezone:        { type: String, default: DEFAULT_TIMEZONE },

  /* The single true instant the paper begins, derived from the three
     fields above. Every comparison in the product uses this; nothing
     re-reads a wall clock against the server's own zone. */
  startsAt:        { type: Date, index: true },
  durationMinutes: { type: Number, required: true },
  totalMarks:      { type: Number, required: true },
  passMark:        { type: Number, required: true },

  blueprint: { sections: [blueprintSection] },

  proctoring: {
    enabled:        { type: Boolean, default: true },
    faceTracking:   { type: Boolean, default: true },
    idVerification: { type: Boolean, default: true },
    audioMonitoring:{ type: Boolean, default: true },
    browserLock:    { type: Boolean, default: true },
    mobileScan:     { type: Boolean, default: true },
    freehandCanvas: { type: Boolean, default: false },
    allowedPlatforms:       { type: [String], default: ['windows'] },
    lookAwaySeconds:        { type: Number, default: 5 },
    captureIntervalSeconds: { type: Number, default: 20 },
    flagCeiling:            { type: Number, default: 3 },
    terminateOnCeiling:     { type: Boolean, default: true },
  },

  randomisation: {
    shuffleQuestions: { type: Boolean, default: false },
    shuffleOptions:   { type: Boolean, default: false },
    paperSets:        { type: [String], default: ['A'] },
  },

  instructions: String,

  status: {
    type: String,
    enum: ['draft', 'scheduled', 'live', 'closed', 'evaluation', 'published'],
    default: 'draft', index: true,
  },
  sealedUntil: Date,
  /* How many candidates have a window of their own, and when the last
     of them finishes. Kept on the paper so its status can be derived
     without counting attempts on every read — a paper whose alternate
     sitting runs to 16:00 must not file itself under past papers at
     12:45 and take the invigilator's wall with it. */
  alternateSittings: { type: Number, default: 0 },
  lastSittingEndsAt: Date,

  /* The last moment ANYONE may still legitimately be writing: the
     paper's own end, the latest alternate sitting, or the latest
     extension an invigilator has granted. The status is derived from
     this rather than from the paper's nominal end, so a paper does
     not read "In progress" while nobody is in the hall — nor go quiet
     while two people are finishing on extra time. */
  writingUntil: Date,

  /* Ended by hand, from the wall or the examinations list. Once set,
     the paper is over whatever the clock says. */
  closedAt: Date,
  closedBy: ref('User'),
  closeReason: String,
  publishedAt: Date,
  resultsPublishedAt: Date,
  createdBy: ref('User'),
}, { timestamps: true });

examSchema.index({ institutionId: 1, date: 1, status: 1 });

// Blueprint total must reconcile with totalMarks — guards against a
// paper being scheduled that cannot add up to the stated marks.
examSchema.methods.blueprintTotal = function () {
  return (this.blueprint?.sections || []).reduce((sum, s) => {
    /* An either/or section is marked out of one answer per pair,
       whatever `answerCount` happens to hold — the questions are not
       loaded here, so the pairing is derived from the count, which is
       what the builder enforces. */
    const counted = s.type !== 'desc' ? s.count
      : s.choiceMode === 'either_or' ? Math.ceil(s.count / 2)
      : (s.answerCount || s.count);
    return sum + counted * s.marksEach;
  }, 0);
};

/* Derived, never typed in. Recomputed whenever the written date,
   time or zone changes, so the stored instant cannot drift from what
   the examination cell entered. */
examSchema.pre('validate', function (next) {
  if (this.isModified('date') || this.isModified('startTime')
      || this.isModified('timezone') || !this.startsAt) {
    const at = zonedToUtc(this.date, this.startTime, this.timezone);
    if (at) this.startsAt = at;
  }
  next();
});

examSchema.virtual('startAt').get(function () {
  return this.startsAt || zonedToUtc(this.date, this.startTime, this.timezone);
});
examSchema.virtual('endAt').get(function () {
  const s = this.startAt;
  return s ? new Date(s.getTime() + this.durationMinutes * 60000) : null;
});

/* ---------------- Question ---------------- */
const questionSchema = new Schema({
  institutionId: ref('Institution', { required: true }),
  subjectId: ref('Subject', { required: true }),
  examId:    ref('Exam'),                       // null = lives in the bank only
  section:   { type: String, enum: ['A', 'B', 'C'], required: true },
  type:      { type: String, enum: ['mcq', 'fib', 'desc'], required: true },
  order:     { type: Number, default: 0 },
  setLabel:  { type: String, default: 'A' },
  /* Which questions stand against each other under `either_or`. Only
     equality matters — two questions sharing a group are alternatives
     and the candidate answers one of them. Empty on every other kind
     of paper. */
  choiceGroup: String,

  text:  { type: String, required: true },
  marks: { type: Number, required: true },

  // mcq
  options: [{ key: String, text: String }],
  correctOptions: [String],
  multiSelect: { type: Boolean, default: false },

  // fib — auto-matched against these, case and space tolerant
  acceptedAnswers: [String],

  // desc — weighted keywords drive the suggested mark
  keywords: [{ term: String, weight: { type: Number, default: 1 } }],
  modelAnswer: String,
  markingGuidance: String,

  unit: String,
  topic: String,
  difficulty: { type: String, enum: ['easy', 'moderate', 'hard'], default: 'moderate' },
  createdBy: ref('User'),

  /* ---------------- the bank ----------------
     A question with no examId lives in the bank only. Subject staff
     write them weeks ahead, the examination cell approves them, and a
     paper is assembled from what is already approved — which is the
     whole point: the cell cannot be waiting on authors the week an
     examination is scheduled.

     A paper takes a COPY of the bank question, never a reference. A
     bank question edited or withdrawn next term must not alter a
     paper that has already been sat, and a paper needs its own order
     and set label. `sourceId` points back so the bank can show where
     a question has been used. */
  sourceId: ref('Question'),
  /* Which bulk upload a BANK question arrived in. A subject's bank is
     built over a term in several batches — one per unit, or one per
     member of staff — and the examination cell assembles a paper from
     a particular batch, not from an undifferentiated heap. Empty for
     a question written by hand. */
  uploadId: ref('QuestionUpload'),

  status: {
    type: String,
    enum: ['draft', 'pending_review', 'approved', 'rejected', 'retired'],
    default: 'draft',
    index: true,
  },
  reviewedBy:  ref('User'),
  reviewedAt:  Date,
  reviewNote:  String,
  submittedAt: Date,

  /* How many papers have drawn this question, so an author can see
     what is overused and a cell can retire a question that has been
     round too often. */
  usedCount: { type: Number, default: 0 },
  lastUsedAt: Date,
}, { timestamps: true });
questionSchema.index({ institutionId: 1, examId: 1, section: 1, order: 1 });
/* The bank's own read path: a subject's approved questions, newest first. */
questionSchema.index({ institutionId: 1, subjectId: 1, status: 1, examId: 1 });

/* ---------------- Room ---------------- */
const roomSchema = new Schema({
  institutionId: ref('Institution', { required: true }),
  examId: ref('Exam', { required: true }),
  name:   { type: String, required: true },
  capacity: { type: Number, default: 30 },
  startAt: { type: Date, required: true },
  endAt:   { type: Date, required: true },
  invigilatorId: ref('User'),
  studentIds: [ref('Student')],
}, { timestamps: true });
roomSchema.index({ institutionId: 1, examId: 1, name: 1 }, { unique: true });

/* ---------------- Attempt ---------------- */
const answerSchema = new Schema({
  questionId: { type: Types.ObjectId, ref: 'Question', required: true },
  section: String,
  selected: [String],        // mcq
  text: String,              // fib / typed desc
  html: String,              // rich text desc
  /* `mime` matters: a page uploaded from a phone scanner is a PDF,
     and the evaluator's viewer has to know not to render it in an
     <img>. Older rows have no mime and are images by definition. */
  scanPages: [{ key: String, page: Number, uploadedAt: Date, mime: String, bytes: Number, name: String }],
  /* Pages the candidate took off this answer to type instead. Kept
     rather than deleted: they are a record of what was uploaded
     during the examination, and that is not a candidate's to erase. */
  removedScanPages: [{ key: String, page: Number, uploadedAt: Date, mime: String, bytes: Number, name: String }],
  mode: { type: String, enum: ['typed', 'scanned', 'mixed'], default: 'typed' },
  markedForReview: { type: Boolean, default: false },
  answeredAt: Date,

  // grading
  autoAwarded: Number,
  awarded: Number,
  suggested: Number,
  keywordHits: [String],
  remarks: String,
  needsReview: { type: Boolean, default: false },
  countedInBestN: { type: Boolean, default: true },
}, { _id: false });

const violationSchema = new Schema({
  type: { type: String, required: true },
  severity: { type: String, enum: ['info', 'medium', 'high', 'critical'], default: 'medium' },
  weight: { type: Number, default: 1 },
  at: { type: Date, default: Date.now },
  screenKey: String,
  cameraKey: String,
  audioKey: String,
  note: String,
}, { _id: false });

const attemptSchema = new Schema({
  institutionId: ref('Institution', { required: true }),
  examId:    ref('Exam', { required: true }),
  roomId:    ref('Room'),
  studentId: ref('Student', { required: true }),
  setLabel:  { type: String, default: 'A' },

  status: {
    type: String,
    enum: ['not_started', 'verifying', 'in_progress', 'submitted', 'flagged', 'terminated', 'absent'],
    default: 'not_started', index: true,
  },

  joinedAt: Date,
  startedAt: Date,
  timerEndsAt: Date,         // computed from actual join, capped at room close
  submittedAt: Date,
  autoSubmitted: { type: Boolean, default: false },

  identity: {
    faceKey: String,
    idCardKey: String,
    verifiedAt: Date,
    verifiedBy: { type: Types.ObjectId, ref: 'User' },
  },

  environment: {
    platform: String, browser: String, screen: String,
    ip: String, location: { lat: Number, lng: Number },
    displays: Number, virtualMachine: Boolean,
  },

  sectionState: {
    current: { type: String, default: 'A' },
    lockedSections: { type: [String], default: [] },   // one-way gate
    gatePassedAt: Date,
  },

  scanWindows: [{ questionId: Types.ObjectId, openedAt: Date, closedAt: Date, pages: Number }],

  answers: [answerSchema],
  violations: [violationSchema],
  flagScore: { type: Number, default: 0 },

  chat: [{
    from: { type: String, enum: ['student', 'invigilator'] },
    body: String,
    at: { type: Date, default: Date.now },
    readByStudent: { type: Boolean, default: false },
  }],
  micGrantedUntil: Date,

  /* Latest interval capture, kept on the attempt so the monitoring
     wall can render 30 tiles from one query instead of 30 lookups. */
  latestFrame: { key: String, at: Date },
  lastSeenAt: Date,

  /* The interval capture timeline. Evidence was being written to
     storage with nothing recording where it went, so there was no way
     to review an attempt after the fact. A capture taken within a few
     seconds of a violation is marked, which is what lets a reviewer
     see the moment rather than hunt for it. */
  captures: [{
    key: String,
    at: Date,
    kind: { type: String, enum: ['frame', 'screen'], default: 'frame' },
    flagged: { type: Boolean, default: false },
    violationType: String,
  }],

  warnings: [{
    by: { type: Types.ObjectId, ref: 'User' },
    byName: String,
    body: String,
    at: { type: Date, default: Date.now },
    acknowledgedAt: Date,
  }],

  timeExtension: {
    minutes: Number,
    reason: String,
    approvedBy: { type: Types.ObjectId, ref: 'User' },
    at: Date,
  },

  marks: {
    sectionA: { type: Number, default: 0 },
    sectionB: { type: Number, default: 0 },
    sectionC: { type: Number, default: 0 },
    total:    { type: Number, default: 0 },
    passed:   { type: Boolean, default: false },
  },

  evaluation: {
    state: { type: String, enum: ['pending', 'in_review', 'submitted'], default: 'pending', index: true },
    /* Who this script is ALLOCATED to. Allocation happens after the
       examination, not when the paper is built: until the sitting is
       over nobody knows how many scripts there are, how many were
       terminated, or which staff are free that week. Empty means
       nobody has been given it yet. */
    evaluatorId: { type: Types.ObjectId, ref: 'User', index: true },
    allocatedBy: { type: Types.ObjectId, ref: 'User' },
    allocatedAt: Date,
    /* Who actually entered and submitted the marks. Normally the
       allocated evaluator; the examination cell can step in, and the
       record should say so. */
    submittedBy: { type: Types.ObjectId, ref: 'User' },
    submittedAt: Date,
    cycles: [{
      cycle: Number,
      initiatedBy: { type: Types.ObjectId, ref: 'User' },
      evaluatorId: { type: Types.ObjectId, ref: 'User' },
      reason: String,
      previousTotal: Number,
      newTotal: Number,
      at: { type: Date, default: Date.now },
    }],
  },

  /* A window of this candidate's own.

     Not an extension — an extension stretches the examination's
     window and still hangs off its start. This REPLACES it: the same
     paper, the same marks, the same proctoring, at a time arranged
     for one candidate who cannot sit with the hall. Empty for
     everyone else, which is almost everyone. */
  sitting: {
    startsAt: { type: Date, index: true },
    durationMinutes: Number,          // defaults to the examination's
    reason: String,
    grantedBy: { type: Types.ObjectId, ref: 'User' },
    grantedAt: Date,
  },

  resultPublishedAt: Date,
  licenceConsumed: { type: Boolean, default: false },
  terminationReason: String,
}, { timestamps: true });

attemptSchema.index({ institutionId: 1, examId: 1, studentId: 1 }, { unique: true });
attemptSchema.index({ institutionId: 1, examId: 1, 'evaluation.state': 1 });

/* ---------------- Ticket ---------------- */
const ticketSchema = new Schema({
  institutionId: ref('Institution', { required: true }),
  ref: { type: String, required: true, unique: true },
  raisedBy: {
    kind: { type: String, enum: ['student', 'staff'], required: true },
    id:   { type: Types.ObjectId, required: true },
    name: String,
  },
  examId: ref('Exam'),
  category: { type: String, enum: ['access', 'device', 'schedule', 'result', 'other'], default: 'other' },
  subject: { type: String, required: true },
  body: String,
  diagnostics: {
    platform: String, browser: String, screen: String,
    camera: Boolean, microphone: Boolean, bandwidthMbps: Number,
  },
  priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
  status:   { type: String, enum: ['open', 'in_progress', 'resolved', 'closed'], default: 'open', index: true },
  assignedTo: ref('User'),
  thread: [{
    from: String, body: String, at: { type: Date, default: Date.now },
  }],
  resolvedAt: Date,
}, { timestamps: true });

/* ---------------- Audit ----------------
   Every privileged action lands here. This is what lets the
   Controller answer a challenge to any result.                */
/* ---------------- A batch of uploaded questions ----------------
   One spreadsheet, uploaded once. Kept as a record of its own so the
   bank can be read the way it was built — "Unit I and II, uploaded by
   Dr Mani on 3 October, 40 questions" — rather than as four hundred
   undifferentiated rows. Deleting the batch record never deletes its
   questions; it is a label, not an owner. */
const questionUploadSchema = new Schema({
  institutionId: ref('Institution', { required: true }),
  subjectId: ref('Subject', { required: true }),
  label:     { type: String, required: true },
  fileName:  String,
  count:     { type: Number, default: 0 },
  bySection: { A: { type: Number, default: 0 }, B: { type: Number, default: 0 }, C: { type: Number, default: 0 } },
  units:     [String],
  createdBy: ref('User'),
}, { timestamps: true });
questionUploadSchema.index({ institutionId: 1, subjectId: 1, createdAt: -1 });

/* ---------------- Upload pass ----------------
   The candidate's answer arrives from their own phone, not from the
   examination machine. Rather than ship a mobile application, the
   examination page shows a QR code; the phone opens the address
   inside it and uploads there.

   The token in that address IS the credential — the phone is not
   signed in and must not have to be, in a hall where three hundred
   candidates are each holding one. So the token is single-purpose and
   short-lived: one attempt, one question, a handful of files, and
   gone within minutes. `expiresAt` carries a TTL index, so an unused
   pass removes itself rather than lingering as a way into a script.  */
const uploadPassSchema = new Schema({
  institutionId: ref('Institution', { required: true }),
  token:      { type: String, required: true, unique: true },
  attemptId:  ref('Attempt', { required: true }),
  examId:     ref('Exam', { required: true }),
  studentId:  ref('Student', { required: true }),
  questionId: ref('Question', { required: true }),
  section:    String,
  questionNumber: Number,
  files: [{ key: String, mime: String, bytes: Number, name: String, uploadedAt: Date }],
  maxFiles:  { type: Number, default: 6 },
  closedAt:  Date,
  usedFromIp: String,
  usedFromAgent: String,
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
uploadPassSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
uploadPassSchema.index({ attemptId: 1, questionId: 1 });

const auditSchema = new Schema({
  institutionId: ref('Institution', { required: true }),
  actorId:   { type: Types.ObjectId },
  actorKind: { type: String, enum: ['staff', 'student', 'system'], default: 'staff' },
  actorName: String,
  action:    { type: String, required: true, index: true },
  entity:    { type: String },
  entityId:  { type: Types.ObjectId },
  before:    Schema.Types.Mixed,
  after:     Schema.Types.Mixed,
  ip: String,
  at: { type: Date, default: Date.now, index: true },
}, { versionKey: false });

export const Exam     = model('Exam', examSchema);
export const Question = model('Question', questionSchema);
export const Room     = model('Room', roomSchema);
export const Attempt  = model('Attempt', attemptSchema);
export const Ticket   = model('Ticket', ticketSchema);
export const UploadPass = model('UploadPass', uploadPassSchema);
export const QuestionUpload = model('QuestionUpload', questionUploadSchema);
export const Audit    = model('Audit', auditSchema);
