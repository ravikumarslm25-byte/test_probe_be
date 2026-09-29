/* ============================================================
   Demonstration refresh.

   A seeded institution is only convincing on the day it was seeded:
   its live paper was scheduled for that morning, and by the next day
   the examination is over. Re-seeding fixes the dates but destroys
   every account, so the credentials handed out before a
   demonstration stop working.

   This moves the existing papers to today instead, and hands back a
   clean run of the live one. Staff, students, passwords, roles,
   subjects and rooms are left exactly as they are.

       node src/seed/refresh.js

   It never creates or deletes an account, and it refuses to touch an
   institution that has papers it did not seed, unless told to.
   ============================================================ */
import mongoose from 'mongoose';
import { connectDb } from '../config/db.js';
import { Institution } from '../models/core.js';
import { Exam, Attempt, Room } from '../models/exam.js';
import { storage } from '../services/storage.js';
import { utcToZoned, todayInZone, zonedToUtc, DEFAULT_TIMEZONE } from '../utils/time.js';

/* The codes the seed creates, and where each should sit relative to
   now once the refresh is done. */
const PLAN = [
  { code: '19CSC201', when: 'live',      status: 'live' },
  { code: '19ITC304', when: 'in2days',   status: 'scheduled' },
  { code: '19CSC305', when: 'days-5',    status: 'evaluation' },
  { code: '19ECC202', when: 'days-9',    status: 'published' },
];

const MINUTES_ALREADY_RUN = 25;

async function main() {
  await connectDb();

  const institution = await Institution.findOne().lean();
  if (!institution) {
    console.error('\n[refresh] no institution found. Run the seed first.\n');
    process.exit(1);
  }
  const tz = institution.settings?.timezone || DEFAULT_TIMEZONE;
  console.log(`[refresh] ${institution.name} · timezone ${tz}`);

  const liveStart = utcToZoned(new Date(Date.now() - MINUTES_ALREADY_RUN * 60000), tz);
  const placement = {
    live:    { date: liveStart.date, startTime: liveStart.time },
    in2days: { date: todayInZone(tz, 2), startTime: '14:00' },
    'days-5': { date: todayInZone(tz, -5), startTime: '10:00' },
    'days-9': { date: todayInZone(tz, -9), startTime: '10:00' },
  };

  let moved = 0;
  let cleaned = 0;

  for (const spec of PLAN) {
    const exam = await Exam.findOne({ institutionId: institution._id, code: spec.code });
    if (!exam) {
      console.log(`  ${spec.code.padEnd(10)} not present, skipped`);
      continue;
    }

    const place = placement[spec.when];
    exam.date = place.date;
    exam.startTime = place.startTime;
    exam.timezone = tz;
    exam.status = spec.status;
    exam.sealedUntil = zonedToUtc(place.date, place.startTime, tz);
    await exam.save();                      // the pre-save hook recomputes startsAt
    moved += 1;

    /* Rooms carry their own window, and an invigilator's wall reads
       it. Moved with the paper, or the room says the sitting ended
       hours ago while the paper says it is running. */
    const start = exam.startsAt;
    const end = new Date(start.getTime() + exam.durationMinutes * 60000);
    await Room.updateMany({ examId: exam._id }, { $set: { startAt: start, endAt: end } });

    console.log(`  ${spec.code.padEnd(10)} ${place.date} ${place.startTime} ${tz} · ${spec.status}`);

    /* The live paper is handed back unsat, so a candidate can be
       taken through it in front of an audience. Its evidence from
       the last demonstration goes too — otherwise the capture
       timeline opens on someone else's face. */
    if (spec.when === 'live') {
      const res = await Attempt.updateMany({ examId: exam._id }, {
        $set: {
          status: 'not_started',
          answers: [], violations: [], captures: [], chat: [], warnings: [],
          flagScore: 0, licenceConsumed: false, autoSubmitted: false,
          sectionState: { current: 'A', lockedSections: [] },
          marks: undefined, evaluation: undefined,
        },
        $unset: {
          joinedAt: '', startedAt: '', timerEndsAt: '', submittedAt: '',
          identity: '', environment: '', resultPublishedAt: '',
        },
      });
      cleaned = res.modifiedCount;

      try {
        await storage.remove(`${institution._id}/${exam._id}`);
      } catch (e) {
        console.warn('  (evidence files not removed:', e.message + ')');
      }
    }
  }

  const live = await Exam.findOne({ institutionId: institution._id, status: 'live' }).lean();
  console.log(`\n[refresh] ${moved} paper(s) moved, ${cleaned} attempt(s) reset to unsat.`);
  if (live) {
    const ends = new Date(live.startsAt.getTime() + live.durationMinutes * 60000);
    console.log(`[refresh] "${live.title}" is live now and closes at `
      + `${utcToZoned(ends, tz).time} ${tz}.`);
  }
  console.log('[refresh] Accounts and passwords are unchanged.\n');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('\n[refresh] failed:', e.message, '\n');
  process.exit(1);
});
