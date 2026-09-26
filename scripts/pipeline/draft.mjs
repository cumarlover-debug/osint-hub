// Step 2: turn the best candidates into draft tool files in data/drafts/ for review.
//
//   npm run pipeline:draft -- --limit 50                 best 50, spread evenly across categories
//   npm run pipeline:draft -- --limit 20 --category email
//   npm run pipeline:draft -- --people                   also draft people-search and face-search candidates
//   npm run pipeline:draft -- --leaked                   also draft possible leaked-data services (for rejecting)
//
// Each candidate's link is checked first and its GitHub repo read; dead, missing, archived and long-abandoned
// tools are skipped (and listed at the end). Drafts leave `description` empty: it has to be written fresh,
// because the source lists' descriptions are not ours to publish. See data/drafts/README.md.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { paths, readYamlDir, readRejected, urlKey, nameKey, slugify, taxonomy } from '../lib/data.mjs';
import { checkUrl, checkRepo, githubRepo, pool } from '../lib/net.mjs';

const ABANDONED_DAYS = 3 * 365;
const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const limit = Number(arg('--limit') ?? 50);
const onlyCategory = arg('--category');
const includePeople = args.includes('--people');
const includeLeaked = args.includes('--leaked');

if (onlyCategory && !(onlyCategory in taxonomy.categories)) {
  console.error(`Unknown category "${onlyCategory}". Use one of: ${Object.keys(taxonomy.categories).join(', ')}`);
  process.exit(1);
}
const candidatesPath = join(paths.cache, 'candidates.json');
if (!existsSync(candidatesPath)) {
  console.error('No candidates yet. Run: npm run pipeline:harvest');
  process.exit(1);
}

// Re-check against the current files: tools may have been promoted or rejected since the harvest.
const taken = new Set();
const slugs = new Set();
for (const dir of [paths.tools, paths.drafts]) {
  for (const { slug, tool } of readYamlDir(dir)) {
    slugs.add(slug);
    if (tool?.url) taken.add(urlKey(tool.url)).add(`name:${nameKey(tool.name)}`);
  }
}
const rejected = readRejected();

// Candidates that failed a check are left alone for a while instead of being re-checked on every run.
const RECHECK_DAYS = 30;
const skippedPath = join(paths.cache, 'skipped.json');
const recentlySkipped = existsSync(skippedPath) ? JSON.parse(readFileSync(skippedPath, 'utf8')) : {};
const skippedRecently = (key) =>
  recentlySkipped[key] && (Date.now() - Date.parse(recentlySkipped[key].date)) / 86_400_000 < RECHECK_DAYS;

const pool_ = JSON.parse(readFileSync(candidatesPath, 'utf8')).filter(
  (c) =>
    !taken.has(c.key) &&
    !taken.has(`name:${nameKey(c.name)}`) &&
    !rejected.has(c.key) &&
    !skippedRecently(c.key) &&
    (!onlyCategory || c.category === onlyCategory) &&
    (includePeople || !c.flags.some((f) => f.startsWith('policy-people'))) &&
    (includeLeaked || !c.flags.some((f) => f.startsWith('policy-leak'))),
);

// Round-robin over categories (each already sorted by score) so one big category can't fill the batch.
const byCategory = new Map();
for (const c of pool_) byCategory.set(c.category, [...(byCategory.get(c.category) ?? []), c]);
const queue = [];
while (queue.length < pool_.length) {
  for (const list of byCategory.values()) if (list.length) queue.push(list.shift());
}

function uniqueSlug(name) {
  const base = slugify(name);
  let slug = base;
  for (let n = 2; slugs.has(slug); n++) slug = `${base}-${n}`;
  slugs.add(slug);
  return slug;
}

const daysSince = (date) => (Date.now() - Date.parse(date)) / 86_400_000;

async function inspect(c) {
  const repo = githubRepo(c.url);
  if (repo) {
    const r = await checkRepo(repo);
    if (r.error) return { c, skip: `GitHub API: ${r.error}` };
    if (r.missing) return { c, skip: 'repo not found' };
    if (r.archived) return { c, skip: 'repo archived' };
    if (r.pushed_at && daysSince(r.pushed_at) > ABANDONED_DAYS) return { c, skip: `abandoned, last push ${r.pushed_at}` };
    return { c, repo, gh: r, link: { result: 'ok' } };
  }
  const link = await checkUrl(c.url, { page: true });
  if (link.result === 'fail') return { c, skip: `link ${link.reason}` };
  return { c, link };
}

function toDraft({ c, repo, gh, link }) {
  const fw = c.facts ?? {};
  const flags = [...c.flags];

  const type = repo ? 'cli' : /chrome\.google\.com\/webstore|chromewebstore\.google\.com|addons\.mozilla\.org/.test(c.url) ? 'extension' : 'web';
  if (repo) flags.push('type: GitHub repo assumed to be a CLI tool, check it is not a library or web app');

  let cost = { free: 'free', freemium: 'freemium', paid: 'paid', 'free/freemium': 'freemium' }[fw.pricing];
  if (!cost) {
    cost = repo ? 'free' : 'freemium';
    if (!repo) flags.push('cost: unknown, guessed freemium');
  }

  // Our "passive" means it never touches the target's own infrastructure. The OSINT Framework's "active"
  // also covers querying third-party sites (e.g. username checkers), so only trust it for infrastructure tools.
  const infra = ['domain', 'network', 'threat-intel', 'frameworks'].includes(c.category);
  const passive = !(fw.opsec === 'active' && infra);
  if (fw.opsec === 'active' && !infra) flags.push('passive: source says active (queries third-party sites); kept passive per our definition');
  if (!c.facts) flags.push('account_required: unknown, guessed no');

  if (link.result === 'blocked') flags.push(`link: could not verify (${link.reason})`);
  if (link.movedTo) flags.push(`link: redirects to ${link.movedTo}, update url?`);

  const tool = {
    name: c.name,
    url: c.url,
    description: '',
    category: c.category,
    inputs: c.inputs,
    type,
    cost,
    passive,
    account_required: Boolean(fw.registration),
    ...(repo && { repo }),
    ...(gh?.language && { language: gh.language }),
    ...(gh?.license && { license: gh.license }),
  };

  const review = {
    approve: false,
    reject: false,
    reject_reason: '',
    confidence: c.confidence,
    score: c.score,
    // If review changes `url`, promote records this one as an alias so the tool isn't suggested again.
    source_url: c.url,
    flags,
    // Reference only, never published: the source lists' own wording.
    notes: JSON.parse(
      JSON.stringify({
        sources: c.sources.map((s) => ({ list: s.list, section: s.section, said: s.description })),
        framework_input: fw.input,
        framework_output: fw.output,
        page_title: link.title,
        page_description: link.meta_description,
        github_description: gh?.description,
        github_stars: gh?.stars,
        github_last_push: gh?.pushed_at,
      }),
    ),
  };

  const header =
    '# DRAFT: write a fresh one-sentence description, fix anything the flags mention, then set\n' +
    '# review.approve: true (or review.reject: true) and run `npm run pipeline:promote`.\n';
  return { flags, text: header + yaml.dump(tool, { flowLevel: 1, lineWidth: -1 }) + '\n' + yaml.dump({ review }, { lineWidth: 110 }) };
}

mkdirSync(paths.drafts, { recursive: true });
const written = [];
const skipped = [];
// Inspect in chunks until we have enough drafts; dead links mean we usually need a few more than `limit`.
for (let i = 0; written.length < limit && i < queue.length; ) {
  const chunk = queue.slice(i, i + Math.max(10, (limit - written.length) * 1.3));
  i += chunk.length;
  process.stdout.write(`Checking ${chunk.length} candidates… `);
  for (const r of await pool(chunk, 8, inspect)) {
    if (r.skip) skipped.push(r);
    else if (written.length < limit) {
      const slug = uniqueSlug(r.c.name);
      const { text, flags } = toDraft(r);
      writeFileSync(join(paths.drafts, `${slug}.yaml`), text);
      written.push({ slug, flags, ...r });
    }
  }
  console.log(`${written.length}/${limit} drafted`);
}

const today = new Date().toISOString().slice(0, 10);
for (const s of skipped) recentlySkipped[s.c.key] = { date: today, reason: s.skip };
writeFileSync(skippedPath, JSON.stringify(recentlySkipped, null, 2));

const perCategory = written.reduce((m, w) => ((m[w.c.category] = (m[w.c.category] ?? 0) + 1), m), {});
console.log(`\nWrote ${written.length} drafts to data/drafts/  ${JSON.stringify(perCategory)}`);
console.log(`With flags to check: ${written.filter((w) => w.flags.length).length}`);
if (skipped.length) {
  console.log(`\nSkipped ${skipped.length} (not drafted; re-checked after ${RECHECK_DAYS} days in case they recover):`);
  for (const s of skipped) console.log(`  - ${s.c.name} (${s.c.url}): ${s.skip}`);
}
console.log(`\n${pool_.length - written.length - skipped.length} candidates left in the queue.`);
