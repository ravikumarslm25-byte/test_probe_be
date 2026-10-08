/* ============================================================
   THE PHONE'S END OF THE ANSWER UPLOAD

   Every other route in this API is behind a signed-in session. This
   one is not, and cannot be: the candidate's phone has not signed in,
   and asking three hundred candidates to sign in on a handset in an
   examination hall would cost more time than the upload saves.

   What stands in for a session is the pass token in the address. It
   is issued only to a candidate who is sitting the paper, names one
   question of one attempt, accepts a handful of files, and expires in
   minutes. There is nothing to enumerate — 24 random bytes — and
   nothing to escalate to: the token cannot read the paper, cannot see
   a mark, and cannot touch another question.

   Bytes arrive as the raw request body rather than as multipart, so
   no parser sits in front of an unauthenticated route, and a phone
   can send a file with one fetch and no library.
   ============================================================ */
import { Router } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { Attempt, Exam, UploadPass } from '../models/exam.js';
import { Student } from '../models/core.js';
import { wrap, notFound, badRequest, forbidden } from '../utils/http.js';
import { storage, evidenceKey, validateUpload } from '../services/storage.js';
import { pushToCandidate } from '../realtime/live.js';

const r = Router();
const now = () => new Date();

/* The most any one answer can carry, across however many passes the
   candidate opens for it. Reached, further uploads are refused with
   a reason rather than quietly displacing the earliest page. */
const PAGES_PER_ANSWER = 12;

/* A pass is a bearer credential, so the route it unlocks is rated
   even though the pass itself is already narrow. Keyed on the token:
   a hall of candidates shares one campus address, and keying on IP
   would have the first few uploads starve the rest. */
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `pass:${req.params.token || 'none'}`,
  message: { error: 'Too many attempts for this code. Ask the invigilator for a new one.' },
});

/* The token-keyed limiter above cannot bound someone who does not
   have a token: a caller rotating random ones gets a fresh allowance
   on every request, because every request is a new key.

   This one is keyed on the address and counts only REFUSALS. A hall
   of three hundred candidates, every one of them holding a valid
   pass, produces almost no refusals and never meets it; a caller
   guessing tokens produces nothing else and meets it in seconds. */
const guessLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  standardHeaders: false,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many invalid codes from this connection. Wait a few minutes.' },
});

/* Loads and checks the pass BEFORE the body is read.

   Running the raw parser first meant a twenty-four megabyte body was
   buffered into memory and only then refused for a token that never
   existed. Fifty of those at once is more than a gigabyte of memory
   spent rejecting them. Refusing here closes the connection with the
   bytes still on the wire. */
const requirePass = wrap(async (req, _res, next) => {
  const { pass, attempt } = await loadPass(req.params.token);
  req.pass = pass;
  req.passAttempt = attempt;
  next();
});

async function loadPass(token) {
  const pass = await UploadPass.findOne({ token });
  if (!pass) throw notFound('This code is not valid. Ask for a new one on the examination screen.');
  if (pass.expiresAt <= now()) throw forbidden('This code has expired. Generate a new one on the examination screen.');
  if (pass.closedAt) throw forbidden('This upload is already finished.');

  const attempt = await Attempt.findById(pass.attemptId)
    .select('status timerEndsAt answers scanWindows institutionId examId').lean();
  if (!attempt) throw notFound('That examination could not be found');
  if (attempt.status !== 'in_progress') {
    throw forbidden('That examination is no longer in progress, so nothing further can be uploaded.');
  }

  /* The candidate's own routes auto-submit the paper the moment the
     timer runs out, but only when the examination page calls one. A
     candidate who opens a pass a minute before time and then closes
     the tab leaves nothing to trigger that — so without this check
     the phone could go on uploading for the whole life of the pass,
     well past the end of the examination. */
  if (attempt.timerEndsAt && now() > new Date(attempt.timerEndsAt)) {
    throw forbidden('Your examination time has ended, so nothing further can be uploaded.');
  }
  return { pass, attempt };
}

/* ============================================================
   WHAT THE PHONE SHOWS BEFORE UPLOADING

   Enough for the candidate to be sure the code is their own — their
   register number and which question — and nothing else. Never the
   question text: a phone screen is the one place in the hall nobody
   is watching.
   ============================================================ */
r.get('/:token', guessLimiter, limiter, wrap(async (req, res) => {
  const { pass } = await loadPass(req.params.token);
  const [student, exam] = await Promise.all([
    Student.findById(pass.studentId).select('name regNo').lean(),
    Exam.findById(pass.examId).select('title code').lean(),
  ]);

  res.json({
    candidate: student ? { name: student.name, regNo: student.regNo } : null,
    exam: exam ? { title: exam.title, code: exam.code } : null,
    section: pass.section,
    questionNumber: pass.questionNumber,
    files: (pass.files || []).map((f) => ({
      name: f.name, mime: f.mime, bytes: f.bytes, uploadedAt: f.uploadedAt,
    })),
    maxFiles: pass.maxFiles,
    expiresAt: pass.expiresAt,
    accepts: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'],
    maxBytes: 20_000_000,
  });
}));

/* ============================================================
   THE UPLOAD

   One file per request. A phone scanner app produces a single PDF of
   several pages, which is the common case; a candidate photographing
   pages one at a time sends several requests.
   ============================================================ */
r.post('/:token',
  guessLimiter,
  limiter,
  /* The pass is checked here, before the parser below ever reads a
     byte. */
  requirePass,
  /* The limit here is the last line of defence, not the real check —
     `validateUpload` decides per kind. It exists so a body far larger
     than any legitimate scan is refused before it is buffered. */
  express.raw({ type: () => true, limit: '24mb' }),
  wrap(async (req, res) => {
    const pass = req.pass;

    if ((pass.files || []).length >= pass.maxFiles) {
      throw badRequest(`This code accepts ${pass.maxFiles} files, and all of them have been used.`);
    }

    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const buffer = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buffer || !buffer.length) throw badRequest('No file arrived. Choose the file again.');

    const problem = validateUpload('scan', mime, buffer.length);
    if (problem) throw badRequest(problem);

    /* The declared type is not trusted on its own: a phone that
       labels a PDF as an image would otherwise leave the evaluator
       with a page that does not render. Checked against the first
       bytes of the file instead. */
    const actual = sniff(buffer);
    if (actual && actual !== mime) {
      if (actual === 'application/pdf' || mime === 'application/pdf') {
        throw badRequest('That file is not the type it claims to be. Upload the PDF or the photograph again.');
      }
    }

    const ext = (actual || mime) === 'application/pdf' ? 'pdf' : (actual || mime).split('/')[1];
    const key = evidenceKey({
      institutionId: pass.institutionId,
      examId: pass.examId,
      attemptId: pass.attemptId,
      kind: 'scan',
      ext,
    });
    await storage.put(key, buffer, actual || mime);

    const name = cleanName(req.headers['x-file-name']) || `page-${(pass.files?.length || 0) + 1}.${ext}`;
    const record = { key, mime: actual || mime, bytes: buffer.length, name, uploadedAt: now() };

    pass.files.push(record);
    pass.usedFromIp = req.ip;
    pass.usedFromAgent = String(req.headers['user-agent'] || '').slice(0, 200);
    await pass.save();

    /* Written onto the answer immediately rather than when the
       candidate closes the dialog — a phone that uploads and then
       loses signal must not lose the page. */
    const attempt = await Attempt.findById(pass.attemptId);

    /* Checked again here, not only when the pass was loaded.
       Photographing and uploading a page over a phone connection
       takes seconds, and the examination can end inside them — the
       pass check ran before the body was buffered and before the file
       was stored. A page landing after the paper was sealed attached
       an unmarked descriptive answer to a script whose result had
       already been decided, and the evaluator could no longer touch
       it. The file is already in storage and harmless; the answer is
       not written. */
    if (attempt.status !== 'in_progress') {
      throw forbidden('The examination has ended, so this page cannot be added to the answer.');
    }

    let answer = attempt.answers.find((a) => String(a.questionId) === String(pass.questionId));
    if (!answer) {
      attempt.answers.push({ questionId: pass.questionId, section: pass.section });
      answer = attempt.answers[attempt.answers.length - 1];
    }
    /* The cap is refused rather than applied silently. `.slice(-12)`
       here dropped the oldest page once a candidate had sent thirteen
       across two passes — the file survived in storage but the answer
       stopped pointing at it, so the evaluator never saw page one and
       nothing said so. And because the page number was derived from
       the length AFTER the slice, pages 13 and 14 were both numbered
       13 and the evaluator saw the same label twice. */
    const held = answer.scanPages || [];
    if (held.length >= PAGES_PER_ANSWER) {
      throw badRequest(`This answer already holds ${PAGES_PER_ANSWER} files, which is the most one `
        + 'answer can carry. Remove one on the examination screen before sending another.');
    }

    answer.mode = answer.html || answer.text ? 'mixed' : 'scanned';
    const nextPage = held.reduce((max, p) => Math.max(max, p.page || 0), 0) + 1;
    answer.scanPages = [...held, { ...record, page: nextPage }];
    answer.answeredAt = now();

    const win = attempt.scanWindows.find((w) => !w.closedAt
      && String(w.questionId) === String(pass.questionId));
    if (win) win.pages = (win.pages || 0) + 1;

    await attempt.save();

    /* This is what makes the feature work: the examination machine is
       told over the socket it already holds, so the candidate's
       screen updates without them touching it, and without ever
       leaving the paper. */
    pushToCandidate(String(pass.attemptId), {
      type: 'answer-uploaded',
      questionId: String(pass.questionId),
      section: pass.section,
      questionNumber: pass.questionNumber,
      files: pass.files.map((f) => ({ name: f.name, mime: f.mime, bytes: f.bytes })),
    });

    res.status(201).json({
      ok: true,
      files: pass.files.map((f) => ({ name: f.name, mime: f.mime, bytes: f.bytes, uploadedAt: f.uploadedAt })),
      remaining: pass.maxFiles - pass.files.length,
    });
  }));

/* Finished on the phone. The examination page also closes the pass
   when the candidate dismisses the dialog; whichever happens first
   wins, and the other is a no-op. */
r.post('/:token/done', guessLimiter, limiter, wrap(async (req, res) => {
  const pass = await UploadPass.findOne({ token: req.params.token });
  if (!pass) throw notFound('This code is not valid');
  if (!pass.closedAt) { pass.closedAt = now(); await pass.save(); }

  pushToCandidate(String(pass.attemptId), {
    type: 'answer-upload-closed',
    questionId: String(pass.questionId),
    files: (pass.files || []).length,
  });

  res.json({ ok: true, files: (pass.files || []).length });
}));

/* ---- helpers ---- */

/* Magic bytes for the handful of types a scan can be. Returns null
   when nothing matches, which leaves the declared type to stand. */
export function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF'
      && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return 'image/heic';
  }
  return null;
}

/* The file name comes from the candidate's phone and is shown to an
   evaluator, so it is stripped to something harmless rather than
   trusted. */
export function cleanName(raw) {
  if (!raw) return null;
  return String(raw)
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || null;
}

export default r;
