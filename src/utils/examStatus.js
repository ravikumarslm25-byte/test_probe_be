/* ============================================================
   An examination's status follows the clock.

   Status used to be written once and never changed: `scheduled` when
   the cell published it, and nothing afterwards. The seeded demo
   papers looked right only because the seed wrote `live` and
   `evaluation` into them by hand, so a paper the cell created itself
   sat on "Scheduled" through its own examination and past the end of
   it.

   Rather than run a scheduler, the status due now is worked out from
   the paper's own instants whenever it is read, and written back if
   it has moved on. Reading a list of papers is what a cell does all
   day, so the transition happens in time without anything to keep
   running, and the stored value stays the one that gates editing,
   deleting and publishing.
   ============================================================ */
import { examStartAt } from './time.js';
import { sweepExpired } from '../services/closeExam.js';

/* Statuses reached by someone doing something — closing a paper,
   submitting marks, publishing results. The clock never overrides
   these. */
const WORKFLOW_DRIVEN = ['draft', 'closed', 'evaluation', 'published'];

/* A document carries what the status is derived from only if it was
   loaded with those fields. `undefined` from a narrow projection and
   `undefined` from a field that was never set are indistinguishable
   on a lean object, so this asks a different question: is this the
   whole document?

   The first version asked whether `writingUntil`, `lastSittingEndsAt`
   and `closedAt` were present, and that was wrong in the worst way.
   None of the three is ever written until a sitting is granted or the
   paper is ended by hand, and MongoDB does not store a field that was
   never set — so `.lean()` returns an ordinary new paper WITHOUT
   those keys. Every such paper looked like a narrow projection and
   was left alone, which froze it on "Scheduled" through its own
   examination and past the end of it: candidates sat the paper, wrote
   it, submitted, and the list still read Scheduled the next morning
   while the wall said "Not started yet". Nothing was swept either,
   because the sweep only runs for a paper the sync has moved.

   `timestamps: true` is what makes the question answerable. Every
   stored exam has `createdAt` and `updatedAt`; a projection does not,
   unless it asked for them. So: a full document, or a lean one
   carrying its timestamps, is the whole paper. Anything else must
   name the three fields itself to be trusted. */
export function hasStatusFields(exam) {
  if (!exam) return false;
  if (typeof exam.toObject === 'function') return true;      // a full document
  if ('createdAt' in exam || 'updatedAt' in exam) return true;   // a whole lean document
  return ['writingUntil', 'lastSittingEndsAt', 'closedAt'].every((k) => k in exam);
}

export function dueStatus(exam, { roomCloseBufferMinutes = 45, at = new Date() } = {}) {
  if (!exam || WORKFLOW_DRIVEN.includes(exam.status)) return exam?.status ?? null;

  const start = examStartAt(exam);
  if (!start) return exam.status;

  /* Ended by hand — unless somebody is still entitled to write.

     Setting it over at once took the extension holders off the
     invigilator's wall and made their room read-only, while the
     dialog that ended the paper had just said "keep watching them".
     The paper is over when the last of them is done. */
  if (exam.closedAt) {
    const stillWriting = exam.writingUntil && at < new Date(exam.writingUntil);
    if (!stillWriting) return 'evaluation';
    return 'live';
  }

  let end = new Date(start.getTime() + (exam.durationMinutes || 0) * 60000);

  /* The last moment anyone may still legitimately be writing.

     This used to be the paper's nominal end plus a flat
     forty-five-minute room-close buffer, which meant an examination
     that finished at 10:30 still read "In progress" at 11:14 with an
     empty hall. The buffer was there to cover late joiners and
     extensions — so cover those exactly, rather than guessing a
     window that is both too long for an ordinary paper and too short
     for a long extension.

     `writingUntil` carries the latest extension and the latest
     alternate sitting; it is maintained when either is granted. */
  for (const later of [exam.lastSittingEndsAt, exam.writingUntil]) {
    if (later && new Date(later) > end) end = new Date(later);
  }

  /* A short grace on the end itself, because a candidate who started
     a minute late finishes a minute late, and flipping the paper to
     evaluation while the last of them is pressing Submit helps
     nobody. Far shorter than the old room-close buffer, and it no
     longer has to stand in for extensions. */
  const grace = new Date(end.getTime() + Math.min(roomCloseBufferMinutes, 5) * 60000);

  if (at < start) return 'scheduled';
  if (at <= grace) return 'live';
  return 'evaluation';        // sitting is over; marks are what remain
}

/* Brings a list of papers up to date in one write. Returns the same
   array with `status` corrected, so a caller can hand it straight to
   the response. */
export async function syncExamStatuses(Exam, exams, institution) {
  const buffer = institution?.settings?.roomCloseBufferMinutes ?? 45;
  const at = new Date();
  const writes = [];
  const justMoved = new Set();

  for (const exam of exams) {
    /* A paper loaded through a narrow projection does not carry the
       fields the status is derived from, and deriving it anyway
       produced a WRONG status that was then written back — past the
       point of correction, because 'evaluation' is workflow-driven.
       Refuse rather than guess. */
    if (!hasStatusFields(exam)) {
      console.warn(`[exam-status] ${exam.code || exam._id} was loaded without the fields the`
        + ' status is derived from (writingUntil, lastSittingEndsAt, closedAt). Left alone.'
        + ' Widen the projection at the call site.');
      continue;
    }

    const due = dueStatus(exam, { roomCloseBufferMinutes: buffer, at });
    if (due && due !== exam.status) {
      writes.push({ updateOne: { filter: { _id: exam._id }, update: { $set: { status: due } } } });
      exam.status = due;
      justMoved.add(String(exam._id));
    }
  }

  if (writes.length) {
    try {
      await Exam.bulkWrite(writes, { ordered: false });
    } catch (e) {
      // A status that failed to persist is corrected on the next read.
      console.warn('[exam-status] could not persist', writes.length, 'change(s):', e.message);
    }
  }

  /* A paper that has just moved past its window is also swept: every
     attempt whose own clock has run out is sealed.

     Without this a candidate who shut their laptop stayed "in
     progress" for ever, because an attempt is only auto-submitted
     when that candidate's OWN browser next calls the API. Their
     script never reached the evaluator and the results could not be
     published. Done here, on the read that notices the paper is
     over, so nothing has to be left running. */
  for (const exam of exams) {
    /* Only the papers THIS call moved. Sweeping every paper already
       in evaluation cost an Attempt query per finished paper on every
       list load, for a term's worth of them. */
    if (!justMoved.has(String(exam._id))) continue;
    /* Sealing decides pass or fail, so a paper loaded without its
       pass mark is not swept here — it would seal the attempt with
       an undecidable result, and that result is what gets published.
       `gradeObjective` refuses too; this says it once per paper
       rather than once per candidate. */
    if (exam.passMark === null || exam.passMark === undefined) {
      console.warn(`[exam-status] ${exam.code || exam._id} was loaded without passMark;`
        + ' not sealing expired attempts. Widen the projection at the call site.');
      continue;
    }
    try {
      const sealed = await sweepExpired(exam, at);
      if (sealed) {
        console.log(`[exam-status] ${exam.code}: sealed ${sealed} attempt(s) whose time had run out`);
      }
    } catch (e) {
      console.warn('[exam-status] sweep failed for', exam.code, e.message);
    }
  }

  return exams;
}

/* One paper, for the endpoints that load a single document. */
export async function syncExamStatus(exam, institution) {
  if (!exam) return exam;
  const buffer = institution?.settings?.roomCloseBufferMinutes ?? 45;
  const due = dueStatus(exam, { roomCloseBufferMinutes: buffer });
  if (due && due !== exam.status) {
    exam.status = due;
    if (typeof exam.save === 'function') await exam.save();
  }
  return exam;
}
