// Weekly health check: is each tool's link alive, and is its GitHub repo still maintained?
// Writes data/health.json (machine-owned, never edit it by hand) and prints a Markdown report,
// which also goes to the GitHub Actions job summary when run in CI.
//
//   node scripts/healthcheck.mjs            check every tool
//   node scripts/healthcheck.mjs sherlock   check only the given slugs (results are still saved)
import { readFileSync, readdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const toolsDir = join(root, 'data/tools');
const healthPath = join(root, 'data/health.json');

const DOWN_AFTER = 2; // consecutive failed checks before a tool is shown as down
const STALE_DAYS = 730; // no push to the repo for this long counts as stale
const TIMEOUT_MS = 20_000;
const CONCURRENCY = 8;
const UA = 'Mozilla/5.0 (compatible; osint-hub-healthcheck/1.0; +https://github.com/cumarlover-debug/osint-hub)';

const today = new Date().toISOString().slice(0, 10);
const only = process.argv.slice(2);

const tools = readdirSync(toolsDir)
  .filter((f) => f.endsWith('.yaml'))
  .map((f) => ({ slug: f.replace(/\.yaml$/, ''), ...yaml.load(readFileSync(join(toolsDir, f), 'utf8')) }))
  .filter((t) => !only.length || only.includes(t.slug));

const previous = existsSync(healthPath) ? JSON.parse(readFileSync(healthPath, 'utf8')) : {};

/**
 * ok      the page answered (2xx/3xx, or 401 which still proves it exists)
 * fail    it is gone or broken (404/410, most 5xx, DNS failure, refused, timeout)
 * blocked we could not tell, usually bot protection (403/429, Cloudflare challenge)
 */
async function checkUrl(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    res.body?.cancel().catch(() => {});
    const code = res.status;
    const finalHost = new URL(res.url).host.replace(/^www\./, '');
    const movedTo = finalHost !== new URL(url).host.replace(/^www\./, '') ? res.url : undefined;
    const challenged = res.headers.has('cf-mitigated') || /cloudflare|ddos-guard/i.test(res.headers.get('server') ?? '');

    if (code < 400 || code === 401) return { result: 'ok', code, movedTo };
    if (code === 404 || code === 410) return { result: 'fail', code, reason: `HTTP ${code}` };
    if (code >= 500 && !challenged) return { result: 'fail', code, reason: `HTTP ${code}` };
    return { result: 'blocked', code, reason: `HTTP ${code}${challenged ? ' (bot protection)' : ''}` };
  } catch (e) {
    const reason = e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code ?? e.message);
    return { result: 'fail', reason };
  }
}

async function checkRepo(repo) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': UA };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404) return { missing: true };
    if (!res.ok) return { error: `GitHub API HTTP ${res.status}` };
    const j = await res.json();
    return {
      stars: j.stargazers_count,
      archived: j.archived,
      pushed_at: j.pushed_at?.slice(0, 10),
      ...(j.full_name.toLowerCase() !== repo.toLowerCase() && { renamed_to: j.full_name }),
    };
  } catch (e) {
    return { error: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}

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
    entry.repo = repo.error ? prev.repo : repo;
    if (repo.error) entry.repo_error = repo.error;
  }
  return [tool, entry, prev];
}

async function pool(items, size, fn) {
  const out = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
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
