/* ============================================================
   WHEN THIS CANDIDATE SITS

   An examination has one window, and almost every candidate sits in
   it. But not all: a working professional cannot take Monday at
   10:00, and the alternative the cell actually wants is not "more
   time" or "join late" — it is the same paper, the same marks, the
   same proctoring, at 14:00.

   An extension stretches the existing window and still hangs off the
   examination's own start. A SITTING replaces it for one candidate.
   The two are different things and the difference matters: a late
   joiner's clock has already been running, an alternate sitting's has
   not started.

   Every gate that asks "may this candidate begin, and when does their
   time end" goes through here rather than reading the examination's
   instants directly. Miss one and that candidate is either locked out
   of their own sitting or handed a paper hours early.
   ============================================================ */
import { examStartAt } from './time.js';

export function sittingFor(attempt, exam) {
  const own = attempt?.sitting?.startsAt ? new Date(attempt.sitting.startsAt) : null;
  const startAt = own || examStartAt(exam);
  const durationMinutes = attempt?.sitting?.durationMinutes || exam?.durationMinutes || 0;

  return {
    startAt,
    durationMinutes,
    endsAt: startAt ? new Date(startAt.getTime() + durationMinutes * 60000) : null,
    /* True only for a candidate given a window of their own. Used to
       label them on the invigilator's wall, because someone sitting
       at 14:00 when the hall emptied at 12:00 looks like a fault
       unless the screen says otherwise. */
    isAlternate: Boolean(own),
    reason: attempt?.sitting?.reason || null,
  };
}

/* The last moment anyone is still sitting this paper — the ordinary
   window, or an alternate sitting that runs past it. The examination's
   own status is derived from this, so a paper does not go to
   "evaluation" at noon while two candidates are due to start at two
   and the invigilator's wall has already filed it under past papers. */
export function lastSittingEnd(exam, alternateEnds = []) {
  const base = examStartAt(exam);
  const ordinary = base
    ? new Date(base.getTime() + (exam.durationMinutes || 0) * 60000)
    : null;

  let latest = ordinary;
  for (const end of alternateEnds) {
    if (!end) continue;
    const d = new Date(end);
    if (!latest || d > latest) latest = d;
  }
  return latest;
}
