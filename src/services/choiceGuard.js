import { Question } from '../models/exam.js';
import { hasContent } from '../utils/grading.js';
import { refuseWrite } from '../utils/choice.js';
import { forbidden } from '../utils/http.js';

/* ============================================================
   THE CHOICE RULE, ENFORCED

   The examination screen greys out what the candidate may not
   answer. That is a courtesy, not a rule — the rule is here, because
   this is the only place an answer can actually be stored.

   Checked after the change has been applied to the in-memory
   document but before it is saved, so what is judged is what the
   answer WOULD become. Nothing is persisted on the refusing path.
   ============================================================ */
export async function assertChoiceAllows(attempt, exam, question, { wasAnswered, willBeAnswered }) {
  if (wasAnswered || !willBeAnswered) return;          // clearing, or already theirs

  const section = (exam.blueprint?.sections || []).find((s) => s.key === question.section);
  if (!section || section.type !== 'desc') return;
  if ((section.choiceMode || 'best_n') === 'best_n') return;

  const qs = await Question.find({
    examId: exam._id,
    section: question.section,
    $or: [{ setLabel: attempt.setLabel }, { setLabel: { $exists: false } }],
  }).sort({ order: 1 }).select('order choiceGroup').lean();

  /* Everything the candidate holds EXCEPT this question — this one's
     new content is what is being judged, not part of what is already
     there. */
  const answered = new Set(
    attempt.answers
      .filter((a) => String(a.questionId) !== String(question._id) && hasContent(a))
      .map((a) => String(a.questionId)),
  );

  const msg = refuseWrite({
    section,
    questions: qs.map((q) => ({ id: String(q._id), order: q.order, choiceGroup: q.choiceGroup })),
    answered,
    questionId: String(question._id),
    willBeAnswered: true,
  });
  if (msg) throw forbidden(msg);
}
