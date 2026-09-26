// Step 3: publish reviewed drafts.
//
//   npm run pipeline:promote                  handle every draft marked approve: true or reject: true
//   npm run pipeline:promote -- slug1 slug2   same, but only for these drafts
//
// approve: true  → validated, moved to data/tools/<slug>.yaml (review block dropped), then health-checked
// reject: true   → URL added to data/pipeline/rejected.txt so it is never suggested again; draft deleted
// Drafts that fail validation stay where they are and the problems are printed.
import { appendFileSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { paths, readYamlDir, toolErrors, urlKey, slugify, root } from '../lib/data.mjs';

const only = process.argv.slice(2);
const existing = new Map(readYamlDir(paths.tools).map(({ slug, tool }) => [urlKey(tool.url), slug]));
const today = new Date().toISOString().slice(0, 10);

const promoted = [];
const rejectedNow = [];
const problems = [];
let waiting = 0;

for (const { slug, file, tool: draft, error } of readYamlDir(paths.drafts)) {
  if (only.length && !only.includes(slug)) continue;
  const draftPath = join(paths.drafts, file);
  if (error) {
    problems.push(`${file}: invalid YAML: ${error}`);
    continue;
  }
  const { review = {}, ...tool } = draft;

  if (review.reject) {
    mkdirSync(dirname(paths.rejected), { recursive: true });
    const reason = review.reject_reason ? ` (${review.reject_reason})` : '';
    appendFileSync(paths.rejected, `${tool.url}  # ${tool.name}${reason}, ${today}\n`);
    rmSync(draftPath);
    rejectedNow.push(slug);
    continue;
  }
  if (!review.approve) {
    waiting++;
    continue;
  }

  // The slug becomes a permanent URL, so base it on the reviewed name ("GHunt"), not the source's ("Ghunt tool").
  const fromName = slugify(tool.name);
  const finalSlug = existsSync(join(paths.tools, `${fromName}.yaml`)) ? slug : fromName;

  const errs = toolErrors(tool);
  if (existsSync(join(paths.tools, `${finalSlug}.yaml`))) errs.push(`data/tools/${finalSlug}.yaml already exists; rename the tool`);
  if (existing.has(urlKey(tool.url))) errs.push(`same url as data/tools/${existing.get(urlKey(tool.url))}.yaml`);
  if (errs.length) {
    problems.push(...errs.map((e) => `${file}: ${e}`));
    continue;
  }

  writeFileSync(join(paths.tools, `${finalSlug}.yaml`), yaml.dump(tool, { flowLevel: 1, lineWidth: -1 }));
  rmSync(draftPath);
  existing.set(urlKey(tool.url), finalSlug);
  promoted.push(finalSlug);
}

console.log(`Promoted ${promoted.length}, rejected ${rejectedNow.length}, ${waiting} still waiting for review.`);
if (promoted.length) console.log(`  + ${promoted.join(', ')}`);
if (rejectedNow.length) console.log(`  − ${rejectedNow.join(', ')} (added to data/pipeline/rejected.txt)`);
if (problems.length) {
  console.log(`\nNot promoted, fix these first:\n  ${problems.join('\n  ')}`);
}

if (promoted.length) {
  // Give the new tools link status and GitHub stats straight away rather than waiting for Monday.
  console.log('\nHealth-checking the new tools…');
  spawnSync(process.execPath, [join(root, 'scripts/healthcheck.mjs'), ...promoted], { stdio: ['ignore', 'ignore', 'inherit'] });
  console.log('Done. Review the diff, then commit data/tools, data/health.json and data/pipeline.');
}
process.exitCode = problems.length ? 1 : 0;
