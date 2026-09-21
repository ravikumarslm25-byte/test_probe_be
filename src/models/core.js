import mongoose from 'mongoose';

const { Schema, model, Types } = mongoose;

/* ============================================================
   Every document carries institutionId. The platform is
   multi-tenant from day one so the same deployment can serve
   additional institutions without a data migration.
   ============================================================ */

const ref = (name, opts = {}) => ({ type: Types.ObjectId, ref: name, index: true, ...opts });

/* ---------------- Institution ---------------- */
const institutionSchema = new Schema({
  name:      { type: String, required: true, trim: true },
  shortName: { type: String, required: true, trim: true },
  code:      { type: String, required: true, unique: true, uppercase: true, trim: true },
  contactEmail: String,

  settings: {
    verificationWindowMinutes: { type: Number, default: 15 },
    entryCutoffMinutes:        { type: Number, default: 15 },
    roomCapacity:              { type: Number, default: 30 },
    invigilatorRatio:          { type: Number, default: 30 },
    roomCloseBufferMinutes:    { type: Number, default: 45 },
    allowedPlatforms:          { type: [String], default: ['windows'] },
    evidenceRetentionDays:     { type: Number, default: 120 },
    captureIntervalSeconds:    { type: Number, default: 20 },

    /* flag_only records every violation but never ends an attempt.
       It is the default because a platform being evaluated must be
       testable: a second monitor or a tab switch should be visible,
       not a dead end. Switch to terminate before a real examination. */
    enforcementMode: { type: String, enum: ['flag_only', 'terminate'], default: 'flag_only' },
  },

  licence: {
    balance:   { type: Number, default: 0 },
    reserved:  { type: Number, default: 0 },
    consumed:  { type: Number, default: 0 },
    mobileScanEnabled: { type: Boolean, default: true },
  },
}, { timestamps: true });

/* ---------------- Role ----------------
   Permissions are "module:action" strings. Scope is applied
   separately from permission, exactly as the proposal states. */
const roleSchema = new Schema({
  institutionId: ref('Institution', { required: true }),
  name:        { type: String, required: true, trim: true },
  description: String,
  permissions: { type: [String], default: [] },
  scope:       { type: String, enum: ['institution', 'department', 'own'], default: 'own' },
  isSystem:    { type: Boolean, default: false },
}, { timestamps: true });
roleSchema.index({ institutionId: 1, name: 1 }, { unique: true });

/* ---------------- User (staff) ---------------- */
const userSchema = new Schema({
  institutionId: ref('Institution', { required: true }),
  employeeId: { type: String, trim: true },
  name:       { type: String, required: true, trim: true },
  email:      { type: String, required: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  mobile:     String,
  departmentId: ref('Department'),
  roleIds:    [ref('Role')],
  status:     { type: String, enum: ['active', 'inactive'], default: 'active' },
  mustResetPassword: { type: Boolean, default: true },
  lastLoginAt: Date,
  refreshTokenHash: { type: String, select: false },
}, { timestamps: true });
userSchema.index({ institutionId: 1, email: 1 }, { unique: true });

/* ---------------- Department / Batch / Subject ---------------- */
const departmentSchema = new Schema({
  institutionId: ref('Institution', { required: true }),
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, uppercase: true, trim: true },
  hodId: ref('User'),
}, { timestamps: true });
departmentSchema.index({ institutionId: 1, code: 1 }, { unique: true });

const batchSchema = new Schema({
  institutionId: ref('Institution', { required: true }),
  departmentId:  ref('Department', { required: true }),
  programme: { type: String, required: true },   // B.E. / B.Tech
  year:      { type: Number, required: true },   // 1..4
  section:   { type: String, default: 'A' },
  academicYear: { type: String, required: true },// 2026-27
  semester:  { type: Number, required: true },
  label:     { type: String },                   // derived, human readable
}, { timestamps: true });
batchSchema.index({ institutionId: 1, departmentId: 1, year: 1, section: 1, academicYear: 1 }, { unique: true });
batchSchema.pre('validate', function (next) {
  if (!this.label) {
    const ord = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV' }[this.year] || this.year;
    this.label = `${ord} Year ${this.programme} — Section ${this.section}`;
  }
  next();
});

const subjectSchema = new Schema({
  institutionId: ref('Institution', { required: true }),
  departmentId:  ref('Department', { required: true }),
  code:  { type: String, required: true, uppercase: true, trim: true },
  title: { type: String, required: true, trim: true },
  credits:  { type: Number, default: 3 },
  semester: { type: Number, required: true },
}, { timestamps: true });
subjectSchema.index({ institutionId: 1, code: 1 }, { unique: true });

/* ---------------- Mapping: staff ↔ subject ↔ batch ----------------
   This single collection drives every scoping decision in the
   platform. A subject staff member sees a student only if a
   mapping row connects them.                                    */
const mappingSchema = new Schema({
  institutionId: ref('Institution', { required: true }),
  staffId:   ref('User', { required: true }),
  subjectId: ref('Subject'),
  batchId:   ref('Batch', { required: true }),
  kind: { type: String, enum: ['subject_staff', 'class_advisor'], required: true },
  academicYear: { type: String, required: true },
}, { timestamps: true });
mappingSchema.index({ institutionId: 1, staffId: 1, subjectId: 1, batchId: 1, academicYear: 1 }, { unique: true });

/* ---------------- Student ---------------- */
const studentSchema = new Schema({
  institutionId: ref('Institution', { required: true }),
  regNo: { type: String, required: true, trim: true },
  name:  { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  mobile: String,
  batchId:      ref('Batch', { required: true }),
  departmentId: ref('Department', { required: true }),
  passwordHash: { type: String, select: false },
  photoKey:   String,
  idProofKey: String,
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  refreshTokenHash: { type: String, select: false },
}, { timestamps: true });
studentSchema.index({ institutionId: 1, regNo: 1 }, { unique: true });

export const Institution = model('Institution', institutionSchema);
export const Role        = model('Role', roleSchema);
export const User        = model('User', userSchema);
export const Department  = model('Department', departmentSchema);
export const Batch       = model('Batch', batchSchema);
export const Subject     = model('Subject', subjectSchema);
export const Mapping     = model('Mapping', mappingSchema);
export const Student     = model('Student', studentSchema);
