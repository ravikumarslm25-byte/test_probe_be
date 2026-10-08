/* ============================================================
   READING ATTENDANCE OFF AN ATTEMPT

   There is no attendance flag anywhere in the product, and there
   should not be: nobody ticks a register. Attendance is a reading of
   the timestamps the proctoring already records, and the reading has
   to be identical everywhere — the summary register and the
   candidate-by-candidate register disagreeing by one is the kind of
   thing a controller of examinations notices and a developer cannot
   explain.

   So both go through here.
   ============================================================ */
import { sittingFor } from './sitting.js';

/* The four states the examination cell actually uses.

   A candidate who reached the verification screen but never started
   is ABSENT. They stood at the door; they did not sit the paper. Any
   other reading inflates attendance, which is the one number in this
   report nobody may get wrong. */
export function attendanceState(attempt) {
  if (!attempt) return 'Absent';
  if (attempt.status === 'terminated') return 'Disqualified';
  if (attempt.status === 'submitted') return 'Present';
  if (attempt.status === 'in_progress') return 'Present (still writing)';
  return 'Absent';
}

export const isPresent = (state) => state.startsWith('Present');
/* Disqualified counts toward attendance: they were in the hall. It is
   their paper that ended, not their presence. */
export const countsAsAttended = (state) => isPresent(state) || state === 'Disqualified';

/* How many minutes after their OWN due start the candidate began.

   Their own: a candidate sitting at 14:00 by arrangement is not four
   hours late, and reading the examination's start here reported
   exactly that. Returns null when they never started. */
export function lateByMinutes(attempt, exam) {
  if (!attempt?.startedAt) return null;
  const { startAt } = sittingFor(attempt, exam || {});
  if (!startAt) return null;
  return Math.max(0, Math.round((new Date(attempt.startedAt) - startAt) / 60000));
}

/* "Late" is a threshold, and the threshold is the institution's entry
   cut-off — the point past which someone needs the invigilator's
   approval to come in at all. */
export function isLate(attempt, exam, cutoffMinutes = 15) {
  const by = lateByMinutes(attempt, exam);
  return by !== null && by > cutoffMinutes;
}

/* Minutes actually spent in front of the paper. */
export function minutesSat(attempt) {
  if (!attempt?.startedAt || !attempt?.submittedAt) return null;
  return Math.round((new Date(attempt.submittedAt) - new Date(attempt.startedAt)) / 60000);
}

/* Why the paper closed, in the words a register uses. */
export function howItEnded(attempt) {
  if (!attempt) return '';
  if (attempt.status === 'terminated') return attempt.terminationReason || 'Ended by invigilator';
  if (attempt.autoSubmitted) return 'Time expired';
  if (attempt.submittedAt) return 'Submitted';
  return '';
}
