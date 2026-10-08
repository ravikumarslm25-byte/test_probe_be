#!/usr/bin/env node
/* ============================================================
   Routes that can never be reached.

   Express matches in declaration order, so `r.patch('/:id')`
   declared above `r.patch('/many')` swallows `/many` — the handler
   runs with `id = "many"`, and what comes back is "Invalid _id" or a
   404, neither of which points at the real cause. Nothing fails at
   start-up and nothing fails at build; the route simply never runs.

   This reads every route file and reports any literal path declared
   after a parameter pattern of the same method that would match it.
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';

const DIRS = ['src/routes', 'src/utils', 'src/services', 'src/realtime'];
const problems = [];

/* r.get('/path', ... — the leading `r.` is this project's convention. */
const ROUTE = /^\s*r\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/gm;

for (const file of fs.readdirSync('src/routes').filter((f) => f.endsWith('.js'))) {
  const rel = `src/routes/${file}`;
  const src = fs.readFileSync(rel, 'utf8');
  const routes = [];
  for (const m of src.matchAll(ROUTE)) {
    routes.push({
      method: m[1],
      route: m[2],
      line: src.slice(0, m.index).split('\n').length,
      parts: m[2].split('/').filter(Boolean),
    });
  }

  for (let i = 0; i < routes.length; i += 1) {
    const later = routes[i];
    /* Only a path with no parameters of its own can be shadowed. */
    if (later.parts.some((p) => p.startsWith(':'))) continue;

    for (let j = 0; j < i; j += 1) {
      const earlier = routes[j];
      if (earlier.method !== later.method) continue;
      if (earlier.parts.length !== later.parts.length) continue;

      /* Earlier wins if every one of its segments is either the same
         literal or a parameter that will happily swallow the later
         one's literal. */
      const shadows = earlier.parts.every((p, k) => p.startsWith(':') || p === later.parts[k]);
      const hasParam = earlier.parts.some((p) => p.startsWith(':'));

      if (shadows && hasParam) {
        problems.push(
          `${rel}:${later.line}  ${later.method.toUpperCase()} ${later.route}`
          + ` can never run — ${earlier.method.toUpperCase()} ${earlier.route}`
          + ` on line ${earlier.line} matches it first.`
          + ` Move the literal path above the parameter one.`,
        );
        break;
      }
    }
  }
}

/* ============================================================
   `tenant(req)` inside an aggregation pipeline.

   An aggregation is handed to the driver as written, with no casting
   against the schema. `tenant(req)` carries the institution id as a
   STRING, which never equals the stored ObjectId — so the stage
   matches nothing, returns an empty result, and reads as "no data"
   rather than "broken". The question bank reported every subject at
   zero approved while the list underneath showed fifty-nine.

   `tenantAgg(req)` is the cast form. This flags the other one.
   ============================================================ */
for (const dir of DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const rel = path.join(dir, file);
    const src = fs.readFileSync(rel, 'utf8');

    /* Each aggregate( ... ) call, matched to its closing bracket by
       depth so a nested pipeline is not cut short. */
    for (const m of src.matchAll(/\.aggregate\(/g)) {
      let i = m.index + m[0].length;
      let depth = 1;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === '(' || c === '[') depth += 1;
        else if (c === ')' || c === ']') depth -= 1;
        i += 1;
      }
      const pipeline = src.slice(m.index, i);
      const line = src.slice(0, m.index).split('\n').length;

      /* Directly, as `{ ...tenant(req) }` inside the pipeline... */
      let culprit = /\btenant\(req\)/.test(pipeline) ? 'tenant(req)' : null;

      /* ...or through a variable. Resolved transitively, because the
         real code assigns `const match = { ...tenant(req) }` above
         the call — and a variable can be built from another variable
         that was built from it. Brace-matching rather than `[^}]*`,
         which could not cross a nested object and walked straight
         past `{ status: { $in: [...] }, ...tenant(req) }`. */
      if (!culprit) {
        const before = src.slice(0, m.index);
        const tainted = new Map();

        for (const d of before.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*\{/g)) {
          let k = d.index + d[0].length;
          let depth2 = 1;
          while (k < before.length && depth2 > 0) {
            if (before[k] === '{') depth2 += 1;
            else if (before[k] === '}') depth2 -= 1;
            k += 1;
          }
          const literal = before.slice(d.index, k);
          if (/\btenant\(req\)/.test(literal)) { tainted.set(d[1], 'tenant(req)'); continue; }
          for (const [name, via] of tainted) {
            if (new RegExp(`\\.\\.\\.\\s*${name}\\b`).test(literal)) {
              tainted.set(d[1], `${name} <- ${via}`);
              break;
            }
          }
        }

        for (const [name, via] of tainted) {
          /* `\b` alone matched `match` inside `$match`, because `$`
             is not a word character — every file with a `const match`
             failed on every unrelated pipeline. A name used as a
             value is preceded by whitespace, a colon, a bracket or a
             spread, never by `$`. */
          if (new RegExp(`(^|[^$\\w.])${name}\\b`).test(pipeline)) {
            culprit = `${name} (built from ${via})`;
            break;
          }
        }
      }

      if (culprit) {
        problems.push(
          `${rel}:${line}  aggregate() matches on ${culprit} — a pipeline is not cast,`
          + ` so the string id matches NOTHING and the result is silently empty, not an error.`
          + ` Use tenantAgg(req).`,
        );
      }
    }
  }
}

/* ============================================================
   Names imported and never used.

   Harmless on its own, but it is the fingerprint of a half-finished
   move: `gradeMcq` and three others stayed at the top of
   attempt.routes.js after the grading was extracted into a service,
   so the file still read as if it graded papers itself. There is no
   linter on the server to say so, and the next person to read that
   import list learns something untrue about the file.

   Deliberately conservative — a name mentioned anywhere outside the
   import, including in a comment, is left alone.
   ============================================================ */
const IMPORT = /^\s*import\s+([^;]*?)\s+from\s+['"][^'"]+['"]\s*;?/gm;

/* Comments blanked out, newlines and length kept so line numbers and
   offsets still line up.

   Needed because this codebase quotes code in its comments constantly
   — the header above quotes `gradeMcq` from the very file it is about.
   A commented-out import statement matched `IMPORT` and was reported
   as an unused import, on a line that is a comment, and `npm test`
   runs this before the tests, so it would have blocked the suite over
   nothing. Stripping them also fixes a `;` or a `//` inside an import
   clause, which otherwise cut the clause short and quietly skipped
   the names after it. */
function blankComments(src) {
  let out = '';
  let i = 0;
  let mode = null;     // 'line' | 'block' | "'" | '"' | '`'
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (mode === 'line') {
      if (c === '\n') { mode = null; out += c; } else out += ' ';
      i += 1; continue;
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') { mode = null; out += '  '; i += 2; continue; }
      out += c === '\n' ? c : ' ';
      i += 1; continue;
    }
    if (mode) {                                   // inside a string
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === mode) mode = null;
      /* An unterminated '...' or "..." cannot cross a line in real
         JavaScript, so a newline closes it rather than swallowing the
         rest of the file. */
      if (c === '\n' && mode !== '`') mode = null;
      i += 1; continue;
    }

    if (c === '/' && next === '/') { mode = 'line'; out += '  '; i += 2; continue; }
    if (c === '/' && next === '*') { mode = 'block'; out += '  '; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') { mode = c; out += c; i += 1; continue; }
    out += c;
    i += 1;
  }
  return out;
}

for (const dir of DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const rel = path.join(dir, file);
    const src = blankComments(fs.readFileSync(rel, 'utf8'));

    /* The file with its import statements taken out, so an import
       does not count as a use of itself.

       The spread is flattened first. A property access (`obj.tenant`)
       is not a use of an imported `tenant`, so a preceding dot
       disqualifies a match — but `...tenant(req)`, which is how every
       one of these is actually used, also has a dot in front of it.
       Without this the check reported `tenant` unused in nine files
       that call it on every route. */
    const body = src.replace(IMPORT, '\n').replace(/\.\.\./g, ' ');

    for (const m of src.matchAll(IMPORT)) {
      const clause = m[1];
      const line = src.slice(0, m.index).split('\n').length;
      const locals = [];

      /* `Default, { a, b as c }` — the braces hold the named part. */
      const named = clause.match(/\{([\s\S]*)\}/);
      if (named) {
        for (const piece of named[1].split(',')) {
          const name = piece.trim().split(/\s+as\s+/).pop().trim();
          if (name) locals.push(name);
        }
      }
      const head = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, ' ').trim();
      /* `* as ns` is left out: a namespace is nearly always used
         through a property, which this would not see. */
      if (head && !head.startsWith('*')) locals.push(head);

      for (const name of locals) {
        if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
        if (new RegExp(`(^|[^\\w$.])${name}\\b`).test(body)) continue;
        problems.push(
          `${rel}:${line}  '${name}' is imported and never used.`
          + ` Remove it — the import list is the first thing read about this file.`,
        );
      }
    }
  }
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s) in the routes:\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('');
  process.exit(1);
}
console.log('check-routes: every route is reachable, every aggregate casts its tenant id.');
