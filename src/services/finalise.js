/* ============================================================
   SEALING A PAPER

   A candidate's own submit, the timer running out, and the
   examination cell ending the paper from the wall all have to seal an
   attempt the SAME way — grade the objective parts, apply best-N
   across the descriptive section, mark it submitted. Three copies of
   that would diverge, and the divergence would show up as two
   candidates with the same answers and different marks.

   So it lives here, and all three call it.
   ============================================================ */
import { Question } from '../models/exam.js';
import { countedAnswers } from '../utils/choice.js';
import {
  gradeMcq, gradeFib, suggestDescriptive, applyBestN, hasContent,
} from '../utils/grading.js';

const now = () => new Date();

/* Pass or fail at the moment a paper is sealed.

   `false` while Part C is still to be evaluated is a placeholder, and
   an honest one: the total is not final, and `recomputeTotals`
   overwrites it when the evaluator saves a mark.

   Where there is nothing to evaluate it is not a placeholder, it is
   the published result — and it was wrong. No evaluator opens a
   script with no descriptive content, so `recomputeTotals` is never
   reached and the placeholder goes out as a fail. A cohort that sat
   an objective-only paper and all passed on total were all issued a
   fail; ending such a paper from the wall did it to every one of them
   in a single action.

   Kept separate from the grading so it can be tested without a
   database. */
export function decidePass({ total, passMark, descNeedsEval, status }) {
  if (descNeedsEval) return false;        // not decidable yet
  /* A disqualified candidate is not passed by the objective marks
     they had collected before they were removed. This mattered only
     once the line above started deciding anything: an MCQ paper used
     to leave every result `false`, so a termination came out as a
     fail by accident. */
  if (status === 'terminated') return false;

  /* A pass mark of zero is not a pass mark, it is a paper whose pass
     mark was never set — and `>= 0` would issue a pass to every
     candidate who turned up, including one who answered nothing.
     That is the exact inverse of the bug this function fixes, and it
     is one cleared field away: the builder sends `Number('') || 0`.
     The field is now refused at creation, and refused here too, so
     neither layer can do it alone. */
  const mark = Number(passMark);
  if (!Number.isFinite(mark) || mark <= 0) return false;

  const scored = Number(total);
  return Number.isFinite(scored) && scored >= mark;
}

/* Grades the objective parts, applies best-N to the choice section
   and seals the attempt. Descriptive answers stay pending. */
export async function gradeObjective(attempt, exam) {
  /* Sealing decides the result, so it needs the whole paper, not a
     projection of it. A caller that loaded the examination with a
     narrow `select`/`populate` used to get away with it — everything
     came out `false`. Now a missing pass mark would fail an entire
     cohort silently, so it stops here instead: the attempt is left
     open, the warning names the paper, and nothing is published.
     `blueprint` is required for the same reason, two lines down. */
  if (exam.passMark === null || exam.passMark === undefined) {
    throw new Error(
      `cannot seal an attempt on exam ${exam._id}: the examination was loaded`
      + ' without passMark, so the result cannot be decided',
    );
  }

  const questions = await Question.find({ examId: exam._id }).lean();
  const byId = new Map(questions.map((q) => [String(q._id), q]));

  let a = 0, b = 0;
  let descNeedsEval = false;

  for (const ans of attempt.answers) {
    const q = byId.get(String(ans.questionId));
    if (!q) continue;

    if (q.type === 'mcq') {
      const g = gradeMcq(q, ans);
      ans.autoAwarded = g.awarded; ans.awarded = g.awarded;
      a += g.awarded;
    } else if (q.type === 'fib') {
      const g = gradeFib(q, ans);
      ans.autoAwarded = g.awarded;
      ans.awarded = g.awarded;
      ans.needsReview = g.needsReview && hasContent(ans);
      b += g.awarded;
    } else if (q.type === 'desc') {
      const s = suggestDescriptive(q, ans);
      ans.suggested = s.suggested;
      ans.keywordHits = s.hits;
      if (hasContent(ans)) descNeedsEval = true;
    }
  }

  /* Best-N across the descriptive section.

     The number counted is the number the paper's own choice rule
     allows, not the stored `answerCount` — on an either/or paper
     those are two different numbers, and marking by the second
     discarded answers the first had demanded. */
  const descSection = exam.blueprint.sections.find((s) => s.type === 'desc');
  if (descSection) {
    const descQuestions = questions.filter((q) => q.section === descSection.key)
      .sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
    const descAnswers = attempt.answers.filter((x) => {
      const q = byId.get(String(x.questionId));
      return q?.type === 'desc';
    });
    applyBestN(descAnswers, countedAnswers(descSection, descQuestions) || descAnswers.length);
  }

  attempt.marks.sectionA = Math.round(a * 100) / 100;
  attempt.marks.sectionB = Math.round(b * 100) / 100;
  attempt.marks.sectionC = 0;
  attempt.marks.total = attempt.marks.sectionA + attempt.marks.sectionB;

  /* Is there anything left for a person to do?

     Part C is the obvious case. The other one is a fill-in-the-blank
     the marker could not match: `gradeFib` deliberately sends a
     plausible-but-unanticipated wording to an evaluator rather than
     marking it wrong, and the evaluation queue counts those. Gating
     on Part C alone sealed such a script as final, awarded it zero
     for those blanks, and then refused the evaluator's correction
     because the state was already `submitted`. A candidate two marks
     short with a correct answer worth four had no route back except
     a revaluation. */
  const needsHuman = descNeedsEval || attempt.answers.some((x) => x.needsReview);

  /* Pass or fail — decided here when there is nothing left to
     evaluate, left to `recomputeTotals` when there is. */
  attempt.evaluation.state = needsHuman ? 'pending' : 'submitted';
  attempt.marks.passed = decidePass({
    total: attempt.marks.total,
    passMark: exam.passMark,
    descNeedsEval: needsHuman,
    status: attempt.status,
  });

  return { a, b, descNeedsEval, needsHuman };
}

export async function finaliseAttempt(attempt, exam, { auto }) {
  const counts = await gradeObjective(attempt, exam);
  attempt.status = 'submitted';
  attempt.submittedAt = now();
  attempt.autoSubmitted = auto;
  await attempt.save();

  const answered = attempt.answers.filter(hasContent).length;
  return {
    submittedAt: attempt.submittedAt,
    autoSubmitted: auto,
    answered,
    flagScore: attempt.flagScore,
    awaitingEvaluation: counts.needsHuman,
  };
}
