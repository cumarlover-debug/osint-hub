// Re-tests the search links the directory already publishes. A query_template is verified when it is added, and
// then nothing watches it: sites rename their parameters, drop GET search for a POST form, or start answering bot
// checks, and the link rots silently while still looking fine in the data.
//
//   node scripts/template-check.mjs                 test every published template
//   node scripts/template-check.mjs --only a,b      test a few
//   node scripts/template-check.mjs --limit 50      the first fifty, useful while iterating
//   node scripts/template-check.mjs --strict        exit non-zero when a link is dead (for a gate, not a report)
//
// Writes data/templates.json: per tool, whether the link still echoes the value it is given. The weekly workflow
// commits that file the same way the health check commits data/health.json, so a broken link shows up as a diff
// rather than as a user's wasted click.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, root, readYamlDir } from './lib/data.mjs';
import { pool } from './lib/net.mjs';
import { TEST_VALUES, SECOND_VALUES, templateFor, fetchSearch } from './lib/templates.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : (argv[i + 1] ?? true);
};
const only = String(flag('only') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const limit = Number(flag('limit') ?? 0);
const strict = argv.includes('--strict');
const target = join(root, 'data/templates.json');

const tools = readYamlDir(paths.tools).map(({ slug, tool }) => ({ slug, ...tool }));
// One job per tool-and-input pair: a tool may carry a different template for each input it takes. The template must
// come back as a string, which rules out the per-input entries that carry a matcher alongside the URL.
const jobs = [];
for (const tool of tools) {
  if (!tool.query_template) continue;
  if (only.length && !only.includes(tool.slug)) continue;
  for (const input of tool.inputs) {
    const template = templateFor(tool.query_template, input);
    if (typeof template !== 'string') continue;
    if (!TEST_VALUES[input] || !SECOND_VALUES[input]) continue; // no harmless value to type: nothing to prove
    jobs.push({ tool, input, template });
  }
}
const chosen = limit ? jobs.slice(0, limit) : jobs;

console.log(`Testing ${chosen.length} search link${chosen.length === 1 ? '' : 's'} (of ${jobs.length} that can be tested)…\n`);

const results = {};
await pool(chosen, 8, async ({ tool, input, template }) => {
  const first = await fetchSearch(template, TEST_VALUES[input]);
  const second = first.ok && first.echoed ? await fetchSearch(template, SECOND_VALUES[input]) : { ok: false, skipped: true };

  let status;
  let note;
  if (!first.ok) {
    // A 403 or a 429 is usually the site refusing this client rather than the link being gone, and the two deserve
    // different words: one is worth retrying, the other needs the template fixing.
    if (first.http === 403 || first.http === 429) {
      status = 'blocked';
      note = `HTTP ${first.http} — refused this client rather than the link being wrong`;
    } else {
      status = 'dead';
      note = first.http ? `HTTP ${first.http}` : 'no response';
    }
  } else if (!first.echoed) {
    // A page that answers but never mentions the value has stopped being a search URL. Some do this behind a bot
    // check, so the challenge is recorded rather than called a failure.
    status = first.challenged ? 'blocked' : 'changed';
    note = first.challenged ? 'bot check instead of results' : 'page answered but never echoed the value';
  } else if (second.ok && second.echoed === false) {
    status = 'changed';
    note = 'echoed the first value but not the second, so it may be a cached or generic page';
  } else {
    status = 'ok';
  }

  results[tool.slug] = { status, input, http: first.http ?? null, checked: new Date().toISOString().slice(0, 10), ...(note && { note }) };
  const mark = status === 'ok' ? 'ok      ' : status === 'dead' ? 'dead    ' : `${status} `.padEnd(8);
  console.log(`  ${mark}${tool.slug.padEnd(30)} ${input.padEnd(12)} ${note ?? 'echoes both values'}`);
  return null;
});

const counts = { ok: 0, changed: 0, dead: 0, blocked: 0 };
for (const r of Object.values(results)) counts[r.status] = (counts[r.status] ?? 0) + 1;

// Consecutive breaks are counted, the way the health check counts them: a site can be down for an afternoon
// without the link being wrong, so a single bad run is recorded but does not fail anything.
const previous = existsSync(target) ? (JSON.parse(readFileSync(target, 'utf8')).results ?? {}) : {};
for (const [slug, r] of Object.entries(results)) {
  const before = previous[slug] ?? {};
  r.failures = r.status === 'dead' || r.status === 'changed' ? (before.failures ?? 0) + 1 : 0;
}

const body = {
  generated: new Date().toISOString(),
  tested: Object.keys(results).length,
  ...counts,
  failing: Object.values(results).filter((r) => r.failures >= 2).length,
  results: Object.fromEntries(Object.entries(results).sort(([a], [b]) => a.localeCompare(b))),
};
writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`);

console.log(`\n${counts.ok} ok · ${counts.changed} changed · ${counts.dead} dead · ${counts.blocked} blocked`);
console.log(`${body.failing} have failed twice in a row`);
console.log('wrote data/templates.json');
// Only a link that has failed twice fails the run, so a site having a bad afternoon does not turn the job red.
if (strict && body.failing) {
  console.error(`\n${body.failing} search link${body.failing === 1 ? ' has' : 's have'} failed two runs in a row.`);
  process.exitCode = 1;
}
