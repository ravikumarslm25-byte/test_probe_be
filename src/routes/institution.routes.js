import { Router } from 'express';
import { Types } from 'mongoose';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import {
  Role, User, Student, Department, Batch, Subject, Mapping,
} from '../models/core.js';
import { Exam, Attempt } from '../models/exam.js';
import { authenticate, can, tenant, resolveScope, scopeStudents } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { wrap, notFound, badRequest, forbidden } from '../utils/http.js';
import { parse } from '../utils/validate.js';
import { ALL_PERMISSIONS, MODULES, ACTIONS } from '../utils/permissions.js';

const r = Router();
r.use(authenticate);

/* ============================ ROLES ============================ */

r.get('/roles', can('role:view', 'staff:view'), wrap(async (req, res) => {
  const roles = await Role.find(tenant(req)).sort({ isSystem: -1, name: 1 }).lean();

  // aggregate() performs no schema casting, so the tenant id has to be
  // an ObjectId here even though find() accepts the string form
  const counts = await User.aggregate([
    { $match: { institutionId: new Types.ObjectId(req.actor.institutionId) } },
    { $unwind: '$roleIds' },
    { $group: { _id: '$roleIds', n: { $sum: 1 } } },
  ]);
  const map = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));

  res.json({
    catalogue: { modules: MODULES, actions: ACTIONS, all: ALL_PERMISSIONS },
    roles: roles.map((x) => ({ ...x, id: String(x._id), users: map[String(x._id)] || 0 })),
  });
}));

const roleSchema = z.object({
  name: z.string().min(2, 'Give the role a name'),
  description: z.string().optional(),
  scope: z.enum(['institution', 'department', 'own']).default('own'),
  permissions: z.array(z.string()).default([]),
});

r.post('/roles', can('role:create'), wrap(async (req, res) => {
  const body = parse(roleSchema, req.body);
  const unknown = body.permissions.filter((p) => !ALL_PERMISSIONS.includes(p));
  if (unknown.length) throw badRequest('Unknown permissions', { permissions: unknown.join(', ') });

  const role = await Role.create({ ...body, ...tenant(req) });
  await audit(req, { action: 'role.created', entity: 'Role', entityId: role._id, after: body });
  res.status(201).json({ role: { ...role.toObject(), id: String(role._id) } });
}));

r.patch('/roles/:id', can('role:edit'), wrap(async (req, res) => {
  const role = await Role.findOne({ _id: req.params.id, ...tenant(req) });
  if (!role) throw notFound('Role not found');
  if (role.isSystem) throw forbidden('The Administrator role cannot be edited');

  const body = parse(roleSchema.partial(), req.body);
  const before = role.toObject();
  Object.assign(role, body);
  await role.save();

  await audit(req, { action: 'role.updated', entity: 'Role', entityId: role._id, before, after: role.toObject() });
  res.json({ role: { ...role.toObject(), id: String(role._id) } });
}));

r.delete('/roles/:id', can('role:delete'), wrap(async (req, res) => {
  const role = await Role.findOne({ _id: req.params.id, ...tenant(req) });
  if (!role) throw notFound('Role not found');
  if (role.isSystem) throw forbidden('System roles cannot be deleted');

  const inUse = await User.countDocuments({ roleIds: role._id });
  if (inUse) throw badRequest(`${inUse} staff member${inUse > 1 ? 's' : ''} still hold this role`);

  await role.deleteOne();
  await audit(req, { action: 'role.deleted', entity: 'Role', entityId: role._id, before: role.toObject() });
  res.json({ ok: true });
}));

/* ============================ STAFF ============================ */

r.get('/staff', can('staff:view'), wrap(async (req, res) => {
  const { q, departmentId, status } = req.query;
  const filter = { ...tenant(req) };
  if (departmentId) filter.departmentId = departmentId;
  if (status) filter.status = status;
  if (q) filter.$or = [
    { name: new RegExp(q, 'i') },
    { email: new RegExp(q, 'i') },
    { employeeId: new RegExp(q, 'i') },
  ];

  const staff = await User.find(filter)
    .populate('roleIds', 'name scope')
    .populate('departmentId', 'name code')
    .sort({ name: 1 }).limit(500).lean();

  res.json({
    staff: staff.map((s) => ({
      id: String(s._id),
      employeeId: s.employeeId,
      name: s.name,
      email: s.email,
      mobile: s.mobile,
      department: s.departmentId ? { id: String(s.departmentId._id), name: s.departmentId.name } : null,
      roles: (s.roleIds || []).map((x) => ({ id: String(x._id), name: x.name })),
      status: s.status,
      lastLoginAt: s.lastLoginAt,
    })),
  });
}));

const staffSchema = z.object({
  employeeId: z.string().optional(),
  name: z.string().min(2, 'Enter the full name'),
  email: z.string().email('Enter a valid institutional email'),
  mobile: z.string().optional(),
  departmentId: z.string().optional(),
  roleIds: z.array(z.string()).min(1, 'Assign at least one role'),
});

/* Temporary password is generated here and emailed in production.
   It is returned in the response only outside production so the
   POC can be demonstrated without a mail server. */
const tempPassword = () =>
  'Egx' + Math.random().toString(36).slice(2, 8) + Math.floor(10 + Math.random() * 89);

r.post('/staff', can('staff:create'), wrap(async (req, res) => {
  const body = parse(staffSchema, req.body);
  const temp = tempPassword();

  const user = await User.create({
    ...body,
    ...tenant(req),
    passwordHash: await bcrypt.hash(temp, 12),
    mustResetPassword: true,
  });

  await audit(req, { action: 'staff.created', entity: 'User', entityId: user._id, after: { email: body.email } });
  res.status(201).json({
    staff: { id: String(user._id), name: user.name, email: user.email },
    temporaryPassword: process.env.NODE_ENV === 'production' ? undefined : temp,
  });
}));

r.patch('/staff/:id', can('staff:edit'), wrap(async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, ...tenant(req) });
  if (!user) throw notFound('Staff member not found');

  const body = parse(staffSchema.partial().extend({
    status: z.enum(['active', 'inactive']).optional(),
  }), req.body);

  const before = { name: user.name, email: user.email, status: user.status, roleIds: user.roleIds };
  Object.assign(user, body);
  await user.save();

  await audit(req, { action: 'staff.updated', entity: 'User', entityId: user._id, before, after: body });
  res.json({ staff: { id: String(user._id), name: user.name, status: user.status } });
}));

r.post('/staff/:id/reset-password', can('staff:edit'), wrap(async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, ...tenant(req) });
  if (!user) throw notFound('Staff member not found');

  const temp = tempPassword();
  user.passwordHash = await bcrypt.hash(temp, 12);
  user.mustResetPassword = true;
  user.refreshTokenHash = undefined;
  await user.save();

  await audit(req, { action: 'staff.password_reset', entity: 'User', entityId: user._id });
  res.json({ ok: true, temporaryPassword: process.env.NODE_ENV === 'production' ? undefined : temp });
}));

/* Bulk upload — rows validated before anything is written, and a
   row-level error report returned so a partial file can be fixed. */
r.post('/staff/bulk', can('staff:create'), wrap(async (req, res) => {
  const rows = z.array(staffSchema).max(1000).parse(req.body?.rows || []);
  const errors = [];
  const ready = [];

  for (const [i, row] of rows.entries()) {
    const exists = await User.findOne({ email: row.email.toLowerCase(), ...tenant(req) }).lean();
    if (exists) { errors.push({ row: i + 1, email: row.email, error: 'Already on the system' }); continue; }
    ready.push(row);
  }

  const created = [];
  for (const row of ready) {
    const temp = tempPassword();
    const u = await User.create({
      ...row, ...tenant(req),
      passwordHash: await bcrypt.hash(temp, 12),
      mustResetPassword: true,
    });
    created.push({ id: String(u._id), email: u.email, temporaryPassword: temp });
  }

  await audit(req, { action: 'staff.bulk_created', entity: 'User', after: { count: created.length } });
  res.json({ created: created.length, errors, rows: process.env.NODE_ENV === 'production' ? undefined : created });
}));

/* ============================ STUDENTS ============================ */

r.get('/students', can('student:view'), wrap(async (req, res) => {
  const scope = await resolveScope(req.actor);
  const { q, batchId } = req.query;

  let filter = { ...tenant(req) };
  if (batchId) filter.batchId = batchId;
  filter = scopeStudents(filter, scope);
  if (q) filter.$or = [{ name: new RegExp(q, 'i') }, { regNo: new RegExp(q, 'i') }];

  const students = await Student.find(filter)
    .populate('batchId', 'label')
    .populate('departmentId', 'name')
    .sort({ regNo: 1 }).limit(1000).lean();

  res.json({
    students: students.map((s) => ({
      id: String(s._id),
      regNo: s.regNo, name: s.name, email: s.email, mobile: s.mobile,
      batch: s.batchId ? { id: String(s.batchId._id), label: s.batchId.label } : null,
      department: s.departmentId ? { id: String(s.departmentId._id), name: s.departmentId.name } : null,
      hasPhoto: Boolean(s.photoKey),
      hasIdProof: Boolean(s.idProofKey),
      status: s.status,
    })),
    scoped: Boolean(scope),
  });
}));

const studentSchema = z.object({
  regNo: z.string().min(3, 'Enter the register number'),
  name: z.string().min(2, 'Enter the full name'),
  email: z.string().email('Enter a valid email address'),
  mobile: z.string().optional(),
  batchId: z.string().min(1, 'Choose a batch'),
  departmentId: z.string().min(1, 'Choose a department'),
});

/* A class advisor may only add students into a batch they advise. */
async function assertBatchInScope(actor, batchId) {
  if (actor.scope === 'institution') return;
  const scope = await resolveScope(actor);
  if (!scope?.batchIds.includes(String(batchId))) {
    throw forbidden('That batch is outside the classes assigned to you');
  }
}

r.post('/students', can('student:create'), wrap(async (req, res) => {
  const body = parse(studentSchema, req.body);
  await assertBatchInScope(req.actor, body.batchId);

  const temp = tempPassword();
  const student = await Student.create({
    ...body, ...tenant(req),
    passwordHash: await bcrypt.hash(temp, 12),
  });

  await audit(req, { action: 'student.created', entity: 'Student', entityId: student._id, after: { regNo: body.regNo } });
  res.status(201).json({
    student: { id: String(student._id), regNo: student.regNo, name: student.name },
    temporaryPassword: process.env.NODE_ENV === 'production' ? undefined : temp,
  });
}));

r.post('/students/bulk', can('student:create'), wrap(async (req, res) => {
  const rows = z.array(studentSchema).max(2000).parse(req.body?.rows || []);
  const errors = [];
  let created = 0;

  for (const [i, row] of rows.entries()) {
    try {
      await assertBatchInScope(req.actor, row.batchId);
      const exists = await Student.findOne({ regNo: row.regNo, ...tenant(req) }).lean();
      if (exists) { errors.push({ row: i + 1, regNo: row.regNo, error: 'Register number already exists' }); continue; }
      await Student.create({
        ...row, ...tenant(req),
        passwordHash: await bcrypt.hash(tempPassword(), 12),
      });
      created++;
    } catch (e) {
      errors.push({ row: i + 1, regNo: row.regNo, error: e.message });
    }
  }

  await audit(req, { action: 'student.bulk_created', entity: 'Student', after: { created } });
  res.json({ created, errors });
}));

r.patch('/students/:id', can('student:edit'), wrap(async (req, res) => {
  const student = await Student.findOne({ _id: req.params.id, ...tenant(req) });
  if (!student) throw notFound('Student not found');
  await assertBatchInScope(req.actor, student.batchId);

  const body = parse(studentSchema.partial().extend({
    status: z.enum(['active', 'inactive']).optional(),
  }), req.body);

  const before = { name: student.name, email: student.email, status: student.status };
  Object.assign(student, body);
  await student.save();

  await audit(req, { action: 'student.updated', entity: 'Student', entityId: student._id, before, after: body });
  res.json({ student: { id: String(student._id), regNo: student.regNo, name: student.name } });
}));

/* ============================ ACADEMIC STRUCTURE ============================ */

r.get('/academic', wrap(async (req, res) => {
  const t = tenant(req);
  const [departments, batches, subjects] = await Promise.all([
    Department.find(t).sort({ name: 1 }).lean(),
    Batch.find(t).populate('departmentId', 'name code').sort({ year: 1, section: 1 }).lean(),
    Subject.find(t).populate('departmentId', 'name code').sort({ code: 1 }).lean(),
  ]);

  const scope = await resolveScope(req.actor);

  res.json({
    departments: departments.map((d) => ({ id: String(d._id), name: d.name, code: d.code })),
    batches: batches
      .filter((b) => !scope || scope.batchIds.includes(String(b._id)))
      .map((b) => ({
        id: String(b._id), label: b.label, programme: b.programme, year: b.year,
        section: b.section, semester: b.semester, academicYear: b.academicYear,
        department: b.departmentId ? { id: String(b.departmentId._id), name: b.departmentId.name } : null,
      })),
    subjects: subjects
      .filter((s) => !scope || scope.subjectIds.includes(String(s._id)))
      .map((s) => ({
        id: String(s._id), code: s.code, title: s.title, semester: s.semester, credits: s.credits,
        department: s.departmentId ? { id: String(s.departmentId._id), name: s.departmentId.name } : null,
      })),
  });
}));

r.post('/academic/departments', can('settings:create', 'staff:create'), wrap(async (req, res) => {
  const body = parse(z.object({
    name: z.string().min(2), code: z.string().min(2),
  }), req.body);
  const d = await Department.create({ ...body, ...tenant(req) });
  res.status(201).json({ department: { id: String(d._id), ...body } });
}));

r.post('/academic/batches', can('settings:create', 'staff:create'), wrap(async (req, res) => {
  const body = parse(z.object({
    departmentId: z.string(), programme: z.string(), year: z.number().int().min(1).max(5),
    section: z.string().default('A'), academicYear: z.string(), semester: z.number().int().min(1).max(10),
  }), req.body);
  const b = await Batch.create({ ...body, ...tenant(req) });
  res.status(201).json({ batch: { id: String(b._id), label: b.label } });
}));

r.post('/academic/subjects', can('settings:create', 'staff:create'), wrap(async (req, res) => {
  const body = parse(z.object({
    departmentId: z.string(), code: z.string().min(2), title: z.string().min(2),
    credits: z.number().default(3), semester: z.number().int().min(1).max(10),
  }), req.body);
  const s = await Subject.create({ ...body, ...tenant(req) });
  res.status(201).json({ subject: { id: String(s._id), code: s.code, title: s.title } });
}));

/* Mapping is what actually drives scoping, so it gets its own endpoints. */
r.get('/academic/mappings', can('staff:view'), wrap(async (req, res) => {
  const maps = await Mapping.find(tenant(req))
    .populate('staffId', 'name email')
    .populate('subjectId', 'code title')
    .populate('batchId', 'label')
    .lean();

  res.json({
    mappings: maps.map((m) => ({
      id: String(m._id),
      kind: m.kind,
      academicYear: m.academicYear,
      staff: m.staffId ? { id: String(m.staffId._id), name: m.staffId.name } : null,
      subject: m.subjectId ? { id: String(m.subjectId._id), code: m.subjectId.code, title: m.subjectId.title } : null,
      batch: m.batchId ? { id: String(m.batchId._id), label: m.batchId.label } : null,
    })),
  });
}));

r.post('/academic/mappings', can('staff:edit'), wrap(async (req, res) => {
  const body = parse(z.object({
    staffId: z.string(), batchId: z.string(),
    subjectId: z.string().optional(),
    kind: z.enum(['subject_staff', 'class_advisor']),
    academicYear: z.string(),
  }), req.body);

  const m = await Mapping.create({ ...body, ...tenant(req) });
  await audit(req, { action: 'mapping.created', entity: 'Mapping', entityId: m._id, after: body });
  res.status(201).json({ mapping: { id: String(m._id) } });
}));

r.delete('/academic/mappings/:id', can('staff:edit'), wrap(async (req, res) => {
  const m = await Mapping.findOneAndDelete({ _id: req.params.id, ...tenant(req) });
  if (!m) throw notFound('Mapping not found');
  await audit(req, { action: 'mapping.deleted', entity: 'Mapping', entityId: m._id, before: m.toObject() });
  res.json({ ok: true });
}));


/* ============================================================
   MASTER DATA — edit and delete
   A delete is refused, with the reason, when anything depends on the
   record. Reassigning first is safer than a cascade that silently
   orphans examinations or candidates.
   ============================================================ */
r.patch('/academic/departments/:id', can('settings:edit', 'staff:edit'), wrap(async (req, res) => {
  const body = parse(z.object({ name: z.string().min(2).optional(), code: z.string().min(1).max(12).optional() }), req.body);
  const doc = await Department.findOneAndUpdate({ _id: req.params.id, ...tenant(req) }, body, { new: true });
  if (!doc) throw notFound('Department not found');
  await audit(req, { action: 'department.updated', entity: 'Department', entityId: doc._id, after: body });
  res.json({ department: { id: String(doc._id), name: doc.name, code: doc.code } });
}));

r.delete('/academic/departments/:id', can('settings:delete', 'staff:edit'), wrap(async (req, res) => {
  const doc = await Department.findOne({ _id: req.params.id, ...tenant(req) });
  if (!doc) throw notFound('Department not found');
  const [subjects, batches, staff] = await Promise.all([
    Subject.countDocuments({ departmentId: doc._id }),
    Batch.countDocuments({ departmentId: doc._id }),
    User.countDocuments({ departmentId: doc._id }),
  ]);
  if (subjects || batches || staff) {
    throw badRequest(`Cannot delete ${doc.name}: ${subjects} subject(s), ${batches} batch(es) and ${staff} staff still belong to it. Move or delete those first.`);
  }
  await doc.deleteOne();
  await audit(req, { action: 'department.deleted', entity: 'Department', entityId: doc._id });
  res.json({ ok: true });
}));

r.patch('/academic/batches/:id', can('settings:edit', 'staff:edit'), wrap(async (req, res) => {
  const body = parse(z.object({
    label: z.string().min(2).optional(), year: z.number().int().min(1).max(6).optional(),
    section: z.string().max(4).optional(), departmentId: z.string().optional(),
    academicYear: z.string().optional(),
  }), req.body);
  const doc = await Batch.findOneAndUpdate({ _id: req.params.id, ...tenant(req) }, body, { new: true });
  if (!doc) throw notFound('Batch not found');
  await audit(req, { action: 'batch.updated', entity: 'Batch', entityId: doc._id, after: body });
  res.json({ batch: { id: String(doc._id), label: doc.label } });
}));

r.delete('/academic/batches/:id', can('settings:delete', 'staff:edit'), wrap(async (req, res) => {
  const doc = await Batch.findOne({ _id: req.params.id, ...tenant(req) });
  if (!doc) throw notFound('Batch not found');
  const [students, exams] = await Promise.all([
    Student.countDocuments({ batchId: doc._id }),
    Exam.countDocuments({ batchIds: doc._id }),
  ]);
  if (students || exams) {
    throw badRequest(`Cannot delete ${doc.label}: ${students} student(s) and ${exams} examination(s) reference it.`);
  }
  await doc.deleteOne();
  await audit(req, { action: 'batch.deleted', entity: 'Batch', entityId: doc._id });
  res.json({ ok: true });
}));

r.patch('/academic/subjects/:id', can('settings:edit', 'staff:edit'), wrap(async (req, res) => {
  const body = parse(z.object({
    code: z.string().min(2).max(16).optional(), title: z.string().min(2).optional(),
    departmentId: z.string().optional(), semester: z.number().int().min(1).max(12).optional(),
  }), req.body);
  const doc = await Subject.findOneAndUpdate({ _id: req.params.id, ...tenant(req) }, body, { new: true });
  if (!doc) throw notFound('Subject not found');
  await audit(req, { action: 'subject.updated', entity: 'Subject', entityId: doc._id, after: body });
  res.json({ subject: { id: String(doc._id), code: doc.code, title: doc.title } });
}));

r.delete('/academic/subjects/:id', can('settings:delete', 'staff:edit'), wrap(async (req, res) => {
  const doc = await Subject.findOne({ _id: req.params.id, ...tenant(req) });
  if (!doc) throw notFound('Subject not found');
  const [exams, mappings] = await Promise.all([
    Exam.countDocuments({ subjectId: doc._id }),
    Mapping.countDocuments({ subjectId: doc._id }),
  ]);
  if (exams) throw badRequest(`Cannot delete ${doc.code}: ${exams} examination(s) use it.`);
  await Mapping.deleteMany({ subjectId: doc._id });
  await doc.deleteOne();
  await audit(req, { action: 'subject.deleted', entity: 'Subject', entityId: doc._id, after: { mappingsRemoved: mappings } });
  res.json({ ok: true });
}));

/* ============================================================
   PEOPLE — deactivate rather than delete
   A person who has sat or invigilated an examination is part of the
   record. Deactivation removes access and keeps the history.
   ============================================================ */
r.delete('/staff/:id', can('staff:delete', 'staff:edit'), wrap(async (req, res) => {
  const doc = await User.findOne({ _id: req.params.id, ...tenant(req) });
  if (!doc) throw notFound('Staff member not found');
  if (String(doc._id) === req.actor.id) throw badRequest('You cannot deactivate your own account');
  doc.status = 'inactive';
  doc.refreshTokenHash = undefined;
  await doc.save();
  await audit(req, { action: 'staff.deactivated', entity: 'User', entityId: doc._id });
  res.json({ ok: true, status: doc.status });
}));

r.delete('/students/:id', can('student:delete', 'student:edit'), wrap(async (req, res) => {
  const doc = await Student.findOne({ _id: req.params.id, ...tenant(req) });
  if (!doc) throw notFound('Student not found');
  const live = await Attempt.countDocuments({ studentId: doc._id, status: 'in_progress' });
  if (live) throw badRequest('This student is sitting an examination right now.');
  doc.status = 'inactive';
  doc.refreshTokenHash = undefined;
  await doc.save();
  await audit(req, { action: 'student.deactivated', entity: 'Student', entityId: doc._id });
  res.json({ ok: true, status: doc.status });
}));

export default r;
