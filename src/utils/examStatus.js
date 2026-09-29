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

/* Statuses reached by someone doing something — closing a paper,
   submitting marks, publishing results. The clock never overrides
   these. */
const WORKFLOW_DRIVEN = ['draft', 'closed', 'evaluation', 'published'];

export function dueStatus(exam, { roomCloseBufferMinutes = 45, at = new Date() } = {}) {
  if (!exam || WORKFLOW_DRIVEN.includes(exam.status)) return exam?.status ?? null;

  const start = examStartAt(exam);
  if (!start) return exam.status;

  const end = new Date(start.getTime() + (exam.durationMinutes || 0) * 60000);
  const closed = new Date(end.getTime() + roomCloseBufferMinutes * 60000);

  if (at < start) return 'scheduled';
  if (at <= closed) return 'live';
  return 'evaluation';        // sitting is over; marks are what remain
}

/* Brings a list of papers up to date in one write. Returns the same
   array with `status` corrected, so a caller can hand it straight to
   the response. */
export async function syncExamStatuses(Exam, exams, institution) {
  const buffer = institution?.settings?.roomCloseBufferMinutes ?? 45;
  const at = new Date();
  const writes = [];

  for (const exam of exams) {
    const due = dueStatus(exam, { roomCloseBufferMinutes: buffer, at });
    if (due && due !== exam.status) {
      writes.push({ updateOne: { filter: { _id: exam._id }, update: { $set: { status: due } } } });
      exam.status = due;
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
