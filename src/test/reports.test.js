/* ============================================================
   Every report in the catalogue must be buildable.

   The catalogue and the builders are two separate lists, and the
   screen reads the catalogue. A report named there with no builder
   behind it is offered to the examination cell, runs, and 404s —
   which looks like the server is broken rather than like a typo.

   The keys also diverge in form: a catalogue key may be hyphenated,
   a builder name cannot be. That mapping is exactly the sort of thing
   that rots.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync('src/routes/report.routes.js', 'utf8');

/* Read both lists out of the source rather than importing the router,
   which would pull in the database layer. */
const catalogueKeys = [...SRC.matchAll(/^\s*\{\s*key:\s*'([^']+)'/gm)].map((m) => m[1]);

const buildersBlock = SRC.slice(SRC.indexOf('const builders = {'), SRC.indexOf('const BUILDER_KEY'));
const builderNames = [...buildersBlock.matchAll(/^\s{2}async\s+([A-Za-z0-9_$]+)\s*\(req, f\)/gm)]
  .map((m) => m[1]);

const mapBlock = SRC.slice(SRC.indexOf('const BUILDER_KEY = {'));
const mapped = Object.fromEntries(
  [...mapBlock.slice(0, mapBlock.indexOf('};')).matchAll(/'([^']+)':\s*'([^']+)'/g)]
    .map((m) => [m[1], m[2]]),
);

test('the catalogue is not empty and was parsed', () => {
  assert.ok(catalogueKeys.length >= 10, `found ${catalogueKeys.length} report(s)`);
  assert.ok(builderNames.length >= 10, `found ${builderNames.length} builder(s)`);
});

test('every report in the catalogue has a builder behind it', () => {
  const missing = catalogueKeys.filter((k) => !builderNames.includes(mapped[k] || k));
  assert.deepEqual(missing, [],
    `these are offered on screen but would 404: ${missing.join(', ')}`);
});

test('every builder is reachable from the catalogue', () => {
  const resolved = new Set(catalogueKeys.map((k) => mapped[k] || k));
  const orphans = builderNames.filter((b) => !resolved.has(b));
  assert.deepEqual(orphans, [],
    `these builders can never be run: ${orphans.join(', ')}`);
});

test('the detailed attendance register is in the catalogue', () => {
  assert.ok(catalogueKeys.includes('attendance-detail'));
  assert.equal(mapped['attendance-detail'], 'attendanceDetail');
  assert.ok(builderNames.includes('attendanceDetail'));
});

test('every filter a report declares is one the screen can render', () => {
  /* A report asking for a filter the page has no control for simply
     cannot be narrowed — the filter is silently absent. */
  const page = fs.readFileSync('../web/src/pages/admin/Reports.jsx', 'utf8');
  const rendered = new Set(
    [...page.matchAll(/filters\.includes\('([^']+)'\)/g)].map((m) => m[1]),
  );
  const declared = new Set(
    [...SRC.matchAll(/filters:\s*\[([^\]]+)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])),
  );
  const unrenderable = [...declared].filter((f) => !rendered.has(f));
  assert.deepEqual(unrenderable, [],
    `declared but with no control on the page: ${unrenderable.join(', ')}`);
});

test('every filter the screen sends is one the schema accepts', () => {
  /* zod strips an unknown key silently, so a filter the page sends
     under the wrong name narrows nothing and says nothing. */
  const schema = SRC.slice(SRC.indexOf('const filterSchema = z.object({'));
  const accepted = new Set(
    [...schema.slice(0, schema.indexOf('});')).matchAll(/^\s*([A-Za-z0-9_$]+):/gm)].map((m) => m[1]),
  );
  const page = fs.readFileSync('../web/src/pages/admin/Reports.jsx', 'utf8');
  const sent = [...page.matchAll(/set\('([A-Za-z0-9_$]+)'\)/g)].map((m) => m[1]);
  const unknown = [...new Set(sent)].filter((k) => !accepted.has(k));
  assert.deepEqual(unknown, [],
    `the page sends these but the server drops them: ${unknown.join(', ')}`);
});
