// The target profile: what is known, how it was learned, and what that implies about where to look next.
//
// It is deliberately a flat, inspectable JSON structure rather than a graph database. An investigation on one target
// is small — hundreds of facts at most — and the value here is that a person can read the file, diff it after every
// run, and see exactly which tool produced which line. Everything in it is a candidate: the profile accumulates
// leads and their provenance, and it never upgrades one to a conclusion on its own.
//
// Redaction is applied again here, on the way in and on the way out, because a profile can be built from findings
// that did not come through the extractor — a hand-edited file, or a future runner passing results directly. The
// rule that a case never stores a working credential should not depend on which path the data took.
import { redactSecrets } from './extract.mjs';

export const PROFILE_VERSION = 1;

const norm = (v) => String(v ?? '').trim();
const key = (kind, value) => `${kind}:${norm(value).toLowerCase().replace(/\s+/g, ' ')}`;

/** A profile for one target. `title` is the case title; `basis` is whatever the investigator wrote about authority. */
export function emptyProfile(title, basis) {
  return {
    version: PROFILE_VERSION,
    title: norm(title),
    ...(basis ? { basis: norm(basis) } : {}),
    started: new Date().toISOString().slice(0, 10),
    updated: new Date().toISOString().slice(0, 10),
    entities: {},
    relations: [],
    runs: {},
  };
}

/**
 * Fold one tool's findings into the profile.
 *
 * @param {object} profile
 * @param {{ value: string, valueType?: string, tool: string, slug?: string, status?: string, findings: Array<object>, at?: string, source?: string }} input
 */
export function addFindings(profile, { value, valueType, tool, slug, status, findings = [], at, source }) {
  const when = at ?? new Date().toISOString();
  const day = when.slice(0, 10);
  const target = norm(value);

  // Record that the tool ran against this value, whatever it returned: that is how the planner knows what has
  // already been tried, including the attempts that found nothing.
  const runs = (profile.runs[target] ??= {});
  const run = (runs[slug ?? tool] ??= { at: when, status: status ?? 'unknown', found: 0 });
  run.at = when;
  run.status = status ?? run.status ?? 'unknown';

  const targetId = key(valueType ?? 'keyword', target);
  if (!profile.entities[targetId]) {
    profile.entities[targetId] = {
      id: targetId,
      kind: valueType ?? 'keyword',
      value: target,
      firstSeen: day,
      lastSeen: day,
      sources: [],
      isTarget: true,
    };
  }
  const targetEntity = profile.entities[targetId];
  targetEntity.lastSeen = day;

  for (const f of findings) {
    const safeValue = redactSecrets(norm(f.value));
    const safeEvidence = redactSecrets(norm(f.evidence));
    const id = key(f.kind, safeValue);
    const entity = (profile.entities[id] ??= {
      id,
      kind: f.kind,
      value: safeValue,
      firstSeen: day,
      lastSeen: day,
      sources: [],
    });
    entity.lastSeen = day;
    // Keep a few evidence lines per entity: enough to check the claim, not enough to bloat the file.
    if (entity.sources.length < 4 && !entity.sources.some((s) => s.tool === (slug ?? tool) && s.evidence === safeEvidence)) {
      entity.sources.push({ tool: slug ?? tool, at: when, source: source ?? f.source, evidence: safeEvidence });
    }
    run.found += 1;
    const relation = { from: targetId, to: id, kind: 'found-by', tool: slug ?? tool, at: when };
    if (!profile.relations.some((r) => r.from === relation.from && r.to === relation.to && r.tool === relation.tool)) {
      profile.relations.push(relation);
    }
  }

  profile.updated = day;
  return profile;
}

/** Entities grouped by kind, biggest first, with the ones that are the target left out. */
export function profileByKind(profile) {
  const groups = {};
  for (const e of Object.values(profile.entities)) {
    if (e.isTarget) continue;
    (groups[e.kind] ??= []).push(e);
  }
  for (const list of Object.values(groups)) list.sort((a, b) => b.sources.length - a.sources.length || a.value.localeCompare(b.value));
  return groups;
}

export function profileCounts(profile) {
  const groups = profileByKind(profile);
  const counts = {};
  for (const [kind, list] of Object.entries(groups)) counts[kind] = list.length;
  return { entities: Object.values(profile.entities).length, leads: Object.values(profile.entities).filter((e) => !e.isTarget).length, toolsRun: Object.values(profile.runs).reduce((n, r) => n + Object.keys(r).length, 0), byKind: counts };
}

/** Distinct tools that have already been run against a value, so the planner can skip them. */
export function toolsRunFor(profile, value) {
  return new Set(Object.keys(profile.runs[norm(value)] ?? {}));
}

/** Values that appeared as findings and could themselves be searched: the pivot list, best evidence first. */
export function pivotCandidates(profile, kinds = ['email', 'username', 'phone', 'domain', 'name', 'crypto_address', 'ip', 'url']) {
  const out = [];
  for (const e of Object.values(profile.entities)) {
    if (e.isTarget || !kinds.includes(e.kind)) continue;
    out.push({ kind: e.kind, value: e.value, sources: e.sources.length, firstSeen: e.firstSeen });
  }
  return out.sort((a, b) => b.sources - a.sources || a.kind.localeCompare(b.kind));
}

// Escaped and redacted as a last guard, so a profile.json edited by hand still cannot leak a credential into the
// report through a value or an evidence line.
const esc = (s) =>
  redactSecrets(String(s ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\|/g, '\\|');

/**
 * The dossier: a readable account of the profile, written to be read by a person who has to act on it. It states
 * what each thing is, how it was found and when, and keeps leads and absences apart.
 */
export function dossierMarkdown(profile, { gaps = [], manual = [] } = {}) {
  const counts = profileCounts(profile);
  const groups = profileByKind(profile);
  const lines = [];
  lines.push(`# ${profile.title || 'Target profile'}`);
  lines.push('');
  lines.push(`Compiled ${profile.updated} · ${counts.leads} leads from ${counts.toolsRun} tool runs`);
  lines.push('');
  if (profile.basis) {
    lines.push(`**Authority and basis.** ${profile.basis}`);
    lines.push('');
  }
  lines.push('Everything below is a **candidate**. A finding records what a tool returned about a value, with the line');
  lines.push('it came from; none of it is a conclusion until a person confirms it against a second, independent source.');
  lines.push('');

  const order = ['account', 'email', 'username', 'phone', 'name', 'org', 'domain', 'ip', 'location', 'url', 'breach', 'document', 'hash', 'crypto_address', 'vehicle', 'vessel', 'aircraft'];
  const titles = {
    account: 'Accounts found',
    email: 'Email addresses',
    username: 'Usernames and handles',
    phone: 'Phone numbers',
    name: 'Names',
    org: 'Organisations',
    domain: 'Domains',
    ip: 'IP addresses',
    location: 'Places',
    url: 'Pages',
    breach: 'Breach and leak indications',
    document: 'Document metadata',
    hash: 'Hashes',
    crypto_address: 'Crypto addresses',
  };
  const seenKinds = [...order.filter((k) => groups[k]), ...Object.keys(groups).filter((k) => !order.includes(k))];

  lines.push('## What is known');
  lines.push('');
  if (!seenKinds.length) {
    lines.push('_Nothing yet. Run the agent against the identifiers, or add evidence you already hold._');
    lines.push('');
  }
  for (const kind of seenKinds) {
    lines.push(`### ${titles[kind] ?? kind} (${groups[kind].length})`);
    lines.push('');
    for (const e of groups[kind].slice(0, 40)) {
      const by = e.sources.map((s) => s.tool).filter((v, i, a) => a.indexOf(v) === i).join(', ') || 'unknown tool';
      lines.push(`- ${kind === 'url' || kind === 'account' ? `[${esc(e.value)}](${esc(e.value)})` : esc(e.value)} — _${esc(by)}, first seen ${e.firstSeen}_`);
      for (const s of e.sources.slice(0, 2)) if (s.evidence && s.evidence !== e.value) lines.push(`  - \`${esc(s.evidence.slice(0, 180))}\``);
    }
    if (groups[kind].length > 40) lines.push(`- …and ${groups[kind].length - 40} more in \`profile.json\``);
    lines.push('');
  }

  lines.push('## What has been run');
  lines.push('');
  lines.push('Every tool tried against every value, including the attempts that found nothing. This is the record that keeps');
  lines.push('the work from covering the same ground twice, and it is as much a part of the case as the findings are.');
  lines.push('');
  const runValues = Object.entries(profile.runs);
  if (!runValues.length) {
    lines.push('_Nothing yet._');
    lines.push('');
  } else {
    for (const [value, tools] of runValues) {
      const parts = Object.entries(tools).map(([tool, r]) => `${tool} (${r.status}${r.found ? `, ${r.found}` : ', nothing'})`);
      lines.push(`- **${esc(value)}** — ${esc(parts.join(' · '))}`);
    }
    lines.push('');
  }

  if (gaps.length) {
    lines.push('## Not yet checked');
    lines.push('');
    lines.push('Work the agent has identified but not done, because it needs a tool that is not installed, a query only a');
    lines.push('person can run, or a decision you have not made yet.');
    lines.push('');
    for (const g of gaps.slice(0, 30)) lines.push(`- ${esc(g)}`);
    lines.push('');
  }

  if (manual.length) {
    lines.push('## Do these by hand');
    lines.push('');
    lines.push('Services that answer a form, a captcha or a key rather than a request. The agent leaves them here rather');
    lines.push('than wasting a pass on a wall.');
    lines.push('');
    for (const m of manual.slice(0, 30)) lines.push(`- ${m.link ? `[${esc(m.name)}](${esc(m.link)})` : esc(m.name)} — ${esc(m.why ?? 'needs doing by hand')}`);
    lines.push('');
  }

  lines.push('## How to read this');
  lines.push('');
  lines.push('- **Provenance matters more than volume.** Each line names the tool and the output it came from; a lead with one');
  lines.push('  source and one tool is a hypothesis, not a fact.');
  lines.push('- **A non-result is a result.** The runs table in `profile.json` records every tool tried against every value,');
  lines.push('  including the ones that found nothing, so the same ground is not covered twice.');
  lines.push('- **Nothing here is a conclusion.** Names repeat, aggregators merge people, and breach sets are stale or planted.');
  lines.push('- **Credentials are never stored.** Passwords are redacted on the way in and hashes are masked; if a tool printed');
  lines.push('  one, the report says a record exists and nothing more.');
  lines.push('');
  return lines.join('\n');
}
