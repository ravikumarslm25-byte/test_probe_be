import mongoose from 'mongoose';

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
  answerCount: { type: Number },                   // best-N counted; desc only
  instruction: String,
}, { _id: false });

const examSchema = new Schema({
  institutionId: ref('Institution', { required: true }),
  subjectId: ref('Subject', { required: true }),
  batchIds:  [ref('Batch')],

  title: { type: String, required: true },
  code:  { type: String, required: true },
  type:  { type: String, enum: ['internal', 'model', 'end_semester'], default: 'internal' },

  date:            { type: String, required: true },  // YYYY-MM-DD
  startTime:       { type: String, required: true },  // HH:mm
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
  publishedAt: Date,
  resultsPublishedAt: Date,
  createdBy: ref('User'),
}, { timestamps: true });

examSchema.index({ institutionId: 1, date: 1, status: 1 });

// Blueprint total must reconcile with totalMarks — guards against a
// paper being scheduled that cannot add up to the stated marks.
examSchema.methods.blueprintTotal = function () {
  return (this.blueprint?.sections || []).reduce((sum, s) => {
    const counted = s.type === 'desc' ? (s.answerCount || s.count) : s.count;
    return sum + counted * s.marksEach;
  }, 0);
};

examSchema.virtual('startAt').get(function () {
  return new Date(`${this.date}T${this.startTime}:00`);
});
examSchema.virtual('endAt').get(function () {
  return new Date(this.startAt.getTime() + this.durationMinutes * 60000);
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
  difficulty: { type: String, enum: ['easy', 'moderate', 'hard'], default: 'moderate' },
  createdBy: ref('User'),
}, { timestamps: true });
questionSchema.index({ institutionId: 1, examId: 1, section: 1, order: 1 });

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
  scanPages: [{ key: String, page: Number, uploadedAt: Date }],
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
    evaluatorId: { type: Types.ObjectId, ref: 'User' },
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
export const Audit    = model('Audit', auditSchema);
