// Finds a search URL (query_template) for tools that do not have one yet, by reading the search form on the
// tool's own page — and then proves it by fetching that URL with a real value. Nothing is written unless the
// check passed: a template that 404s is worse than no template (see README).
//
// It makes a couple of requests per candidate (the page, then the search URL), so unlike the weekly health
// check it is run on purpose, not on a schedule.
//
//   node scripts/query-templates.mjs                     report on the highest-value candidates
//   node scripts/query-templates.mjs --limit 200         check more of them
//   node scripts/query-templates.mjs --offset 300        carry on where the last run stopped
//   node scripts/query-templates.mjs --only sherlock,dnsdumpster
//   node scripts/query-templates.mjs --write --only a,b  write the verified templates into data/tools/
//
// --mappings is a JSON file of {"slug": ["input", ...]} for a search box that serves more than one of a tool's
// inputs. Without it, a tool with several inputs and no keyword input is reported as ambiguous and left alone.
//
// A report is always written to .cache/query-templates/ (report.json and report.md).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { paths, root, readYamlDir, toolErrors, readRejected, urlKey } from './lib/data.mjs';
import { UA, TIMEOUT_MS, pool } from './lib/net.mjs';
// The test values and the echo check live in one place, because template-check.mjs re-tests the published templates
// with the same machinery. Two copies would drift.
import { TEST_VALUES, SECOND_VALUES, echoed, fetchSearch } from './lib/templates.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const LIMIT = Number(flag('limit', 150));
const OFFSET = Number(flag('offset', 0));
const CONCURRENCY = Number(flag('concurrency', 6));
const ONLY = (flag('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const WRITE = has('write');
const MAPPINGS = flag('mappings', '') ? JSON.parse(readFileSync(flag('mappings'), 'utf8')) : {};
const OUT_DIR = join(root, '.cache/query-templates');

/** Field names a search box tends to use, best first. */
const SEARCH_FIELDS = [
  'q', 'query', 's', 'search', 'searchterm', 'search_term', 'search-term', 'searchtext', 'search_text',
  'term', 'keyword', 'keywords', 'k', 'kw', 'text', 'input', 'value', 'name',
];

// Top-level keys that come before query_template in a tool file; anything else is a later key to insert before.
const EARLY_KEYS = new Set(['name', 'url', 'description', 'category', 'inputs', 'outputs', 'type', 'cost', 'passive', 'account_required']);

const fetchHtml = async (url) => {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
  });
  const body = res.status < 400 ? await res.text().catch(() => '') : '';
  res.body?.cancel?.().catch(() => {});
  return { res, body };
};

const parseAttrs = (text) => {
  const attrs = {};
  const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(text))) attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  return attrs;
};

/** Every GET form on the page, with the fields a person could type into. */
function searchForms(html, pageUrl) {
  const forms = [];
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let f;
  while ((f = formRe.exec(html))) {
    const attrs = parseAttrs(f[1]);
    if ((attrs.method ?? 'get').toLowerCase() !== 'get') continue;
    let action;
    try {
      action = new URL(attrs.action || pageUrl, pageUrl);
    } catch {
      continue;
    }
    if (action.protocol !== 'https:') continue;
    const fields = [];
    const inputRe = /<input\b([^>]*)>/gi;
    let i;
    while ((i = inputRe.exec(f[2]))) {
      const a = parseAttrs(i[1]);
      const type = (a.type ?? 'text').toLowerCase();
      if (!a.name || ['hidden', 'submit', 'button', 'image', 'file', 'reset', 'checkbox', 'radio', 'range', 'date'].includes(type)) continue;
      fields.push(a.name);
    }
    if (fields.length) forms.push({ action, fields });
  }
  return forms;
}

/** The URL for a search, with a literal {query} the schema requires. URLSearchParams would encode the braces. */
function templateFor(action, field) {
  const base = action.toString().split('#')[0];
  const sep = base.endsWith('?') || base.endsWith('&') ? '' : base.includes('?') ? '&' : '?';
  return `${base}${sep}${encodeURIComponent(field)}={query}`;
}

async function inspect(slug, tool) {
  const mapping = mappedInput(slug, tool);
  const result = { slug, name: tool.name, category: tool.category, inputs: tool.inputs, url: tool.url, ...mapping, input: mapping.targets?.[0] };
  if (result.skipped) return result;

  let page;
  try {
    page = await fetchHtml(tool.url);
  } catch (e) {
    return { ...result, skipped: `page unreachable (${e.name === 'TimeoutError' ? 'timeout' : e.message})` };
  }
  if (page.res.status >= 400) return { ...result, skipped: `page returned HTTP ${page.res.status}` };

  const forms = searchForms(page.body, tool.url);
  if (!forms.length) return { ...result, skipped: 'no GET search form on the page' };

  const value = TEST_VALUES[result.input];
  // The best field of each form, best form first, and at most two live attempts.
  const candidates = forms
    .map((form) => ({ form, field: [...form.fields].sort((a, b) => rank(a) - rank(b))[0] }))
    .sort((a, b) => rank(a.field) - rank(b.field))
    .slice(0, 2)
    .map(({ form, field }) => ({ form, field, template: templateFor(form.action, field) }));

  for (const candidate of candidates) {
    const first = await fetchSearch(candidate.template, value);
    if (!first.ok) continue; // 404/410/5xx: this URL is not the search URL. Try the next candidate.
    // One echoed value can be a coincidence (a cached page, a canonical link). Two different ones cannot.
    const second = first.echoed ? await fetchSearch(candidate.template, SECOND_VALUES[result.input]) : undefined;
    const status = first.echoed ? (second?.echoed ? 'verified' : 'probable') : first.challenged ? 'blocked' : 'probable';
    return {
      ...result,
      template: candidate.template,
      evidence: { formAction: candidate.form.action.toString(), field: candidate.field, fields: candidate.form.fields },
      check: { status, http: first.http, echoed: first.echoed, confirmed: !!second?.echoed, finalUrl: first.finalUrl },
    };
  }
  return { ...result, skipped: 'every candidate URL failed the live check' };
}

const rank = (field) => {
  const i = SEARCH_FIELDS.indexOf(field.toLowerCase());
  return i === -1 ? SEARCH_FIELDS.length : i;
};

/** Which input types this search box belongs to, and whether that is a safe guess. */
function mappedInput(slug, tool) {
  const usable = tool.inputs.filter((i) => TEST_VALUES[i]);
  if (!usable.length) return { skipped: `no test value for ${tool.inputs.join(', ')}` };
  // An explicit mapping (--mappings) wins: a free-text box can serve several of a tool's inputs at once.
  const override = MAPPINGS[slug];
  if (override) {
    const targets = [].concat(override).filter((i) => tool.inputs.includes(i));
    if (!targets.length) return { skipped: `mapping for ${slug} names no input the tool takes` };
    return { targets, ambiguous: false };
  }
  if (tool.inputs.length === 1) return { targets: [tool.inputs[0]], ambiguous: false };
  if (tool.inputs.includes('keyword')) return { targets: ['keyword'], ambiguous: false };
  // A search box on a page that takes several specific inputs could be searching any of them.
  return { targets: [usable[0]], ambiguous: true };
}

/** A URL is a plain YAML scalar unless it contains something that would end the scalar or start a new token. */
const yamlScalar = (url) => (/^(?:[&*!|>%@`{}[\],#'"]|-\s)|\s#|:\s|\s$/.test(url) ? `'${url.replace(/'/g, "''")}'` : url);

/** YAML for the new field, in the file's own key order. */
function insertTemplate(yamlText, template, targets, toolInputs) {
  const scalar = yamlScalar(template);
  // The short form repeats one URL for every input the tool takes, so it is only correct for a one-input tool.
  const block =
    targets.length === 1 && toolInputs.length === 1
      ? [`query_template: ${scalar}`]
      : ['query_template:', ...targets.map((input) => `  ${input}: ${scalar}`)];
  const lines = yamlText.split('\n');
  const at = lines.findIndex((line) => {
    const key = line.match(/^([a-z_]+):/)?.[1];
    return key && !EARLY_KEYS.has(key);
  });
  if (at !== -1) lines.splice(at, 0, ...block);
  else {
    const end = lines.at(-1) === '' ? lines.length - 1 : lines.length;
    lines.splice(end, 0, ...block);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------

const entries = readYamlDir(paths.tools).map(({ slug, file, tool }) => ({ slug, file, tool }));
const rejected = readRejected();
const health = existsSync(paths.health) ? JSON.parse(readFileSync(paths.health, 'utf8')) : {};

// Tools the launcher would gain the most from: passive web pages, in the input types people use most.
const inputPopularity = {};
for (const { tool } of entries) for (const i of tool.inputs) inputPopularity[i] = (inputPopularity[i] ?? 0) + 1;

const candidates = entries
  .filter(({ slug, tool }) => tool && !tool.query_template && ['web', 'extension'].includes(tool.type))
  .filter(({ slug, tool }) => health[slug]?.status !== 'down' && !rejected.has(urlKey(tool.url)))
  .filter(({ tool }) => { try { return new URL(tool.url).hostname !== 'github.com'; } catch { return false; } })
  .filter(({ slug }) => !ONLY.length || ONLY.includes(slug))
  .sort((a, b) => {
    const single = (e) => (e.tool.inputs.length === 1 ? 0 : 1);
    const pop = (e) => Math.max(...e.tool.inputs.map((i) => inputPopularity[i] ?? 0));
    const passive = (e) => Number(!e.tool.passive);
    return single(a) - single(b) || passive(a) - passive(b) || pop(b) - pop(a) || a.tool.name.localeCompare(b.tool.name);
  });

const selected = candidates.slice(OFFSET, ONLY.length ? candidates.length : OFFSET + LIMIT);
console.log(`Checking ${selected.length} of ${candidates.length} tools without a query_template (a few requests each)...\n`);

const results = await pool(selected, CONCURRENCY, ({ slug, tool }) => inspect(slug, tool));
const found = results.filter((r) => r.check);
const verified = found.filter((r) => r.check.status === 'verified');
const probable = found.filter((r) => r.check.status === 'probable');

// ---------------------------------------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify({ generated: new Date().toISOString(), checked: selected.length, candidates: candidates.length, results }, null, 2) + '\n');

const line = (r) => `| \`${r.slug}\` | ${r.name} | ${r.check.status} | \`${r.template}\` | ${r.check.http} |${r.ambiguous ? ' ⚠️' : ''}`;
const skippedReasons = {};
for (const r of results.filter((r) => r.skipped)) skippedReasons[r.skipped.replace(/\(.*\)/, '(...)')] = (skippedReasons[r.skipped.replace(/\(.*\)/, '(...)')] ?? 0) + 1;

let md = `# Query template candidates\n\nChecked ${selected.length} tools without a query_template on ${new Date().toISOString().slice(0, 10)}.\n\n`;
md += `**${verified.length} verified** (the page echoed two different values back), **${probable.length} probable** (HTTP 200, but one or both values were not in the page), ${results.filter((r) => r.skipped).length} with no usable form.\n\n`;
md += `⚠️ marks a tool whose search box could be searching a different one of its input types; map those by hand with --mappings.\n\n`;
if (verified.length) md += `## Verified\n\n| slug | name | status | template | http | |\n| --- | --- | --- | --- | --- | --- |\n${verified.map(line).join('\n')}\n\n`;
if (probable.length) md += `## Probable\n\n| slug | name | status | template | http | |\n| --- | --- | --- | --- | --- | --- |\n${probable.map(line).join('\n')}\n\n`;
md += `## Skipped\n\n| reason | tools |\n| --- | --- |\n${Object.entries(skippedReasons).sort((a, b) => b[1] - a[1]).map(([r, n]) => `| ${r} | ${n} |`).join('\n')}\n`;
writeFileSync(join(OUT_DIR, 'report.md'), md);

console.log(md.split('\n').slice(0, 6).join('\n'));
console.log(`\nReport: ${join(OUT_DIR, 'report.md')}`);
for (const r of verified.slice(0, 40)) console.log(`  verified  ${r.slug.padEnd(36)} ${r.template}${r.ambiguous ? `   [ambiguous: ${r.targets.join(', ')}?]` : ''}`);
if (verified.length > 40) console.log(`  ...and ${verified.length - 40} more in the report`);

if (!WRITE) {
  console.log(`\nNothing written. Re-run with --write --only <slugs> to add the verified ones.`);
} else {
  const writable = verified.filter((r) => !r.ambiguous);
  let written = 0;
  const problems = [];
  for (const r of writable) {
    const { file, tool } = entries.find((e) => e.slug === r.slug);
    const path = join(paths.tools, file);
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, insertTemplate(original, r.template, r.targets, tool.inputs));
    let check;
    let errors = [];
    try {
      check = yaml.load(readFileSync(path, 'utf8'));
      errors = toolErrors(check);
    } catch (e) {
      errors = [e.message];
    }
    if (!check?.query_template || errors.length) {
      writeFileSync(path, original);
      problems.push(`${r.slug}: reverted (${errors.join('; ') || 'query_template did not parse'})`);
      continue;
    }
    written += 1;
    console.log(`  wrote     ${r.slug}  ${r.template}`);
  }
  console.log(`\nWrote ${written} template(s).`);
  for (const p of problems) console.error(`  ${p}`);
  if (written) console.log('Now run: npm test && npm run validate && npm run build');
}
