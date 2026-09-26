// Weekly health check: is each tool's link alive, and is its GitHub repo still maintained?
// Writes data/health.json (machine-owned, never edit it by hand) and prints a Markdown report,
// which also goes to the GitHub Actions job summary when run in CI.
//
//   node scripts/healthcheck.mjs            check every tool
//   node scripts/healthcheck.mjs sherlock   check only the given slugs (results are still saved)
import { readFileSync, readdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { paths, readYamlDir } from './lib/data.mjs';
import { checkUrl, checkRepo, pool } from './lib/net.mjs';

const toolsDir = paths.tools;
const healthPath = paths.health;

const DOWN_AFTER = 2; // consecutive failed checks before a tool is shown as down
const STALE_DAYS = 730; // no push to the repo for this long counts as stale
const CONCURRENCY = 8;

const today = new Date().toISOString().slice(0, 10);
const only = process.argv.slice(2);

const tools = readYamlDir(toolsDir)
  .map(({ slug, tool }) => ({ slug, ...tool }))
  .filter((t) => !only.length || only.includes(t.slug));

const previous = existsSync(healthPath) ? JSON.parse(readFileSync(healthPath, 'utf8')) : {};

async function check(tool) {
  const prev = previous[tool.slug] ?? {};
  const [link, repo] = await Promise.all([checkUrl(tool.url), tool.repo ? checkRepo(tool.repo) : undefined]);

  let failures = prev.failures ?? 0;
  let status;
  if (link.result === 'ok') {
    failures = 0;
    status = 'up';
  } else if (link.result === 'fail') {
    failures += 1;
    status = failures >= DOWN_AFTER ? 'down' : 'unverified';
  } else {
    // A block tells us nothing, so the failure streak neither grows nor resets.
    status = prev.status === 'down' ? 'down' : 'unverified';
  }

  const entry = {
    status,
    failures,
    last_checked: today,
    ...(link.code && { http: link.code }),
    ...(link.reason && { reason: link.reason }),
    ...(link.result === 'ok' ? { last_ok: today } : prev.last_ok && { last_ok: prev.last_ok }),
    ...(link.movedTo && { moved_to: link.movedTo }),
  };
  if (repo) {
    // On a rate limit or API error, keep last week's repo data rather than dropping it.
    // Only the maintenance facts go in health.json; description, language etc. are for the pipeline.
    const { stars, archived, pushed_at, missing, renamed_to } = repo;
    entry.repo = repo.error ? prev.repo : JSON.parse(JSON.stringify({ stars, archived, pushed_at, missing, renamed_to }));
    if (repo.error) entry.repo_error = repo.error;
  }
  return [tool, entry, prev];
}

const results = await pool(tools, CONCURRENCY, check);

// Keep entries for tools we did not re-check (when run with slugs); drop tools that were deleted.
const existing = new Set(readdirSync(toolsDir).map((f) => f.replace(/\.yaml$/, '')));
const health = Object.fromEntries(Object.entries(previous).filter(([slug]) => existing.has(slug)));
for (const [tool, entry] of results) health[tool.slug] = entry;
const sorted = Object.fromEntries(Object.keys(health).sort().map((k) => [k, health[k]]));
writeFileSync(healthPath, JSON.stringify(sorted, null, 2) + '\n');

// ---- Report ----
const daysSince = (date) => Math.floor((Date.now() - Date.parse(date)) / 86_400_000);
const line = (t, detail) => `- **${t.name}** (\`${t.slug}\`): ${detail}`;
const sections = [
  ['🔴 Down', results.filter(([, e]) => e.status === 'down').map(([t, e]) =>
    line(t, `${e.reason}, ${e.failures} checks in a row${e.last_ok ? `, last OK ${e.last_ok}` : ''}`))],
  ['🟠 Failed once (down if it fails again next week)', results.filter(([, e]) => e.status === 'unverified' && e.failures > 0).map(([t, e]) =>
    line(t, e.reason))],
  ['🟡 Could not verify (bot protection)', results.filter(([, e]) => e.status === 'unverified' && e.failures === 0).map(([t, e]) =>
    line(t, e.reason))],
  ['↪️ Redirects to another domain (update the url?)', results.filter(([, e]) => e.moved_to).map(([t, e]) =>
    line(t, `${t.url} → ${e.moved_to}`))],
  ['📦 Archived repos', results.filter(([, e]) => e.repo?.archived).map(([t]) => line(t, t.repo))],
  ['❓ Repo missing or renamed', results.filter(([, e]) => e.repo?.missing || e.repo?.renamed_to).map(([t, e]) =>
    line(t, e.repo.missing ? `${t.repo} not found` : `${t.repo} → ${e.repo.renamed_to}`))],
  ['💤 Stale (no push in 2+ years)', results.filter(([, e]) => e.repo?.pushed_at && !e.repo.archived && daysSince(e.repo.pushed_at) > STALE_DAYS).map(([t, e]) =>
    line(t, `last push ${e.repo.pushed_at}`))],
  ['⚠️ GitHub API errors (kept last known data)', results.filter(([, e]) => e.repo_error).map(([t, e]) => line(t, e.repo_error))],
];

const up = results.filter(([, e]) => e.status === 'up').length;
const newlyDown = results.filter(([, e, p]) => e.status === 'down' && p.status !== 'down').length;
let report = `## osint-hub health check, ${today}\n\n`;
report += `Checked **${results.length}** tools: **${up}** up, ${results.length - up} need attention`;
report += newlyDown ? `, **${newlyDown} newly down**.\n\n` : '.\n\n';
for (const [title, items] of sections) {
  if (items.length) report += `### ${title} (${items.length})\n\n${items.join('\n')}\n\n`;
}

console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
