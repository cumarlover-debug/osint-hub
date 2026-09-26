// Step 1: collect candidate tools from public OSINT lists into .cache/pipeline/candidates.json.
//
//   npm run pipeline:harvest
//
// Sources:
//   awesome-osint   https://github.com/jivoi/awesome-osint        CC BY-SA 4.0
//   OSINT Framework https://github.com/lockfale/OSINT-Framework   MIT
// Only facts are taken from them (name, URL, section, pricing and similar flags). Their descriptions
// are kept as reviewer notes in the drafts and are never published: every description is written fresh.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, readYamlDir, readRejected, urlKey, nameKey } from '../lib/data.mjs';
import { UA } from '../lib/net.mjs';
import { awesomeRules, frameworkRules, matchRule, inputsFromText, leakPattern, peoplePattern } from './mapping.mjs';

const SOURCES = {
  awesome: 'https://raw.githubusercontent.com/jivoi/awesome-osint/master/README.md',
  framework: 'https://raw.githubusercontent.com/lockfale/OSINT-Framework/master/public/arf.json',
};

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

const cleanHeading = (h) =>
  h
    .replace(/\[↑\]\([^)]*\)/g, '')
    .replace(/[^\p{L}\p{N}&/(),.' -]/gu, '')
    .trim();

function parseAwesome(md) {
  const out = [];
  let h2 = '';
  let h3 = '';
  for (const line of md.split('\n')) {
    const heading = line.match(/^(#{2,3})\s+(.*)/);
    if (heading) {
      if (heading[1] === '##') [h2, h3] = [cleanHeading(heading[2]), ''];
      else h3 = cleanHeading(heading[2]);
      continue;
    }
    const item = line.match(/^\s*[*-]\s+\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\s*(?:[-–—:]\s*(.*))?$/);
    if (!item) continue;
    const section = h3 ? `${h2} > ${h3}` : h2;
    out.push({ list: 'awesome-osint', name: item[1].trim(), url: item[2], section, description: item[3]?.trim() || undefined });
  }
  return out;
}

function parseFrameworkTree(json) {
  const out = [];
  // Name suffixes: (T) needs installing, (R) needs registration, (D) Google dork, (M) edit the URL by hand.
  const visit = (node, path) => {
    if (node.type === 'url') {
      const suffix = node.name.match(/\(([A-Z, ]+)\)\s*$/)?.[1] ?? '';
      out.push({
        list: 'osint-framework',
        name: node.name.replace(/\s*\([A-Z, ]+\)\s*$/, '').trim(),
        url: node.url,
        section: path.join(' > '),
        description: node.description || undefined,
        facts: {
          status: node.status,
          pricing: node.pricing,
          opsec: node.opsec?.toLowerCase(),
          registration: Boolean(node.registration || suffix.includes('R')),
          local_install: Boolean(node.localInstall || suffix.includes('T')),
          dork: Boolean(node.googleDork || suffix.includes('D')),
          manual_url: Boolean(node.editUrl || suffix.includes('M')),
          deprecated: Boolean(node.deprecated),
          input: node.input,
          output: node.output,
        },
      });
      return;
    }
    for (const child of node.children ?? []) visit(child, child.type === 'url' ? path : [...path, child.name]);
  };
  visit(json, []);
  return out;
}

const confidenceRank = { high: 3, medium: 2, low: 1 };

function skipReason(entry) {
  const f = entry.facts;
  if (!f) return undefined;
  if (f.deprecated || ['down', 'defunct'].includes(f.status)) return `marked ${f.deprecated ? 'deprecated' : f.status} by the source`;
  if (f.dork) return 'Google dork, not a tool';
  if (f.manual_url) return 'needs the URL edited by hand';
  return undefined;
}

console.log('Fetching sources…');
const [md, arf] = await Promise.all([get(SOURCES.awesome), get(SOURCES.framework)]);
const entries = [...parseAwesome(md), ...parseFrameworkTree(JSON.parse(arf))];

// Listed tools are matched by URL and by name; drafts by URL only, since a re-harvest must not
// drop a candidate just because a draft for it already exists under another name.
const known = new Set();
for (const { tool } of readYamlDir(paths.tools)) if (tool) known.add(urlKey(tool.url)).add(`name:${nameKey(tool.name)}`);
for (const { tool } of readYamlDir(paths.drafts)) if (tool) known.add(urlKey(tool.url));
const rejected = readRejected();

const stats = { entries: entries.length, outOfScope: 0, skippedBySource: 0, alreadyListed: 0, rejected: 0 };
const byKey = new Map();

for (const entry of entries) {
  const rules = entry.list === 'awesome-osint' ? awesomeRules : frameworkRules;
  const rule = matchRule(rules, entry.section);
  if (!rule) {
    stats.outOfScope++;
    continue;
  }
  if (skipReason(entry)) {
    stats.skippedBySource++;
    continue;
  }
  const key = urlKey(entry.url);
  if (known.has(key) || known.has(`name:${nameKey(entry.name)}`)) {
    stats.alreadyListed++;
    continue;
  }
  if (rejected.has(key)) {
    stats.rejected++;
    continue;
  }

  const c = byKey.get(key) ?? { key, name: entry.name, url: entry.url, sources: [], flags: new Set(), inputs: new Set() };
  c.sources.push({ list: entry.list, section: entry.section, description: entry.description, facts: entry.facts, rule });
  for (const flag of rule.flags ?? []) c.flags.add(flag);
  const text = `${entry.name} ${entry.section} ${entry.description ?? ''}`;
  if (leakPattern.test(text)) c.flags.add('policy-leak: may deal in leaked data, not listed');
  else if (peoplePattern.test(text)) c.flags.add('policy-people: people or face search, check it is not a data broker of leaked data');
  byKey.set(key, c);
}

const candidates = [...byKey.values()].map((c) => {
  // The most confident source decides the category; inputs combine the rule with the source's own "input" text.
  const best = [...c.sources].sort((a, b) => confidenceRank[b.rule.confidence] - confidenceRank[a.rule.confidence])[0];
  const fw = c.sources.find((s) => s.list === 'osint-framework')?.facts;
  const textInputs = inputsFromText(fw?.input);
  const inputs = textInputs.length ? textInputs : best.rule.inputs;
  if (textInputs.length && !textInputs.some((i) => best.rule.inputs.includes(i))) c.flags.add(`inputs: section suggests ${best.rule.inputs.join(', ')}`);
  if (c.url.startsWith('http://')) c.flags.add('http only: check for an https version');

  const score =
    confidenceRank[best.rule.confidence] * 2 +
    (c.sources.length > 1 ? 4 : 0) + // listed in both sources
    (fw?.status === 'live' ? 1 : 0) +
    (c.sources.some((s) => s.description) ? 1 : 0) -
    (c.flags.size ? 1 : 0);

  return {
    key: c.key,
    name: c.name,
    url: c.url.replace(/^http:\/\//, 'https://'),
    category: best.rule.category,
    inputs,
    confidence: best.rule.confidence,
    score,
    flags: [...c.flags],
    facts: fw,
    sources: c.sources.map(({ list, section, description }) => ({ list, section, description })),
  };
});
candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

mkdirSync(paths.cache, { recursive: true });
writeFileSync(join(paths.cache, 'candidates.json'), JSON.stringify(candidates, null, 2));

const count = (fn) => candidates.reduce((m, c) => ((m[fn(c)] = (m[fn(c)] ?? 0) + 1), m), {});
console.log(`
Read ${stats.entries} entries: ${stats.outOfScope} out of scope (search engines, news, courses…),
${stats.skippedBySource} dead/deprecated/dorks per the source, ${stats.alreadyListed} already listed or drafted, ${stats.rejected} rejected before.

${candidates.length} new candidates → .cache/pipeline/candidates.json
  in both lists: ${candidates.filter((c) => c.sources.length > 1).length}
  by confidence: ${JSON.stringify(count((c) => c.confidence))}
  by category:   ${JSON.stringify(count((c) => c.category))}
  flagged:       ${candidates.filter((c) => c.flags.length).length}

Next: npm run pipeline:draft -- --limit 50`);
