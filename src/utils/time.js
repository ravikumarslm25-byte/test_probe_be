/* ============================================================
   Wall-clock time in the institution's own zone.

   An examination is written down as "27 September, 14:00". That is a
   wall-clock reading in the institution's city, not an instant in
   time — and `new Date('2026-09-27T14:00:00')` resolves it against
   whatever zone the SERVER happens to run in. On a laptop in Chennai
   that looked right; on EC2 in Virginia the same paper moved five and
   a half hours, so candidates were told "starts soon" for an
   afternoon while the invigilator's wall stayed empty.

   Everything here converts a written date and time, plus a named
   zone, into the single correct instant.
   ============================================================ */

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/* How far the named zone is from UTC at a given instant, in
   milliseconds. Read out of Intl rather than hard-coded, so zones
   with daylight saving stay correct through their changeovers. */
function zoneOffsetMs(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);

  const f = {};
  for (const p of parts) if (p.type !== 'literal') f[p.type] = Number(p.value);
  // Intl can report hour 24 for midnight in some engines.
  const asUtc = Date.UTC(f.year, f.month - 1, f.day % 32, f.hour % 24, f.minute, f.second);
  return asUtc - instant.getTime();
}

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/* "2026-09-27" + "14:00" in Asia/Kolkata  →  2026-09-27T08:30:00Z */
export function zonedToUtc(date, time, timeZone = DEFAULT_TIMEZONE) {
  if (!date || !time) return null;
  const tz = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE;

  // Read the written time as if it were UTC, then correct by the
  // zone's offset. A second pass settles the rare case where the
  // first guess lands on the far side of a daylight-saving change.
  const guess = new Date(`${date}T${time}:00Z`);
  if (Number.isNaN(guess.getTime())) return null;

  const first = new Date(guess.getTime() - zoneOffsetMs(guess, tz));
  const second = new Date(guess.getTime() - zoneOffsetMs(first, tz));
  return second;
}

/* The written date and time an instant falls on, in the zone. Used
   when creating something "for today" from the institution's point
   of view rather than the server's. */
export function utcToZoned(instant, timeZone = DEFAULT_TIMEZONE) {
  const tz = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(instant);

  const f = {};
  for (const p of parts) if (p.type !== 'literal') f[p.type] = p.value;
  const hour = String(Number(f.hour) % 24).padStart(2, '0');
  return { date: `${f.year}-${f.month}-${f.day}`, time: `${hour}:${f.minute}` };
}

/* Today's date as the institution would write it. */
export function todayInZone(timeZone = DEFAULT_TIMEZONE, offsetDays = 0) {
  const base = new Date(Date.now() + offsetDays * 86400000);
  return utcToZoned(base, timeZone).date;
}

/* An examination's true start instant. Prefers the value stored on
   the document, so a paper keeps the instant it was scheduled for
   even if the institution's zone is changed afterwards. */
export function examStartAt(exam) {
  if (!exam) return null;
  if (exam.startsAt) return new Date(exam.startsAt);
  return zonedToUtc(exam.date, exam.startTime, exam.timezone);
}

export function examEndAt(exam) {
  const start = examStartAt(exam);
  if (!start) return null;
  return new Date(start.getTime() + (exam.durationMinutes || 0) * 60000);
}

/* For messages a candidate reads: "14:00" as their institution
   writes it, never as the server's clock sees it. */
export function formatInZone(instant, timeZone = DEFAULT_TIMEZONE, opts = {}) {
  const tz = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', ...opts,
  }).format(instant);
}
