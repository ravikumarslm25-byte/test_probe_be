/* ============================================================
   The parts that can be checked without a database.

       node --test src/test/

   Everything here is pure: script sharing, file sniffing, name
   cleaning, upload rules and the timezone maths. The routes that need
   MongoDB are not covered — those are exercised against a real
   database.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { validateUpload } from '../services/storage.js';
import { sniff, cleanName } from '../routes/upload.routes.js';
import { zonedToUtc, utcToZoned, examStartAt } from '../utils/time.js';
import { dueStatus, hasStatusFields } from '../utils/examStatus.js';
import { sanitiseAnswerHtml, stripTags } from '../utils/sanitise.js';
import { sittingFor, lastSittingEnd } from '../utils/sitting.js';
import {
  attendanceState, isPresent, countsAsAttended, lateByMinutes, isLate, minutesSat, howItEnded,
} from '../utils/attendance.js';
import { mayContinue } from '../services/closeExam.js';
import { decidePass } from '../services/finalise.js';

/* ---------------- what a scan may be ---------------- */

test('a phone scanner PDF is accepted', () => {
  assert.equal(validateUpload('scan', 'application/pdf', 4_000_000), null);
});

test('a photograph is accepted', () => {
  assert.equal(validateUpload('scan', 'image/jpeg', 2_000_000), null);
  assert.equal(validateUpload('scan', 'image/heic', 2_000_000), null);
});

test('a scan over twenty megabytes is refused, with the limit named', () => {
  const problem = validateUpload('scan', 'application/pdf', 24_000_000);
  assert.ok(problem, 'should be refused');
  assert.match(problem, /exceeds/);
});

test('an executable dressed as a scan is refused', () => {
  assert.ok(validateUpload('scan', 'application/x-msdownload', 1000));
  assert.ok(validateUpload('scan', 'text/html', 1000));
});

/* ---------------- sniffing the bytes ---------------- */

const pad = (head) => Buffer.concat([Buffer.from(head), Buffer.alloc(16)]);

test('a PDF is recognised by its own first bytes', () => {
  assert.equal(sniff(pad('%PDF-1.7')), 'application/pdf');
});

test('JPEG, PNG and WEBP are recognised', () => {
  assert.equal(sniff(pad([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniff(pad([0x89, 0x50, 0x4e, 0x47])), 'image/png');
  assert.equal(sniff(Buffer.concat([
    Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8),
  ])), 'image/webp');
});

test('an iPhone HEIC photograph is recognised', () => {
  assert.equal(sniff(Buffer.concat([
    Buffer.alloc(4), Buffer.from('ftyp'), Buffer.from('heic'), Buffer.alloc(8),
  ])), 'image/heic');
});

test('something unrecognised returns null rather than guessing', () => {
  assert.equal(sniff(pad('not a file at all')), null);
  assert.equal(sniff(Buffer.alloc(4)), null, 'too short to judge');
});

test('a PDF mislabelled as a photograph is caught', () => {
  /* The route refuses when the sniffed type and the declared type
     disagree across the PDF boundary, which is the case that would
     otherwise leave an evaluator with a page that will not render. */
  const buf = pad('%PDF-1.4');
  const declared = 'image/jpeg';
  const actual = sniff(buf);
  assert.equal(actual, 'application/pdf');
  assert.notEqual(actual, declared);
});

/* ---------------- the name off the candidate's phone ---------------- */

test('a file name is stripped to something harmless', () => {
  assert.equal(cleanName('answer.pdf'), 'answer.pdf');
  assert.equal(cleanName('../../etc/passwd'), '....etcpasswd');
  assert.equal(cleanName('page<script>alert(1)</script>.jpg'), 'pagescriptalert1script.jpg');
  assert.equal(cleanName('  spaced   out  .pdf'), 'spaced out .pdf');
});

test('an empty or missing name becomes null, so a default is used', () => {
  assert.equal(cleanName(''), null);
  assert.equal(cleanName(undefined), null);
  assert.equal(cleanName('%%%'), null);
});

test('a very long name is cut', () => {
  assert.ok(cleanName('a'.repeat(300)).length <= 80);
});

/* ---------------- candidate HTML reaching a member of staff ----------------

   An answer is rendered as HTML in the evaluator's own session, so
   anything that survives here runs with their privileges. The editor
   can be bypassed by posting to the answer endpoint directly, so
   "the editor would never produce that" is not a defence.           */

test('a script tag does not survive', () => {
  assert.equal(sanitiseAnswerHtml('<script>steal()</script>'), '');
  assert.equal(sanitiseAnswerHtml('a<script>steal()</script>b'), 'ab');
});

test('an event handler does not survive', () => {
  const out = sanitiseAnswerHtml('<img src=x onerror="fetch(\'//evil\')">');
  assert.ok(!/onerror/i.test(out), out);
  assert.ok(!/<img/i.test(out), out);
});

test('the handler is gone even on a tag that is allowed', () => {
  const out = sanitiseAnswerHtml('<span onmouseover="steal()" style="color:#ff0000">text</span>');
  assert.ok(!/onmouseover/i.test(out), out);
  assert.match(out, /text/);
});

test('an iframe, object, link and form do not survive', () => {
  for (const bad of [
    '<iframe src="//evil"></iframe>',
    '<object data="//evil"></object>',
    '<a href="javascript:steal()">x</a>',
    '<form action="//evil"><input name="p"></form>',
    '<svg><animate onbegin="steal()"/></svg>',
    '<style>body{display:none}</style>',
  ]) {
    const out = sanitiseAnswerHtml(bad);
    assert.ok(!/<(iframe|object|a |a>|form|input|svg|animate|style)/i.test(out), `${bad} -> ${out}`);
    assert.ok(!/javascript:/i.test(out), `${bad} -> ${out}`);
    assert.ok(!/onbegin/i.test(out), `${bad} -> ${out}`);
  }
});

test('the formatting a candidate actually uses is kept', () => {
  const written = '<b>Newton</b>&rsquo;s <i>second</i> law: F = m<sup>1</sup>a<sub>net</sub>'
    + '<ul><li>point one</li><li>point two</li></ul>'
    + '<span style="color:#2655A5">in blue</span>'
    + '<font color="#0C8E44" size="5">in green</font>';
  const out = sanitiseAnswerHtml(written);
  for (const tag of ['<b>', '<i>', '<sup>', '<sub>', '<ul>', '<li>', '<span', '<font']) {
    assert.ok(out.includes(tag), `${tag} should survive: ${out}`);
  }
  assert.match(out, /color/);
  assert.match(out, /Newton/);
  assert.match(out, /point two/);
});

test('a style that is not a colour or a size does not survive', () => {
  const out = sanitiseAnswerHtml(
    '<span style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:#fff">cover</span>');
  assert.ok(!/position/i.test(out), out);
  assert.ok(!/100vw/i.test(out), out);
  assert.match(out, /cover/);
});

test('the plain-text field is reduced to text', () => {
  assert.equal(stripTags('<img src=x onerror=steal()>plain'), 'plain');
  assert.equal(stripTags('F = ma'), 'F = ma');
});

test('nothing is invented out of nothing', () => {
  assert.equal(sanitiseAnswerHtml(''), '');
  assert.equal(sanitiseAnswerHtml(undefined), undefined);
  assert.equal(sanitiseAnswerHtml(null), null);
  assert.equal(stripTags(undefined), undefined);
});

/* ---------------- time, which the whole product depends on ---------------- */

test('a written time becomes the right instant in the institution zone', () => {
  assert.equal(zonedToUtc('2026-09-28', '14:00', 'Asia/Kolkata').toISOString(),
    '2026-09-28T08:30:00.000Z');
});

test('a zone with daylight saving is right on both sides of the change', () => {
  assert.equal(zonedToUtc('2026-07-01', '09:00', 'Europe/London').toISOString(),
    '2026-07-01T08:00:00.000Z');
  assert.equal(zonedToUtc('2026-12-01', '09:00', 'Europe/London').toISOString(),
    '2026-12-01T09:00:00.000Z');
});

test('an instant reads back as the same wall clock', () => {
  const back = utcToZoned(new Date('2026-09-28T08:30:00.000Z'), 'Asia/Kolkata');
  assert.deepEqual(back, { date: '2026-09-28', time: '14:00' });
});

/* ---------------- status follows the clock ---------------- */

const paper = (startsAt, durationMinutes = 120, status = 'scheduled') =>
  ({ startsAt, durationMinutes, status });

test('a paper is upcoming before it starts and live once it does', () => {
  const start = new Date('2026-09-28T08:30:00.000Z');
  assert.equal(dueStatus(paper(start), { at: new Date('2026-09-28T08:00:00Z') }), 'scheduled');
  assert.equal(dueStatus(paper(start), { at: new Date('2026-09-28T08:30:00Z') }), 'live');
  assert.equal(dueStatus(paper(start), { at: new Date('2026-09-28T10:00:00Z') }), 'live');
});

test('a paper moves to evaluation shortly after it ends, not 45 minutes later', () => {
  /* This test used to assert the opposite, and the opposite was the
     bug: a flat forty-five-minute room-close buffer kept a finished
     paper reading "In progress" with an empty hall. The buffer stood
     in for late joiners and extensions, which are now covered
     exactly, so only a short grace remains for the last candidate
     pressing Submit. */
  const start = new Date('2026-09-28T08:30:00.000Z');       // ends 10:30Z
  assert.equal(dueStatus(paper(start), { at: new Date('2026-09-28T10:20:00Z') }), 'live');
  assert.equal(dueStatus(paper(start), { at: new Date('2026-09-28T10:33:00Z') }), 'live',
    'a short grace, for whoever is mid-submit');
  assert.equal(dueStatus(paper(start), { at: new Date('2026-09-28T10:40:00Z') }), 'evaluation');
  assert.equal(dueStatus(paper(start), { at: new Date('2026-09-28T11:00:00Z') }), 'evaluation',
    'and certainly not still "in progress" half an hour later');
});

test('a status someone set by hand is never overridden by the clock', () => {
  const start = new Date('2026-09-28T08:30:00.000Z');
  for (const s of ['draft', 'closed', 'evaluation', 'published']) {
    assert.equal(dueStatus(paper(start, 120, s), { at: new Date('2030-01-01T00:00:00Z') }), s);
  }
});

test('a paper with no instant keeps the status it has', () => {
  assert.equal(dueStatus({ status: 'scheduled', durationMinutes: 60 }), 'scheduled');
  assert.equal(examStartAt(null), null);
});

/* ---------------- a candidate sitting in their own window ----------------

   The cell's request: the paper runs 10:00–12:00, but two working
   professionals sit it 14:00–16:00. Same paper, same marks, different
   window. Every gate that decides "may this candidate begin, and when
   does their time end" has to read THEIR window, not the paper's. */

const paperAt = (iso, durationMinutes = 120) => ({
  startsAt: new Date(iso), durationMinutes, status: 'scheduled',
});

test('a candidate with no sitting of their own uses the examination window', () => {
  const exam = paperAt('2026-10-08T04:30:00.000Z');          // 10:00 IST
  const s = sittingFor({}, exam);
  assert.equal(s.isAlternate, false);
  assert.equal(s.startAt.toISOString(), '2026-10-08T04:30:00.000Z');
  assert.equal(s.endsAt.toISOString(), '2026-10-08T06:30:00.000Z');
  assert.equal(s.durationMinutes, 120);
});

test('a candidate given their own window uses it, not the examination’s', () => {
  const exam = paperAt('2026-10-08T04:30:00.000Z');
  const attempt = { sitting: { startsAt: new Date('2026-10-08T08:30:00.000Z'), reason: 'works days' } };
  const s = sittingFor(attempt, exam);
  assert.equal(s.isAlternate, true);
  assert.equal(s.startAt.toISOString(), '2026-10-08T08:30:00.000Z');   // 14:00 IST
  assert.equal(s.endsAt.toISOString(), '2026-10-08T10:30:00.000Z');    // 16:00 IST
  assert.equal(s.durationMinutes, 120, 'the paper’s duration carries over');
  assert.equal(s.reason, 'works days');
});

test('a sitting may carry its own duration', () => {
  const exam = paperAt('2026-10-08T04:30:00.000Z', 120);
  const s = sittingFor({ sitting: { startsAt: new Date('2026-10-08T08:30:00.000Z'), durationMinutes: 90 } }, exam);
  assert.equal(s.durationMinutes, 90);
  assert.equal(s.endsAt.toISOString(), '2026-10-08T10:00:00.000Z');
});

test('the paper stays live until the last sitting finishes', () => {
  /* Without this the paper moved to evaluation at the end of the
     ordinary window, dropped off the invigilator's live wall, and
     nobody was watching the people sitting it that afternoon. */
  const exam = { ...paperAt('2026-10-08T04:30:00.000Z'), status: 'live' };
  const atAfternoon = new Date('2026-10-08T09:00:00.000Z');            // 14:30 IST

  assert.equal(dueStatus(exam, { at: atAfternoon }), 'evaluation',
    'with no alternate sitting it is over');

  const withSitting = { ...exam, lastSittingEndsAt: new Date('2026-10-08T10:30:00.000Z') };
  assert.equal(dueStatus(withSitting, { at: atAfternoon }), 'live',
    'a pending alternate sitting keeps it live');
  assert.equal(dueStatus(withSitting, { at: new Date('2026-10-08T11:30:00.000Z') }), 'evaluation',
    'and it ends once that sitting is over and the room buffer has passed');
});

test('an alternate sitting earlier than the paper never shortens it', () => {
  const exam = paperAt('2026-10-08T04:30:00.000Z');
  const end = lastSittingEnd(exam, [new Date('2026-10-08T05:00:00.000Z')]);
  assert.equal(end.toISOString(), '2026-10-08T06:30:00.000Z',
    'the ordinary window still runs to its own end');
});

test('lastSittingEnd copes with nothing, and with rubbish', () => {
  const exam = paperAt('2026-10-08T04:30:00.000Z');
  assert.equal(lastSittingEnd(exam, []).toISOString(), '2026-10-08T06:30:00.000Z');
  assert.equal(lastSittingEnd(exam, [null, undefined]).toISOString(), '2026-10-08T06:30:00.000Z');
});

/* ---------------- reading attendance off an attempt ----------------

   There is no attendance flag; attendance is a reading of timestamps.
   Both registers go through these helpers, because the summary and
   the candidate-by-candidate list disagreeing by one is the kind of
   thing a controller of examinations notices and nobody can explain. */

const EXAM = { startsAt: new Date('2026-10-08T04:30:00.000Z'), durationMinutes: 120 };  // 10:00 IST

test('a candidate who submitted is present', () => {
  assert.equal(attendanceState({ status: 'submitted' }), 'Present');
  assert.ok(isPresent(attendanceState({ status: 'submitted' })));
});

test('a candidate still writing is present', () => {
  assert.equal(attendanceState({ status: 'in_progress' }), 'Present (still writing)');
  assert.ok(isPresent(attendanceState({ status: 'in_progress' })));
});

test('a candidate who never started is ABSENT, even after verifying', () => {
  /* They stood at the door. Counting a verified-but-never-started
     candidate as present inflates the one number in this report
     nobody may get wrong. */
  assert.equal(attendanceState({ status: 'not_started' }), 'Absent');
  assert.equal(attendanceState({ status: 'verifying', joinedAt: new Date() }), 'Absent');
  assert.equal(attendanceState({ status: 'verifying', identity: { verifiedAt: new Date() } }), 'Absent');
  assert.equal(attendanceState(null), 'Absent');
});

test('a disqualified candidate was present, and counts toward attendance', () => {
  const s = attendanceState({ status: 'terminated' });
  assert.equal(s, 'Disqualified');
  assert.equal(isPresent(s), false, 'not "present" in the register');
  assert.equal(countsAsAttended(s), true, 'but they were in the hall');
});

test('lateness is measured from the examination start', () => {
  assert.equal(lateByMinutes({ startedAt: new Date('2026-10-08T04:30:00.000Z') }, EXAM), 0);
  assert.equal(lateByMinutes({ startedAt: new Date('2026-10-08T04:42:00.000Z') }, EXAM), 12);
  assert.equal(lateByMinutes({ startedAt: new Date('2026-10-08T05:00:00.000Z') }, EXAM), 30);
});

test('a candidate who never started is not late, it is null', () => {
  assert.equal(lateByMinutes({ status: 'not_started' }, EXAM), null);
  assert.equal(isLate({ status: 'not_started' }, EXAM), false);
});

test('starting early is zero, never negative', () => {
  assert.equal(lateByMinutes({ startedAt: new Date('2026-10-08T04:25:00.000Z') }, EXAM), 0);
});

test('a candidate on their OWN sitting is late against THEIR start', () => {
  /* The bug this replaces: measured against the examination, someone
     sitting at 14:00 by arrangement was reported four hours late in
     every attendance report. */
  const attempt = {
    status: 'submitted',
    startedAt: new Date('2026-10-08T08:35:00.000Z'),          // 14:05 IST
    sitting: { startsAt: new Date('2026-10-08T08:30:00.000Z') }, // their 14:00
  };
  assert.equal(lateByMinutes(attempt, EXAM), 5, 'five minutes, not four hours');
  assert.equal(isLate(attempt, EXAM, 15), false);
});

test('the late threshold is the entry cut-off', () => {
  const at = (iso) => ({ startedAt: new Date(iso) });
  assert.equal(isLate(at('2026-10-08T04:44:00.000Z'), EXAM, 15), false, '14 minutes is not late');
  assert.equal(isLate(at('2026-10-08T04:46:00.000Z'), EXAM, 15), true, '16 minutes is');
  assert.equal(isLate(at('2026-10-08T04:35:00.000Z'), EXAM, 2), true, 'a tighter cut-off catches 5');
});

test('minutes sat needs both ends', () => {
  assert.equal(minutesSat({
    startedAt: new Date('2026-10-08T04:30:00.000Z'),
    submittedAt: new Date('2026-10-08T06:12:00.000Z'),
  }), 102);
  assert.equal(minutesSat({ startedAt: new Date() }), null, 'still writing');
  assert.equal(minutesSat({}), null);
});

test('how the paper ended reads as a register would write it', () => {
  assert.equal(howItEnded({ status: 'submitted', submittedAt: new Date() }), 'Submitted');
  assert.equal(howItEnded({ status: 'submitted', submittedAt: new Date(), autoSubmitted: true }),
    'Time expired');
  assert.equal(howItEnded({ status: 'terminated', terminationReason: 'Two faces in frame — S. Mani' }),
    'Two faces in frame — S. Mani');
  assert.equal(howItEnded({ status: 'terminated' }), 'Ended by invigilator');
  assert.equal(howItEnded({ status: 'not_started' }), '');
});

test('attendance percentage counts the disqualified as attended', () => {
  const states = ['Present', 'Present', 'Disqualified', 'Absent'].map((x) => x);
  const attended = states.filter((x) => countsAsAttended(x)).length;
  assert.equal(attended, 3, 'three of the four were in the hall');
  assert.equal(Math.round((attended / states.length) * 100), 75);
});

/* ---------------- ending a paper ----------------

   "Hand in your papers" must not break a promise the product already
   made. An extension granted by an invigilator and a sitting arranged
   by the cell are both entitlements to carry on; everyone else is
   simply still writing because nobody has stopped them. */

const PAPER = { startsAt: new Date('2026-10-08T03:00:00.000Z'), durationMinutes: 120 }; // 08:30 IST
const ENDED = new Date('2026-10-08T05:00:00.000Z');   // 10:30 IST, the paper's own end
const LATER = new Date('2026-10-08T05:40:00.000Z');   // 11:10 IST, when Ravi looked

test('an ordinary candidate still writing is sealed when the paper is ended', () => {
  const a = { status: 'in_progress', timerEndsAt: ENDED };
  assert.equal(mayContinue(a, PAPER, LATER).yes, false);
});

test('a candidate on an invigilator extension keeps writing', () => {
  const a = {
    status: 'in_progress',
    timerEndsAt: new Date('2026-10-08T05:50:00.000Z'),      // 11:20, still going
    timeExtension: { minutes: 20, reason: 'power cut in the hall' },
  };
  const r = mayContinue(a, PAPER, LATER);
  assert.equal(r.yes, true);
  assert.equal(r.why, 'extension');
  assert.equal(r.minutes, 20);
});

test('an extension that has itself run out does NOT keep them writing', () => {
  const a = {
    status: 'in_progress',
    timerEndsAt: new Date('2026-10-08T05:20:00.000Z'),      // 10:50, already past
    timeExtension: { minutes: 20, reason: 'power cut' },
  };
  assert.equal(mayContinue(a, PAPER, LATER).yes, false,
    'the entitlement was to twenty minutes, not to for ever');
});

test('a candidate on an alternate sitting keeps writing', () => {
  const a = {
    status: 'in_progress',
    timerEndsAt: new Date('2026-10-08T10:30:00.000Z'),
    sitting: { startsAt: new Date('2026-10-08T08:30:00.000Z'), durationMinutes: 120 },
  };
  const r = mayContinue(a, PAPER, LATER);
  assert.equal(r.yes, true);
  assert.equal(r.why, 'sitting');
});

test('a sitting that is already over does not keep them writing', () => {
  const a = {
    status: 'in_progress',
    sitting: { startsAt: new Date('2026-10-08T02:00:00.000Z'), durationMinutes: 60 },
  };
  assert.equal(mayContinue(a, PAPER, LATER).yes, false);
});

test('no extension and no sitting is simply "nobody stopped them"', () => {
  assert.equal(mayContinue({ status: 'in_progress' }, PAPER, LATER).yes, false);
  assert.equal(mayContinue({ status: 'in_progress', timeExtension: {} }, PAPER, LATER).yes, false);
});

/* ---------------- and the status that misled ---------------- */

test('a finished paper does not read "in progress" for another 45 minutes', () => {
  /* The paper ran 08:30–10:30. At 11:10 the list still said "In
     progress", because the status carried a flat forty-five-minute
     room-close buffer on top of the end. */
  const exam = { ...PAPER, status: 'live' };
  assert.equal(dueStatus(exam, { at: new Date('2026-10-08T04:30:00.000Z') }), 'live',
    '10:00, still being sat');
  assert.equal(dueStatus(exam, { at: LATER }), 'evaluation',
    '11:10 — the hall is empty and the list must say so');
});

test('but it stays live while an extension is outstanding', () => {
  const exam = {
    ...PAPER, status: 'live',
    writingUntil: new Date('2026-10-08T05:50:00.000Z'),   // someone has until 11:20
  };
  assert.equal(dueStatus(exam, { at: LATER }), 'live',
    'someone is still writing, and the invigilator must still see them');
  assert.equal(dueStatus(exam, { at: new Date('2026-10-08T06:10:00.000Z') }), 'evaluation',
    'and it ends once they are done');
});

test('ending it by hand overrides the clock immediately', () => {
  const exam = {
    ...PAPER, status: 'live',
    closedAt: new Date('2026-10-08T04:00:00.000Z'),       // ended early, at 09:30
  };
  assert.equal(dueStatus(exam, { at: new Date('2026-10-08T04:05:00.000Z') }), 'evaluation',
    'the cell said the paper is over; the clock does not get a vote');
});

test('a paper ended by hand does not spring back to life', () => {
  const exam = { ...PAPER, status: 'live', closedAt: ENDED };
  for (const at of ['2026-10-08T05:01:00.000Z', '2026-10-08T09:00:00.000Z']) {
    assert.equal(dueStatus(exam, { at: new Date(at) }), 'evaluation');
  }
});

/* ============================================================
   PASS OR FAIL AT THE MOMENT A PAPER IS SEALED

   These exist because of a real published result: a paper with no
   descriptive section reaches no evaluator, so the pass flag the
   evaluation screen would have computed was never computed, and the
   placeholder went out as a fail for the whole cohort.
   ============================================================ */
test('an objective-only paper is decided when it is sealed, not left as a fail', () => {
  assert.equal(decidePass({ total: 72, passMark: 40, descNeedsEval: false }), true,
    '72 out of a 40 pass mark is a pass, and nobody else is going to say so');
  assert.equal(decidePass({ total: 31, passMark: 40, descNeedsEval: false }), false);
});

test('the pass mark itself is a pass', () => {
  assert.equal(decidePass({ total: 40, passMark: 40, descNeedsEval: false }), true);
  assert.equal(decidePass({ total: 39.5, passMark: 40, descNeedsEval: false }), false);
});

test('a candidate who wrote nothing in Part C is decided on what they did write', () => {
  /* There is a descriptive section, but this script has no content in
     it — so no evaluator will ever open it either. */
  assert.equal(decidePass({ total: 45, passMark: 40, descNeedsEval: false }), true);
});

test('a script still to be evaluated is not called a fail', () => {
  assert.equal(decidePass({ total: 38, passMark: 40, descNeedsEval: true }), false,
    'false here is a placeholder the evaluator overwrites, not a result');
  assert.equal(decidePass({ total: 95, passMark: 40, descNeedsEval: true }), false,
    'and it stays a placeholder even when the objective marks alone would pass');
});

test('a paper with no usable pass mark is not passed by accident', () => {
  for (const passMark of [undefined, null, '', NaN, 'forty']) {
    assert.equal(decidePass({ total: 100, passMark, descNeedsEval: false }), false);
  }
});

test('a pass mark of zero does not pass the whole cohort', () => {
  /* A cleared field in the builder used to arrive as 0, and `>= 0`
     would have issued a pass to every candidate who turned up —
     including one who answered nothing. */
  assert.equal(decidePass({ total: 0, passMark: 0, descNeedsEval: false }), false);
  assert.equal(decidePass({ total: 70, passMark: 0, descNeedsEval: false }), false);
  assert.equal(decidePass({ total: 70, passMark: -5, descNeedsEval: false }), false);
});

test('a disqualified candidate is not passed by the marks they had collected', () => {
  assert.equal(
    decidePass({ total: 88, passMark: 40, descNeedsEval: false, status: 'terminated' }),
    false,
    'removed from the examination; the objective marks do not become a pass',
  );
  assert.equal(
    decidePass({ total: 88, passMark: 40, descNeedsEval: false, status: 'in_progress' }),
    true,
    'and an ordinary paper being sealed is unaffected',
  );
});

/* ============================================================
   IS THIS THE WHOLE PAPER, OR A PROJECTION OF IT?

   The guard that answers this froze an examination on "Scheduled"
   through its own sitting and past the end of it: three candidates
   sat the paper, submitted, and the list still read Scheduled the
   next morning while Live monitoring said "Not started yet".

   The reason is that `writingUntil`, `lastSittingEndsAt` and
   `closedAt` are only written when a sitting is granted or the paper
   is ended by hand. Until then MongoDB does not store those keys at
   all, and `.lean()` hands back exactly what is stored — so a
   perfectly complete, ordinary paper looked like a narrow projection
   and was left alone for ever.
   ============================================================ */
test('an ordinary paper that has never had a sitting or been closed is recognised', () => {
  /* What `.lean()` actually returns for a new paper: no closedAt, no
     writingUntil, no lastSittingEndsAt, because none was ever set. */
  const lean = {
    _id: 'e1', code: 'BAM754', status: 'scheduled',
    date: '2026-10-08', startTime: '13:30', durationMinutes: 120,
    timezone: 'Asia/Kolkata', startsAt: new Date('2026-10-08T08:00:00.000Z'),
    passMark: 20, totalMarks: 50, blueprint: { sections: [] },
    createdAt: new Date(), updatedAt: new Date(),
  };
  assert.equal(hasStatusFields(lean), true,
    'this is the whole document; the status must be allowed to follow the clock');
});

test('a paper that has finished moves on, rather than sitting on Scheduled', () => {
  const lean = {
    code: 'BAM754', status: 'scheduled', durationMinutes: 120,
    startsAt: new Date('2026-10-08T08:00:00.000Z'),      // 13:30 IST
    createdAt: new Date(), updatedAt: new Date(),
  };
  assert.equal(hasStatusFields(lean), true);
  assert.equal(dueStatus(lean, { at: new Date('2026-10-09T05:06:00.000Z') }), 'evaluation',
    'the next morning it is over, whatever it still says');
});

test('a genuinely narrow projection is still refused', () => {
  /* The failure this guard exists for: a status derived from a
     document that does not carry what it is derived from, and then
     WRITTEN BACK — past correction, because evaluation is
     workflow-driven. A projection has no timestamps unless asked. */
  const projected = { _id: 'e1', code: 'BAM754', status: 'live', durationMinutes: 120 };
  assert.equal(hasStatusFields(projected), false);
});

test('a projection that deliberately carries the status fields is accepted', () => {
  const widened = {
    _id: 'e1', code: 'BAM754', status: 'live', durationMinutes: 120,
    writingUntil: null, lastSittingEndsAt: null, closedAt: null,
  };
  assert.equal(hasStatusFields(widened), true);
});

test('the invigilation projection still carries everything the status needs', () => {
  /* This projection has now been the cause twice — once missing
     `blueprint`, once missing `passMark` — and both times the symptom
     was somewhere else entirely: a wrong status written back, or a
     cohort sealed with an undecidable result. It has no timestamps,
     so it is trusted only because it names the status fields itself.
     Narrow it and this test says so. */
  const src = readFileSync(new URL('../routes/invigilation.routes.js', import.meta.url), 'utf8');
  const m = src.match(/\.populate\(\s*'examId',([\s\S]*?)\)\s*\n/);
  assert.ok(m, 'the rooms query no longer populates examId the way this test expects');
  const fields = m[1];
  for (const need of ['status', 'date', 'startTime', 'durationMinutes', 'timezone', 'startsAt',
    'blueprint', 'passMark', 'writingUntil', 'lastSittingEndsAt', 'closedAt']) {
    assert.ok(new RegExp(`\\b${need}\\b`).test(fields),
      `the invigilator's rooms query no longer loads '${need}' — the status derived from it`
      + ' would be wrong, and it is written back');
  }
});
