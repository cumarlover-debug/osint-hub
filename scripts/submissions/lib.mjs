// Turns a "Suggest a tool" issue into a tool entry and checks it. Used by check.mjs and approve.mjs.
// Everything read from the issue is untrusted: it is only ever parsed as data, never run or put in a shell.
import { readFileSync, existsSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { paths, readYamlDir, toolErrors, urlKey, nameKey, slugify, taxonomy } from '../lib/data.mjs';
import { checkUrl, checkRepo, githubRepo, UA, TIMEOUT_MS } from '../lib/net.mjs';
import { leakPattern, peoplePattern } from '../pipeline/mapping.mjs';

/** Issue-form label → field. Must match .github/ISSUE_TEMPLATE/submit-tool.yml. */
const LABELS = {
  'Tool name': 'name',
  URL: 'url',
  Description: 'description',
  Inputs: 'inputs',
  Category: 'category',
  Type: 'type',
  Cost: 'cost',
  Passive: 'passive',
  'Account required': 'account',
  'GitHub repo': 'repo',
  'Install command': 'install',
  'Notes for users': 'notes',
  'Why it belongs here': 'why',
};

/** Issue forms render as "### Label\n\nvalue" blocks; empty optional fields read "_No response_". */
export function parseIssueForm(body = '') {
  const fields = {};
  for (const block of body.replace(/\r\n/g, '\n').split(/^### /m).slice(1)) {
    const newline = block.indexOf('\n');
    const label = block.slice(0, newline).trim();
    const value = block.slice(newline + 1).trim();
    if (LABELS[label] && value && value !== '_No response_') fields[LABELS[label]] = value;
  }
  return fields;
}

const yesNo = (v) => (/^(y|yes|true)$/i.test(v ?? '') ? true : /^(n|no|false)$/i.test(v ?? '') ? false : undefined);
const oneLine = (v) => v?.replace(/\s+/g, ' ').trim();

/** Builds the tool entry exactly as it would be committed, plus the slug it would get. */
export function toTool(f) {
  const repo = oneLine(f.repo)?.replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '') || githubRepo(oneLine(f.url) ?? '');
  const tool = {
    name: oneLine(f.name),
    url: oneLine(f.url),
    description: oneLine(f.description),
    category: oneLine(f.category)?.toLowerCase(),
    inputs: (f.inputs ?? '').split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean),
    type: oneLine(f.type)?.toLowerCase(),
    cost: oneLine(f.cost)?.toLowerCase(),
    passive: yesNo(f.passive),
    account_required: yesNo(f.account),
    ...(repo && { repo }),
    ...(f.install && { install: oneLine(f.install) }),
    ...(f.notes && { notes: oneLine(f.notes) }),
  };
  for (const k of Object.keys(tool)) if (tool[k] === undefined || tool[k] === '') delete tool[k];
  return { tool, slug: slugify(tool.name ?? 'tool') };
}

// ---- Safe fetching: never let a submitted URL make the runner fetch a private or internal address. ----

const privateV4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^22[4-9]\.|^2[3-5]\d\./];
const isPrivate = (ip) =>
  isIP(ip) === 4 ? privateV4.some((r) => r.test(ip)) : /^(::1?$|f[cd]|fe[89ab]|::ffff:(10|127|169\.254|192\.168)\.)/i.test(ip);

export async function assertPublicUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('is not a valid URL');
  }
  if (u.protocol !== 'https:') throw new Error('must start with https://');
  if (u.username || u.password) throw new Error('must not contain a username or password');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error(`host ${host} does not resolve`);
  if (addrs.some((a) => isPrivate(a.address))) throw new Error('points to a private or internal address');
}

/** Follows redirects one hop at a time, checking every hop is public, then classifies the final page. */
export async function safeCheckUrl(url) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': UA } }).catch((e) => ({ error: e }));
    if (res.error) break; // let checkUrl report the failure consistently
    res.body?.cancel().catch(() => {});
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).href;
      continue;
    }
    break;
  }
  const result = await checkUrl(current, { page: true });
  if (current !== url && new URL(current).host.replace(/^www\./, '') !== new URL(url).host.replace(/^www\./, '')) result.movedTo = current;
  return result;
}

// ---- Checks ----

function readListWithReasons(file) {
  if (!existsSync(file)) return new Map();
  return new Map(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('#'))
      .map((l) => [urlKey(l.split(/\s+#/)[0].trim()), (l.split('#')[1] ?? '').trim()]),
  );
}

/** Quotes untrusted text as inline code so it cannot add links, mentions or formatting to the comment. */
const code = (s) => '`' + String(s).replace(/[`\r\n]/g, "'").slice(0, 200) + '`';

const norm = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Runs every check. Returns { tool, slug, results: [{ level: 'ok'|'warn'|'error', text }], ok }.
 * `ok` is false when anything is an error; warnings are for the reviewer.
 */
export async function checkSubmission(fields) {
  const { tool, slug } = toTool(fields);
  const results = [];
  const add = (level, text) => results.push({ level, text });

  // Details and format, in words a submitter can act on
  const allowed = { category: taxonomy.categories, type: taxonomy.types, cost: taxonomy.costs };
  const friendly = new Set();
  for (const p of toolErrors(tool)) {
    const field = p.match(/^\/(\w+)/)?.[1] ?? p.match(/required property '(\w+)'/)?.[1];
    if (field === 'passive') friendly.add('**Passive** must be yes or no.');
    else if (field === 'account_required') friendly.add('**Account required** must be yes or no.');
    else if (field in allowed) friendly.add(`**${field[0].toUpperCase() + field.slice(1)}** must be one of: ${Object.keys(allowed[field]).join(', ')}.`);
    else if (field === 'inputs') continue; // reported below with the unknown values
    else if (field === 'url') continue; // reported by the link check
    else if (field === 'description') friendly.add('**Description** must be 20–240 characters.');
    else friendly.add(`Details: ${p.replace(/^\//, '').replace(/^\(root\) /, '')}`);
  }
  if (tool.name && !/^[\p{L}\p{N} .,'&()+:!\/-]+$/u.test(tool.name)) friendly.add('**Tool name** contains unusual characters.');
  for (const f of friendly) add('error', f);
  const unknownInputs = tool.inputs.filter((i) => !(i in taxonomy.inputs));
  if (!tool.inputs.length) add('error', '**Inputs** is empty.');
  if (unknownInputs.length) add('error', `Unknown input types ${code(unknownInputs.join(', '))}. Use: ${Object.keys(taxonomy.inputs).join(', ')}.`);
  if (!friendly.size && !unknownInputs.length && tool.inputs.length) add('ok', 'All required details are filled in and valid.');

  // Duplicates and earlier decisions
  const listed = readYamlDir(paths.tools);
  const sameUrl = tool.url && listed.find((t) => urlKey(t.tool.url) === urlKey(tool.url));
  const sameName = tool.name && listed.find((t) => nameKey(t.tool.name) === nameKey(tool.name));
  if (sameUrl) add('error', `Already listed as **${sameUrl.tool.name}** (https://osinthub.pages.dev/tools/${sameUrl.slug}).`);
  else if (sameName) add('warn', `A tool with the same name is already listed: https://osinthub.pages.dev/tools/${sameName.slug}. Is this the same tool?`);
  else add('ok', 'Not already listed.');
  if (tool.url) {
    const rejected = readListWithReasons(paths.rejected).get(urlKey(tool.url));
    const alias = readListWithReasons(paths.aliases).get(urlKey(tool.url));
    if (rejected !== undefined) add('error', `This URL was reviewed before and not listed: ${rejected || 'no reason recorded'}.`);
    if (alias !== undefined) add('error', `This is an old address of a listed tool (${alias}).`);
  }

  // Policy
  const text = `${tool.name ?? ''} ${tool.description ?? ''} ${tool.notes ?? ''} ${fields.why ?? ''}`;
  if (leakPattern.test(text)) add('warn', 'Mentions breaches, leaks or credentials. Tools that sell or expose leaked data are not listed; breach *notification* services are fine. A maintainer will check.');
  if (peoplePattern.test(text) || tool.category === 'people') add('warn', 'People search or face search: listed with a responsible-use notice after an individual review.');

  // The link itself
  if (tool.url) {
    try {
      const link = await safeCheckUrl(tool.url);
      if (link.result === 'ok') add('ok', `The link works (HTTP ${link.code}).`);
      else if (link.result === 'blocked') add('warn', `Could not check the link automatically (${link.reason}); a maintainer will open it by hand.`);
      else add('error', `The link does not work: ${link.reason}.`);
      if (link.movedTo) add('warn', `The link redirects to ${code(link.movedTo)}. Should the URL be that instead?`);
      if (link.meta_description && norm(tool.description) && norm(link.meta_description).includes(norm(tool.description).slice(0, 60)))
        add('error', "The description matches the tool's own website text. Please describe it in your own words.");
    } catch (e) {
      add('error', `The URL ${code(tool.url)} ${e.message.replace(/host .* does not/, 'does not')}.`);
    }
  }

  // The repository, for open-source tools
  if (tool.repo && !/^[\w.-]+\/[\w.-]+$/.test(tool.repo)) add('error', `GitHub repo must look like owner/name, got ${code(tool.repo)}.`);
  else if (tool.repo) {
    const r = await checkRepo(tool.repo);
    if (r.missing) add('error', `GitHub repo ${code(tool.repo)} was not found.`);
    else if (r.error) add('warn', `Could not read the GitHub repo (${r.error}).`);
    else if (r.archived) add('error', `GitHub repo ${code(tool.repo)} is archived (no longer maintained).`);
    else {
      const days = r.pushed_at ? (Date.now() - Date.parse(r.pushed_at)) / 86_400_000 : 0;
      if (days > 3 * 365) add('error', `GitHub repo ${code(tool.repo)} has not been updated since ${r.pushed_at}.`);
      else if (days > 2 * 365) add('warn', `GitHub repo ${code(tool.repo)} was last updated ${r.pushed_at}; it will be marked stale.`);
      else add('ok', `GitHub repo ${code(tool.repo)} is maintained (${r.stars} stars, updated ${r.pushed_at}).`);
    }
  }

  return { tool, slug, results, ok: !results.some((r) => r.level === 'error') };
}

// ---- GitHub API ----

export async function github(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'user-agent': UA,
      ...(body && { 'content-type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  if (!res.ok && res.status !== 404) throw new Error(`GitHub API ${method} ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.status === 204 || res.status === 404 ? { status: res.status } : res.json();
}

export const MARKER = '<!-- osint-hub-submission-check -->';

/** Creates or updates the bot's single results comment on the issue. */
export async function upsertComment(repo, issue, markdown) {
  const comments = await github('GET', `/repos/${repo}/issues/${issue}/comments?per_page=100`);
  const mine = Array.isArray(comments) && comments.find((c) => c.body?.includes(MARKER));
  const body = `${MARKER}\n${markdown}`;
  if (mine) await github('PATCH', `/repos/${repo}/issues/comments/${mine.id}`, { body });
  else await github('POST', `/repos/${repo}/issues/${issue}/comments`, { body });
}

const LABEL_COLORS = { 'tool-submission': '0f6e5c', 'ready-for-review': '2da44e', 'needs-changes': 'd4a72c', approved: '8250df', 'listing-problem': 'b60205' };

export async function setStatusLabel(repo, issue, label) {
  for (const [name, color] of Object.entries(LABEL_COLORS)) {
    const existing = await github('GET', `/repos/${repo}/labels/${encodeURIComponent(name)}`);
    if (existing.status === 404) await github('POST', `/repos/${repo}/labels`, { name, color });
  }
  for (const other of ['ready-for-review', 'needs-changes'].filter((l) => l !== label)) {
    await github('DELETE', `/repos/${repo}/issues/${issue}/labels/${other}`).catch(() => {});
  }
  if (label) await github('POST', `/repos/${repo}/issues/${issue}/labels`, { labels: [label] });
}

/** Markdown for the results comment. User-supplied values only ever appear inside a fenced YAML block. */
export function renderResults({ tool, slug, results, ok }, yamlText) {
  const icon = { ok: '✅', warn: '⚠️', error: '❌' };
  const safeYaml = yamlText.replace(/`{3,}/g, "'''");
  return [
    ok ? '### Automatic check passed' : '### Automatic check: needs changes',
    '',
    ...results.map((r) => `- ${icon[r.level]} ${r.text}`),
    '',
    ok
      ? 'A maintainer will review it. Adding the `approved` label publishes it.'
      : 'Edit this issue to fix the ❌ items and the check runs again automatically.',
    '',
    `<details><summary>Entry as it would be published (<code>data/tools/${slug}.yaml</code>)</summary>`,
    '',
    '```yaml',
    safeYaml.trimEnd(),
    '```',
    '</details>',
  ].join('\n');
}
