/* ============================================================
   CHOICE IN PART C

   Two conventions the product did not understand:

     "Answer any TWO of the following four"  — pick two, and only two
     "Answer 1 OR 2, and 3 OR 4"             — one from each pair

   Both are rules about what a candidate may write, so both have to
   hold in the examination screen, in the save route and in the
   upload route. These test the one module all three use.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  closedQuestions, allowedAnswers, countedAnswers, choiceLabel, refuseWrite, groupsFor,
} from '../utils/choice.js';

const Q = (id, order, group) => ({ id, order, choiceGroup: group });
const FOUR = [Q('q1', 0), Q('q2', 1), Q('q3', 2), Q('q4', 3)];
const PAIRED = [Q('q1', 0, '1'), Q('q2', 1, '1'), Q('q3', 2, '2'), Q('q4', 3, '2')];

/* ---------------- any N of four ---------------- */
const ANY2 = { key: 'C', type: 'desc', answerCount: 2, choiceMode: 'any_n' };

test('nothing is closed before the candidate has answered anything', () => {
  assert.equal(closedQuestions(ANY2, FOUR, new Set()).size, 0);
});

test('one answer still leaves the rest open', () => {
  assert.equal(closedQuestions(ANY2, FOUR, new Set(['q1'])).size, 0);
});

test('the second answer closes the other two', () => {
  const shut = closedQuestions(ANY2, FOUR, new Set(['q1', 'q3']));
  assert.deepEqual([...shut.keys()].sort(), ['q2', 'q4'],
    'the paper asks for two; a third cannot be marked, so it is not invited');
  assert.equal(shut.get('q2').reason, 'limit');
  assert.ok(!shut.has('q1'), 'an answered question is never closed — the candidate may change it');
});

test('clearing one opens the others again', () => {
  assert.equal(closedQuestions(ANY2, FOUR, new Set(['q1'])).size, 0,
    'changing your mind is the whole point of a choice');
});

/* ---------------- either / or ---------------- */
const EITHER = { key: 'C', type: 'desc', answerCount: 2, choiceMode: 'either_or' };

test('answering one of a pair closes its alternative, and only that', () => {
  const shut = closedQuestions(EITHER, PAIRED, new Set(['q1']));
  assert.deepEqual([...shut.keys()], ['q2'], 'q3 and q4 are a different pair and stay open');
  assert.equal(shut.get('q2').reason, 'alternative');
  assert.equal(shut.get('q2').blockedBy, 'q1');
});

test('one from each pair is allowed — 1 and 4 together', () => {
  const shut = closedQuestions(EITHER, PAIRED, new Set(['q1', 'q4']));
  assert.deepEqual([...shut.keys()].sort(), ['q2', 'q3']);
});

test('a paper with no groups set falls back to consecutive pairs', () => {
  /* "1 or 2, 3 or 4" is what the words mean, and it is what the
     builder writes. Without the fallback, a seeded or imported paper
     would behave as though there were no rule at all. */
  assert.equal(groupsFor(FOUR).size, 2);
  const shut = closedQuestions(EITHER, FOUR, new Set(['q3']));
  assert.deepEqual([...shut.keys()], ['q4']);
});

test('two answers already in one pair leave the candidate able to fix it', () => {
  const shut = closedQuestions(EITHER, PAIRED, new Set(['q1', 'q2']));
  assert.equal(shut.has('q1'), false);
  assert.equal(shut.has('q2'), false);
});

/* ---------------- the old behaviour is untouched ---------------- */
test('a paper set to best-N closes nothing, as it always did', () => {
  const best = { key: 'C', answerCount: 2, choiceMode: 'best_n' };
  assert.equal(closedQuestions(best, FOUR, new Set(['q1', 'q2', 'q3'])).size, 0);
  assert.equal(closedQuestions({ key: 'C', answerCount: 2 }, FOUR, new Set(['q1', 'q2'])).size, 0,
    'and a section saved before this existed has no mode at all');
});

/* ---------------- how many answers ---------------- */
test('how many the section accepts', () => {
  assert.equal(allowedAnswers(ANY2, FOUR), 2);
  assert.equal(allowedAnswers(EITHER, PAIRED), 2, 'one per pair');
  assert.equal(allowedAnswers({ choiceMode: 'either_or' }, [Q('a', 0, 'x'), Q('b', 1, 'x')]), 1);
});

/* ---------------- what the server refuses ---------------- */
test('the save route refuses a third answer, and says what to do', () => {
  const msg = refuseWrite({
    section: ANY2, questions: FOUR, answered: new Set(['q1', 'q3']),
    questionId: 'q2', willBeAnswered: true,
  });
  assert.match(msg, /asks for 2 answers and you have given 2/);
  assert.match(msg, /Clear one of them/);
});

test('the save route refuses the alternative, and says what to do about it', () => {
  const msg = refuseWrite({
    section: EITHER, questions: PAIRED, answered: new Set(['q1']),
    questionId: 'q2', willBeAnswered: true,
  });
  assert.match(msg, /the question this one stands against/);
  assert.match(msg, /Clear that answer first/);
  /* Deliberately no question NUMBER: the paper may be shuffled per
     candidate, so the stored order is not what is on their screen. */
  assert.doesNotMatch(msg, /question \d/);
});

test('the pairing survives a shuffle, because it is keyed on the question', () => {
  /* The examination screen receives the questions shuffled per
     candidate; the API reads them sorted by order. Keyed on array
     position the two sides paired DIFFERENT questions, so the screen
     offered one the API refused and closed one it would have taken. */
  const asStored = [Q('q1', 0), Q('q2', 1), Q('q3', 2), Q('q4', 3)];
  const asShown  = [Q('q3', 2), Q('q1', 0), Q('q4', 3), Q('q2', 1)];

  const pairs = (qs) => [...groupsFor(qs).values()]
    .map((g) => g.map((q) => q.id).sort().join('|')).sort();
  assert.deepEqual(pairs(asShown), pairs(asStored), 'the same pairs, whatever the order');

  const answered = new Set(['q1']);
  assert.deepEqual([...closedQuestions(EITHER, asShown, answered).keys()], ['q2']);
  assert.deepEqual([...closedQuestions(EITHER, asStored, answered).keys()], ['q2']);
});

test('an odd question out joins the pair before it, rather than becoming compulsory', () => {
  /* Alone in its own group, question 5 closes nothing and is closed
     by nothing — so it has to be answered, on a paper that says
     "answer one from each pair". */
  const five = [Q('q1', 0), Q('q2', 1), Q('q3', 2), Q('q4', 3), Q('q5', 4)];
  assert.equal(groupsFor(five).size, 2, '1 or 2, and 3 or 4 or 5');
  assert.equal(allowedAnswers(EITHER, five), 2);
  assert.deepEqual([...closedQuestions(EITHER, five, new Set(['q5'])).keys()].sort(), ['q3', 'q4']);
});

test('clearing an answer is never refused', () => {
  assert.equal(refuseWrite({
    section: ANY2, questions: FOUR, answered: new Set(['q1', 'q3']),
    questionId: 'q2', willBeAnswered: false,
  }), null);
  assert.equal(refuseWrite({
    section: ANY2, questions: FOUR, answered: new Set(['q1', 'q3']),
    questionId: 'q1', willBeAnswered: true,
  }), null, 'and editing one you already hold is not a new answer');
});

/* ---------------- what everyone reads ---------------- */
test('the rule is stated in words, not left to be inferred', () => {
  assert.equal(choiceLabel(ANY2, FOUR), 'Answer any 2 of 4');
  assert.equal(choiceLabel(EITHER, PAIRED), 'Answer one from each pair — 2 answers in all');
  assert.match(choiceLabel({ answerCount: 2 }, FOUR), /best 2 are counted/);
});

/* ============================================================
   THE TWO COPIES MUST NOT DRIFT

   This rule lives in two files, because the API and the web app are
   separate packages. The cases above and their twins in
   web/src/test/choice.test.jsx catch a change in BEHAVIOUR; this
   catches a change in code the cases happen not to cover — which is
   the one that would ship.

   Asserted from both sides on purpose. The web package's copy of this
   test cannot fail `cd server && npm test`, so someone working only
   in the API would never see it.
   ============================================================ */
test('the API and the examination screen hold the same rule, line for line', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const webPath = new URL('../../../web/src/lib/choice.js', import.meta.url);
  if (!existsSync(webPath)) return;        // API checked out on its own

  const body = (u) => {
    const src = readFileSync(u, 'utf8');
    /* Everything below the opening comment: the two headers differ on
       purpose, each pointing at the other. */
    return src.slice(src.indexOf('export const CHOICE_MODES'));
  };
  assert.equal(
    body(new URL('../utils/choice.js', import.meta.url)),
    body(webPath),
    'server/src/utils/choice.js and web/src/lib/choice.js have diverged — change both',
  );
});

/* ============================================================
   THE RULE AND THE MARK MUST AGREE

   These were two different numbers. Enforcement counted pairs;
   best-N counted the section's stored `answerCount`, which the
   builder set once when the rule was chosen and never recomputed. A
   six-question either/or paper demanded three answers, told the cell
   it demanded three, and marked the best two — so a candidate who did
   exactly what the paper asked lost ten marks, and nothing anywhere
   reported it.
   ============================================================ */
test('an either/or paper counts one answer per pair, not a stale answerCount', () => {
  const six = [Q('q1', 0), Q('q2', 1), Q('q3', 2), Q('q4', 3), Q('q5', 4), Q('q6', 5)];
  /* `answerCount: 2` is what the builder left behind when the cell
     raised the question count from four to six. */
  const stale = { key: 'C', type: 'desc', answerCount: 2, choiceMode: 'either_or' };
  assert.equal(countedAnswers(stale, six), 3, 'three pairs, three answers, three marked');
  assert.equal(allowedAnswers(stale, six), countedAnswers(stale, six),
    'what the paper takes and what the marking counts are one number');
});

test('any-N still counts what the section asks for', () => {
  assert.equal(countedAnswers(ANY2, FOUR), 2);
  assert.equal(countedAnswers({ answerCount: 2 }, FOUR), 2, 'and so does a best-N paper');
});
