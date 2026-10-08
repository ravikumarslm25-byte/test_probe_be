/* ============================================================
   ENDING A PAPER

   Two things were missing and they are different.

   The first is that a paper nobody ends never ends. A candidate's
   attempt is only auto-submitted when their OWN browser next calls
   the API — so a candidate who shut the laptop, lost the network or
   simply walked out stays "in progress" for ever. The examination
   sits on the list reading "In progress" the next morning, their
   script never reaches the evaluator, and the marks cannot be
   published because the paper is not finished.

   The second is that the examination cell has no way to say "that is
   enough, hand in your papers" — which is the single most ordinary
   thing that happens at the end of an examination.

   Both are this module. `sweepExpired` finishes attempts whose own
   clock has run out, whoever is or is not watching. `closeExam` is
   the cell saying so by hand.

   What neither does is cut off a candidate who is entitled to more
   time. An extension granted by an invigilator, and an alternate
   sitting arranged by the cell, are promises the product made; ending
   the paper must not break them. Those candidates keep writing, and
   the paper stays on the invigilator's wall until they are done.
   ============================================================ */
import { Attempt } from '../models/exam.js';
import { finaliseAttempt } from './finalise.js';
import { sittingFor } from '../utils/sitting.js';
import { pushToCandidate } from '../realtime/live.js';

const now = () => new Date();

/* Is this candidate entitled to carry on past the paper's own end?

   Two ways, and both are a record rather than an inference: an
   invigilator granted them time, or the cell arranged them a sitting
   of their own. Anything else is simply still writing because nobody
   has stopped them. */
export function mayContinue(attempt, exam, at = now()) {
  const sitting = sittingFor(attempt, exam || {});
  if (sitting.isAlternate && sitting.endsAt && at < sitting.endsAt) {
    return { yes: true, why: 'sitting', until: sitting.endsAt };
  }
  if (attempt.timeExtension?.minutes && attempt.timerEndsAt && at < new Date(attempt.timerEndsAt)) {
    return {
      yes: true,
      why: 'extension',
      until: new Date(attempt.timerEndsAt),
      minutes: attempt.timeExtension.minutes,
    };
  }
  return { yes: false };
}

/* The last moment anyone on this paper may still be writing, read off
   the attempts themselves. Written back onto the exam so the status
   can be derived without loading them again on every read. */
export async function recomputeWritingUntil(exam) {
  /* Everyone whose clock is still running, not only those with an
     extension or a sitting.

     A LATE JOINER has neither, and their duration runs from when they
     actually joined — so on a paper due to end at 10:30 someone who
     started at 08:44 is legitimately writing until 10:44. The flat
     forty-five-minute buffer this replaced covered them by accident;
     covering extensions and sittings "exactly" lost them, and their
     room went read-only for the last eight minutes.

     Finished attempts are excluded: a sitting that was granted and
     has since been handed in should not hold the paper open. */
  const open = await Attempt.find({
    examId: exam._id,
    status: 'in_progress',
  }).select('timerEndsAt timeExtension sitting').lean();

  let latest = null;
  for (const a of open) {
    const sitting = sittingFor(a, exam);
    for (const end of [a.timerEndsAt, sitting.isAlternate ? sitting.endsAt : null]) {
      if (end && (!latest || new Date(end) > latest)) latest = new Date(end);
    }
  }

  /* A sitting arranged but NOT YET STARTED also keeps the paper open —
     those candidates have not joined, so they have no clock yet. */
  const pending = await Attempt.find({
    examId: exam._id,
    status: { $in: ['not_started', 'verifying'] },
    'sitting.startsAt': { $ne: null },
  }).select('sitting').lean();

  for (const a of pending) {
    const sitting = sittingFor(a, exam);
    if (sitting.endsAt && (!latest || sitting.endsAt > latest)) latest = sitting.endsAt;
  }

  exam.writingUntil = latest;
  return latest;
}

/* Finishes every attempt whose own clock has run out.

   Called wherever examination statuses are brought up to date, so a
   paper finishes itself without anything having to be running. It
   never touches a candidate whose clock is still going, which
   includes everyone on an extension or a sitting of their own —
   their `timerEndsAt` is simply later. */
export async function sweepExpired(exam, at = now()) {
  const stale = await Attempt.find({
    examId: exam._id,
    status: 'in_progress',
    timerEndsAt: { $lt: at },
  });

  let sealed = 0;
  for (const attempt of stale) {
    try {
      await finaliseAttempt(attempt, exam, { auto: true });
      sealed += 1;
    } catch (e) {
      /* One candidate's paper failing to seal must not stop the
         rest, and it must not be silent either. */
      console.warn('[close] could not seal attempt', String(attempt._id), e.message);
    }
  }
  return sealed;
}

/* The cell ending the paper by hand.

   Everyone still writing is sealed exactly as if they had pressed
   Submit — graded, best-N applied, marks where they should be —
   except those entitled to carry on, who are left alone. */
export async function closeExam(exam, { actorId, reason, at = now() } = {}) {
  const writing = await Attempt.find({ examId: exam._id, status: 'in_progress' });

  const sealed = [];
  const continuing = [];

  for (const attempt of writing) {
    const allowed = mayContinue(attempt, exam, at);
    if (allowed.yes) {
      continuing.push({
        attemptId: String(attempt._id),
        studentId: String(attempt.studentId),
        why: allowed.why,
        until: allowed.until,
      });
      continue;
    }
    try {
      await finaliseAttempt(attempt, exam, { auto: true });
      sealed.push(String(attempt._id));
      /* Told, rather than left typing into a paper that silently
         refuses every save. Their screen has no other way to learn
         it: the attempt is `submitted`, not `terminated`, so nothing
         on the heartbeat says so. */
      pushToCandidate(attempt._id, {
        type: 'collected',
        reason: reason || 'The examination has ended.',
      });
    } catch (e) {
      console.warn('[close] could not seal attempt', String(attempt._id), e.message);
    }
  }

  /* `closedAt` is what makes the paper over. The status follows from
     it rather than from the clock, so the list stops reading "In
     progress" the moment the cell says the paper is finished. */
  exam.closedAt = at;
  exam.closedBy = actorId;
  exam.closeReason = reason;
  await recomputeWritingUntil(exam);

  /* Over only once the last entitled candidate is done. Marking it
     'evaluation' while two of them are still writing dropped their
     room off the invigilator's wall and made it read-only — while the
     dialog that ended the paper had just said to keep watching them. */
  exam.status = continuing.length ? 'live' : 'evaluation';
  await exam.save();

  return { sealed: sealed.length, continuing };
}
