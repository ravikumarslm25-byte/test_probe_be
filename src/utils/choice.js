/* ============================================================
   CHOICE IN PART C

   A descriptive section sets more questions than a candidate has to
   answer, and Indian university papers do that in two quite different
   ways. Until now the product understood only a third way, which is
   neither of them.

   **any_n** — "Answer any TWO of the following four."
       The candidate picks which two. Once two are answered the other
       two are closed: the paper asks for two, so two is what it
       takes. Answering a third is not generosity, it is a candidate
       spending twenty minutes on something that cannot be marked.

   **either_or** — "Answer 1 OR 2" and "Answer 3 OR 4."
       The choice is inside each pair, not across the paper. A
       candidate may answer 1 and 4, or 2 and 3 — but never 1 and 2,
       because those two are alternatives to each other. The pairing
       is on the questions, not on the section, because questions are
       drawn from the bank and the cell decides which of them stand
       against each other.

   **best_n** — what this product did before: answer as many as you
       like, the highest N count. Kept, because papers already set
       this way must not change under their candidates, and because
       some cells do mark that way. It is no longer the default for a
       new paper.

   THIS FILE HAS A COPY at web/src/lib/choice.js, because the API and
   the web app are separate packages with no shared library. The copy
   is deliberate; both are tested with the same cases, and a test on
   each side asserts the two files are identical below this comment.
   Change one and change the other.

   One module, used four times: the examination screen locks what the
   candidate may not answer, the save route refuses it whatever the
   screen does, the upload route refuses it too, and the evaluator is
   shown which rule the paper was set under. A rule enforced in only
   one of those places is not a rule.
   ============================================================ */

export const CHOICE_MODES = ['best_n', 'any_n', 'either_or'];

/* Which questions stand against which.

   The cell sets `choiceGroup` on each question — "1", "2", whatever
   it likes; only equality matters. A paper set to either_or whose
   questions carry no group falls back to consecutive pairs, which is
   what "1 or 2, 3 or 4" means and what the builder writes by
   default. Without that fallback a paper imported or seeded without
   groups would silently behave as though every question were its own
   alternative, which is to say no rule at all. */
export function groupsFor(questions = []) {
  const groups = new Map();
  questions.forEach((q, i) => {
    /* Keyed on the question's own ORDER, never on its position in
       this array.

       The array differs between the two places this runs: the
       examination screen receives the questions shuffled per
       candidate, the API reads them sorted by order. Keyed on
       position, the two sides paired DIFFERENT questions — and
       differently for every candidate, because the shuffle is seeded
       on the attempt id. The screen then offered a question the API
       refused on every autosave, and closed one the API would have
       taken. Two of four questions unusable, and the candidate's
       Part C lost. */
    const key = q.choiceGroup != null && String(q.choiceGroup).trim() !== ''
      ? String(q.choiceGroup)
      : `auto-${Math.floor((q.order ?? i) / 2)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(q);
  });

  /* An odd question out does not become compulsory by accident.

     Five questions pair as 1|2, 3|4 and then 5 alone — and a group of
     one closes nothing and is closed by nothing, so question 5 has to
     be answered while the paper says "answer one from each pair". It
     joins the pair before it instead: "3 or 4 or 5". The builder
     refuses an odd count outright; this is for papers that already
     have one. */
  if (groups.size > 1) {
    const keys = [...groups.keys()];
    const last = keys[keys.length - 1];
    if (groups.get(last).length === 1 && last.startsWith('auto-')) {
      const prev = keys[keys.length - 2];
      groups.get(prev).push(...groups.get(last));
      groups.delete(last);
    }
  }
  return groups;
}

/* How many answers this section will accept in total. */
export function allowedAnswers(section, questions = []) {
  const mode = section?.choiceMode || 'best_n';
  if (mode === 'either_or') return groupsFor(questions).size;
  return section?.answerCount || questions.length;
}

/* What the candidate may still write in.

   `answered` is a Set of question ids that currently hold something.
   Returns a Map of questionId -> { reason, blockedBy } for every
   question that is CLOSED. A question that is itself answered is
   never closed — otherwise a candidate could not change their mind,
   and changing their mind is the entire point of a choice. */
export function closedQuestions(section, questions = [], answered = new Set()) {
  const mode = section?.choiceMode || 'best_n';
  const shut = new Map();
  if (mode === 'best_n') return shut;

  const isAnswered = (q) => answered.has(String(q.id ?? q._id));

  if (mode === 'either_or') {
    for (const [, members] of groupsFor(questions)) {
      const taken = members.filter(isAnswered);
      if (!taken.length) continue;
      /* The first answered question in the pair holds it. If somehow
         two are answered — legacy data, or a save that slipped
         through before this existed — neither is closed, so the
         candidate can resolve it themselves rather than being stuck
         with two answers they cannot remove. */
      if (taken.length > 1) continue;
      for (const q of members) {
        if (isAnswered(q)) continue;
        shut.set(String(q.id ?? q._id), { reason: 'alternative', blockedBy: String(taken[0].id ?? taken[0]._id) });
      }
    }
    return shut;
  }

  // any_n
  const limit = allowedAnswers(section, questions);
  const count = questions.filter(isAnswered).length;
  if (count < limit) return shut;
  for (const q of questions) {
    if (isAnswered(q)) continue;
    shut.set(String(q.id ?? q._id), { reason: 'limit', limit });
  }
  return shut;
}

/* How many answers are COUNTED when the script is marked.

   The same number the rule enforces, and that is the point: these
   were two different numbers. Enforcement counted pairs; best-N
   counted the section's `answerCount`, which the builder set once
   when the mode was chosen and never recomputed when the question
   count changed. A six-question either/or paper demanded three
   answers, told the cell it demanded three, and marked the best two —
   so a candidate who did exactly what the paper asked lost a whole
   question and nothing reported it. */
export function countedAnswers(section, questions = []) {
  return allowedAnswers(section, questions);
}

/* The sentence the candidate reads at the top of the section, and the
   one the evaluator reads on the script. */
export function choiceLabel(section, questions = []) {
  const mode = section?.choiceMode || 'best_n';
  const total = questions.length || section?.count || 0;
  if (mode === 'either_or') {
    const n = groupsFor(questions).size;
    return `Answer one from each pair — ${n} answer${n === 1 ? '' : 's'} in all`;
  }
  const n = allowedAnswers(section, questions);
  if (mode === 'any_n') return `Answer any ${n} of ${total}`;
  return `Answer any ${n} of ${total} — the best ${n} are counted`;
}

/* Would this change leave the candidate holding more than the paper
   allows? Used by the save and upload routes, which must refuse what
   the screen merely greys out.

   Clearing an answer is always allowed. Only ADDING one can break a
   rule, so a change that leaves the question empty is waved through —
   that is how a candidate swaps question 1 for question 2. */
export function refuseWrite({ section, questions, answered, questionId, willBeAnswered }) {
  if (!willBeAnswered) return null;
  if (answered.has(String(questionId))) return null;      // already theirs
  const shut = closedQuestions(section, questions, answered);
  const hit = shut.get(String(questionId));
  if (!hit) return null;

  if (hit.reason === 'alternative') {
    /* No question number. The paper may be shuffled per candidate, so
       the stored order is not what is printed on their screen — and a
       message pointing at "question 2" when their question 2 is
       something else is worse than one that points at nothing. */
    return 'You have already answered the question this one stands against, and the paper counts'
      + ' one of the two. Clear that answer first if you would rather answer this one.';
  }
  return `This part asks for ${hit.limit} answer${hit.limit === 1 ? '' : 's'} and you have given ${hit.limit}.`
    + ' Clear one of them if you would rather answer this question instead.';
}
