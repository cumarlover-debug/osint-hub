// The workbench behind /case: turning a set of identifiers into a plan of which tools to use, and a report of
// what came back. Kept here, dependency-free like shared/launcher.mjs, so the page, the CLI and the tests all
// run the same code.
//
// Nothing in this file contacts anything. It maps a value onto the tools that can take it, derives the values
// that follow from it, and formats what the investigator recorded. Running a tool stays a deliberate act by the
// person holding the browser.
import {
  detect as detectType,
  templatesFor,
  applies,
  buildLink,
  commandTemplatesFor,
  quoteArg,
  commandProblem,
} from './launcher.mjs';

/** Tags that mean "read the responsible-use notice before using this". */
export const SENSITIVE_TAGS = ['face-recognition', 'personal-data', 'leak-data', 'covert-tracking', 'surveillance'];

/** People search is sensitive by category, everything else by tag. */
export const isSensitive = (tool) =>
  tool.category === 'people' || (tool.tags ?? []).some((tag) => SENSITIVE_TAGS.includes(tag));

/**
 * The by-hand work the agent may attempt, and the work it must leave to a person.
 *
 * A form can be driven: fill the box, submit, read the answer. A bot check may be got past by a real browser, so it
 * is attempted and honestly reported when it is not. A service that wants a login, an API key or an interactive
 * console is never attempted, because attempting it would mean handling credentials the agent has no business
 * holding. The line lives here, where it can be tested, rather than inside the loop that uses it.
 */
export const MANUAL_ATTEMPTABLE = ['post-form', 'captcha'];
export const MANUAL_HUMAN_ONLY = ['login', 'api-key', 'interactive'];

/** Split by-hand rows into what the agent may try and what stays with the investigator. */
export function splitByHand(rows) {
  const attemptable = [];
  const humanOnly = [];
  for (const row of rows ?? []) {
    if (!row?.manual) continue;
    (MANUAL_ATTEMPTABLE.includes(row.manual) ? attemptable : humanOnly).push(row);
  }
  return { attemptable, humanOnly };
}

/** What can be said about a tool's outcome, and how it reads in a report. */
export const FINDING_STATUS = {
  todo: { label: 'To do', mark: '- [ ]' },
  ran: { label: 'Ran, nothing useful', mark: '- [~]' },
  found: { label: 'Found something', mark: '- [x]' },
  deadend: { label: 'Dead end', mark: '- [-]' },
};

// ---------------------------------------------------------------------------------------------------------
// The case model
//
// The same shape is written to the browser's storage and to a backup file, and a backup file is untrusted
// input: everything read back goes through sanitiseCaseState first.

export const CASE_SCHEMA = 1;

let counter = 0;
/** Small enough to read, unique enough for one browser's cases. */
export const uid = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function newCaseFile(title = 'Untitled investigation') {
  const now = new Date().toISOString();
  return { id: uid(), title, created: now, updated: now, notes: '', safe: false, values: [], findings: [] };
}

export function emptyCaseState() {
  const first = newCaseFile();
  return { schema: CASE_SCHEMA, activeId: first.id, cases: [first] };
}

const text = (value, fallback = '') => (typeof value === 'string' ? value : fallback);
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : undefined);

/**
 * Anything from storage or a backup file, reduced to the shape the page can trust: unknown fields dropped,
 * entries without a value skipped, findings for a value that is gone removed, unknown statuses back to "to do".
 */
export function sanitiseCaseState(raw) {
  const state = object(raw) ?? {};
  const clean = [];
  for (const entry of Array.isArray(state.cases) ? state.cases : []) {
    const c = object(entry);
    if (!c) continue;
    const values = (Array.isArray(c.values) ? c.values : [])
      .map(object)
      .filter(Boolean)
      .filter((v) => text(v.value).trim() && text(v.type).trim())
      .map((v) => ({
        id: text(v.id) || uid(),
        value: text(v.value),
        type: text(v.type),
        ...(text(v.via) && { via: text(v.via) }),
        ...(v.guess === true && { guess: true }),
        ...(text(v.note) && { note: text(v.note) }),
      }));
    const ids = new Set(values.map((v) => v.id));
    const findings = (Array.isArray(c.findings) ? c.findings : [])
      .map(object)
      .filter(Boolean)
      .filter((f) => ids.has(text(f.valueId)) && text(f.slug))
      .map((f) => ({
        valueId: text(f.valueId),
        slug: text(f.slug),
        status: FINDING_STATUS[text(f.status)] ? text(f.status) : 'todo',
        ...(text(f.note) && { note: text(f.note) }),
        at: text(f.at) || new Date().toISOString(),
      }));
    clean.push({
      id: text(c.id) || uid(),
      title: text(c.title, 'Untitled investigation') || 'Untitled investigation',
      created: text(c.created) || new Date().toISOString(),
      updated: text(c.updated) || new Date().toISOString(),
      notes: text(c.notes),
      safe: c.safe === true,
      values,
      findings,
    });
  }
  if (!clean.length) return emptyCaseState();
  const activeId = clean.some((c) => c.id === state.activeId) ? state.activeId : clean[0].id;
  return { schema: CASE_SCHEMA, activeId, cases: clean };
}

/** The case a state points at, falling back to the first. */
export const activeCase = (state) => state.cases.find((c) => c.id === state.activeId) ?? state.cases[0];


const USERNAME_SHAPE = /^[a-z0-9._-]{2,}$/i;

/**
 * Values that follow from a value you already have: the domain inside an email, the username inside it, the
 * stripped-down form of a phone number. Nothing here is a guess about a person — `guess: true` marks the
 * candidate usernames, which are only produced when the caller opts in.
 *
 * @param {string} raw
 * @param {{ candidates?: boolean }} [opts] candidates: also propose usernames from a name
 * @returns {{ value: string, type: string, via: string, guess: boolean }[]}
 */
export function derivePivots(raw, { candidates = false } = {}) {
  const value = String(raw ?? '').trim();
  if (!value) return [];
  const types = detectType(value);
  const out = [];

  if (types.includes('email')) {
    const [local, domain] = value.split('@');
    if (local && USERNAME_SHAPE.test(local)) out.push({ value: local, type: 'username', via: 'email', guess: false });
    if (domain) out.push({ value: domain, type: 'domain', via: 'email', guess: false });
  }
  if (types.includes('url')) {
    try {
      const host = new URL(value).hostname.replace(/^www\./, '');
      if (host) out.push({ value: host, type: 'domain', via: 'url', guess: false });
    } catch {
      // Not a URL after all; nothing to derive.
    }
  }
  if (types.includes('domain')) {
    out.push({ value: `https://${value.replace(/^https?:\/\//i, '')}`, type: 'url', via: 'domain', guess: false });
  }
  if (types.includes('phone')) {
    const plus = value.startsWith('+');
    const digits = value.replace(/\D/g, '');
    const normalised = digits ? `${plus ? '+' : ''}${digits}` : '';
    if (normalised && normalised !== value) out.push({ value: normalised, type: 'phone', via: 'phone', guess: false });
  }
  if (candidates && types.includes('name')) {
    const parts = value
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z\s]/g, '')
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length >= 2) {
      const first = parts[0];
      const last = parts[parts.length - 1];
      for (const candidate of [`${first}${last}`, `${first}.${last}`, `${first[0]}${last}`, `${last}${first[0]}`]) {
        out.push({ value: candidate, type: 'username', via: 'name', guess: true });
      }
    }
  }

  // Keep the first of each value: a name-derived "@" username must not follow the email it came from.
  const seen = new Set([value]);
  return out.filter((p) => p.value && !seen.has(p.value) && seen.add(p.value));
}

// ---------------------------------------------------------------------------------------------------------
// Which tools can take a value

/**
 * Every tool that takes this input type, with what it can do with the value: open a search URL, give you a
 * command to run, or only offer its own page.
 *
 * @param {any[]} tools
 * @param {string} type
 * @param {string} value
 * @param {{ safe?: boolean, shell?: 'posix'|'powershell', order?: string[] }} [opts]
 */
export function capabilityRows(tools, type, value, { safe = false, shell = 'posix', order = [] } = {}) {
  const v = String(value ?? '').trim();
  // A value that cannot safely be quoted is never turned into a command line (see commandProblem).
  const commandIssue = v ? commandProblem(v) : 'empty';
  const rows = [];

  for (const tool of tools) {
    if (!tool.inputs.includes(type)) continue;
    // Safe mode is the investigator's own guard: nothing that contacts the target, nothing that signs in on its own.
    // A service marked "by hand" is exempt from the account rule, because you sign in yourself and decide when —
    // hiding Dehashed or Snusbase from a safe-mode case is how the two best-known breach databases went missing.
    if (safe && (!tool.passive || (tool.account_required && !tool.manual))) continue;

    const template = templatesFor(tool.query_template, tool.inputs)[type];
    const command = commandTemplatesFor(tool.command_template, tool.inputs)[type];
    // Usable means the tool can be used with this value at all. Only a template that refuses the value (a
    // matcher for another format) makes a tool unusable, and those sort last with the reason.
    const usable = !template || (v ? applies(template, v) : true);

    rows.push({
      slug: tool.slug,
      name: tool.name,
      category: tool.category,
      passive: tool.passive,
      account: tool.account_required,
      cost: tool.cost,
      sensitive: isSensitive(tool),
      status: tool.status,
      kind: template ? 'link' : command ? 'command' : 'page',
      usable,
      // Some services cannot be queried from a URL at all: they answer only a POST form, sit behind a captcha, or
      // need a key. Sending a browser at them wastes a pass, so they are marked for a human instead.
      manual: tool.manual,
      why: template && !usable ? template.match : undefined,
      link: template && usable && v ? buildLink(template, v) : undefined,
      command: command && v && !commandIssue ? command.split('{query}').join(quoteArg(v, shell)) : undefined,
      install: command ? tool.install : undefined,
    });
  }

  const rank = (row) => (order.indexOf(row.category) === -1 ? order.length : order.indexOf(row.category));
  return rows.sort(
    (a, b) =>
      Number(!a.usable) - Number(!b.usable) ||
      Number(!a.passive) - Number(!b.passive) ||
      rank(a) - rank(b) ||
      a.name.localeCompare(b.name),
  );
}

/** Counts for the summary block of a report. */
export function summariseRows(rows) {
  return {
    total: rows.length,
    passive: rows.filter((r) => r.passive).length,
    active: rows.filter((r) => !r.passive).length,
    account: rows.filter((r) => r.account).length,
    paid: rows.filter((r) => r.cost === 'paid').length,
    links: rows.filter((r) => r.kind === 'link' && r.usable).length,
    commands: rows.filter((r) => r.kind === 'command').length,
    pages: rows.filter((r) => r.kind === 'page').length,
    sensitive: rows.filter((r) => r.sensitive).length,
  };
}

/** Rows grouped by category, in taxonomy order, for display. */
export function groupByCategory(rows, order = []) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.category)) groups.set(row.category, []);
    groups.get(row.category).push(row);
  }
  const rank = (key) => (order.indexOf(key) === -1 ? order.length : order.indexOf(key));
  return [...groups.entries()]
    .map(([category, items]) => ({ category, rows: items }))
    .sort((a, b) => rank(a.category) - rank(b.category) || a.category.localeCompare(b.category));
}

// ---------------------------------------------------------------------------------------------------------
// The report

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

const statusCounts = (sections) => {
  const counts = { todo: 0, ran: 0, found: 0, deadend: 0 };
  for (const section of sections) for (const f of section.findings ?? []) counts[f.status] = (counts[f.status] ?? 0) + 1;
  return counts;
};

/**
 * A dossier of one case, as Markdown. It records what the investigator chose to do and what they saw; it does
 * not claim a tool was run automatically, because a report that overstates its evidence is worse than none.
 *
 * @param {{ title?: string, generated?: string, notes?: string, sections?: any[], safe?: boolean }} data
 */
export function dossierMarkdown({ title, generated, notes, sections = [], safe = false } = {}) {
  const when = generated ?? new Date().toISOString().slice(0, 10);
  const counts = statusCounts(sections);
  const recorded = Object.values(counts).reduce((a, b) => a + b, 0);
  const lines = [
    `# ${cell(title) || 'Untitled investigation'}`,
    '',
    `Compiled ${when} with [osint-hub](https://osinthub.pages.dev/case). Every value was processed in the browser:`,
    'nothing was sent to osint-hub and no tool was queried automatically. Entries marked "ran" record what the',
    'investigator saw when they opened the tool themselves.',
  ];
  if (safe) lines.push('', '**Safe mode was on:** tools that contact the target, and tools that need an account, were left out.');
  lines.push(
    '',
    '## Summary',
    '',
    `- ${sections.length} identifier${sections.length === 1 ? '' : 's'}`,
    `- Findings recorded: ${recorded} (${counts.found} with something found, ${counts.todo} still to do)`,
    '',
  );

  for (const section of sections) {
    const summary = section.summary ?? summariseRows(section.rows ?? []);
    lines.push(`## ${cell(section.value)}`, '');
    lines.push(`- Type: ${cell(section.type) || 'unknown'}`);
    if (section.via) lines.push(`- Derived from: ${cell(section.via)}${section.guess ? ' (candidate)' : ''}`);
    if (section.note) lines.push(`- Note: ${cell(section.note)}`);
    lines.push(`- Capable tools: ${summary.total} (${summary.passive} passive, ${summary.links} with a direct search link, ${summary.commands} runnable on your machine)`);
    lines.push('', '### Findings', '');

    const findings = section.findings ?? [];
    if (!findings.length) lines.push('_Nothing recorded yet._');
    for (const f of findings) {
      const status = FINDING_STATUS[f.status] ?? FINDING_STATUS.todo;
      lines.push(`${status.mark} **${cell(f.name)}** — ${status.label}${f.note ? `: ${cell(f.note)}` : ''}`);
      if (f.link) lines.push(`  - ${f.link}`);
    }
    lines.push('');
  }

  if (notes && notes.trim()) lines.push('## Notes', '', notes.trim(), '');
  lines.push('---', '', 'Use these tools lawfully, and only on targets you have a legitimate reason to investigate.');
  return lines.join('\n');
}

/**
 * An annex to paste into a dossier after running the command-line tools locally: what was executed, what it
 * returned, and where the raw output was written. The site never sees any of this — the CLI writes it next to
 * the output files it captured.
 *
 * @param {{ title?: string, generated?: string, shell?: string, results?: any[] }} data
 */
export function resultsAnnex({ title, generated, shell, results = [] } = {}) {
  const when = generated ?? new Date().toISOString().slice(0, 10);
  const count = (status) => results.filter((r) => r.status === status).length;
  const lines = [
    `# ${cell(title) || 'Untitled investigation'} — local run annex`,
    '',
    `Run on the investigator's own machine on ${when}${shell ? ` with ${cell(shell)}` : ''}. These commands were`,
    'executed locally, not by osint-hub: the site never runs a tool and never sees the output. Raw output from each',
    'command is saved beside this file.',
    '',
    `- ${results.length} command${results.length === 1 ? '' : 's'}: ${count('ok')} exited cleanly, ${count('failed')} failed, ${count('skipped')} skipped`,
    '',
  ];

  if (!results.length) {
    lines.push('_No command-line tool in the plan could take these values._');
  } else {
    lines.push('| Identifier | Tool | Result | Exit | Output |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const r of results) {
      const verdict = r.status === 'ok' ? 'ran' : r.status === 'failed' ? 'failed' : 'skipped';
      lines.push(`| ${cell(r.value)} | ${cell(r.name)} | ${verdict}${r.note ? ` (${cell(r.note)})` : ''} | ${cell(r.exitCode ?? '—')} | ${cell(r.file ?? '—')} |`);
    }
    lines.push('');
    lines.push('A clean exit code means the tool ran, not that it found anything. Read the output before drawing a');
    lines.push('conclusion, and treat anything it returned as a lead to verify.');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------
// The single-file report
//
// Everything the CLI collected — the plan, what ran, what was fetched — in one self-contained HTML file. Tool
// output is untrusted text, so every value that reaches the document is escaped here and nowhere else.

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** A block of raw output, escaped. Tool output is long, so it is a details element; `open` shows it straight away. */
const raw = (text, label = 'raw output', open = false) =>
  text ? `<details${open ? ' open' : ''}><summary>${esc(label)}</summary><pre>${esc(text)}</pre></details>` : '';

const RESULT_LABEL = {
  ok: 'ran',
  failed: 'failed',
  skipped: 'skipped',
  blocked: 'blocked',
  empty: 'no readable text',
  'needs-js': 'needs a browser',
  error: 'error',
};

/** Why a service has to be queried by a person rather than by a request. */
const MANUAL_LABEL = {
  captcha: 'answers only after a captcha',
  'post-form': 'answers only a submitted form',
  'api-key': 'needs an API key',
  login: 'needs a logged-in session',
  interactive: 'is an interactive console',
};

/** The to-do list: services no request can get an answer from, with the link to do them by hand. */
function manualList(rows) {
  return `<ul class="manual">${rows
    .map(
      (r) =>
        `<li>${r.link ? `<a href="${esc(r.link)}" rel="noopener noreferrer">${esc(r.name)}</a>` : esc(r.name)} — ${esc(
          MANUAL_LABEL[r.manual] ?? r.manual,
        )}${r.account ? ' <span class="why">you sign in yourself</span>' : ''}${r.cost && r.cost !== 'free' ? ` <span class="why">${esc(r.cost)}</span>` : ''}${
          r.sensitive ? ' <span class="warn">notice</span>' : ''
        }</li>`,
    )
    .join('')}</ul>`;
}

function runsTable(runs) {
  return `<table><thead><tr><th>Tool</th><th>Ran</th><th>Exit</th><th>What it printed</th></tr></thead><tbody>${runs
    .map((r) => {
      // The output is the point of the report, so it is shown open rather than behind a click. Anything trimmed
      // points at the file on disk that still holds all of it.
      const body = r.output
        ? raw(r.output, r.truncated ? `output (trimmed — full text in ${r.file})` : 'output', true)
        : esc(r.file ? `(saved to ${r.file})` : 'nothing captured');
      const when = r.ms ? ` <span class="why">${(r.ms / 1000).toFixed(1)}s</span>` : '';
      return (
        `<tr><td>${esc(r.name)}</td><td>${esc(RESULT_LABEL[r.status] ?? r.status)}${r.note ? ` <span class="why">${esc(r.note)}</span>` : ''}${when}</td>` +
        `<td>${esc(r.exitCode ?? '—')}</td><td>${body}</td></tr>`
      );
    })
    .join('')}</tbody></table>`;
}

function fetchesTable(fetches) {
  return `<table><thead><tr><th>Tool</th><th>Result</th><th>Page title</th><th>Text found</th></tr></thead><tbody>${fetches
    .map(
      (f) =>
        `<tr><td>${f.link ? `<a href="${esc(f.link)}" rel="noopener noreferrer">${esc(f.name)}</a>` : esc(f.name)}</td>` +
        `<td>${esc(RESULT_LABEL[f.status] ?? f.status)}${f.http ? ` <span class="why">HTTP ${esc(f.http)}</span>` : ''}</td>` +
        `<td>${esc(oneLine(f.title) || '—')}</td><td>${raw(f.excerpt, 'text found on the page', true)}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function findingsList(findings) {
  if (!findings?.length) return '<p class="muted">Nothing recorded yet.</p>';
  return `<ul class="findings">${findings
    .map((f) => {
      const status = FINDING_STATUS[f.status] ?? FINDING_STATUS.todo;
      return `<li><strong>${esc(f.name)}</strong> — ${esc(status.label)}${f.note ? `: ${esc(f.note)}` : ''}${
        f.link ? ` <a href="${esc(f.link)}" rel="noopener noreferrer">open</a>` : ''
      }</li>`;
    })
    .join('')}</ul>`;
}

/** Pages rendered in a real browser: the readable text a plain request cannot get, plus the screenshot. */
function rendersTable(renders) {
  return `<table><thead><tr><th>Tool</th><th>Result</th><th>Page title</th><th>Visible text</th><th>Screenshot</th></tr></thead><tbody>${renders
    .map(
      (r) =>
        `<tr><td>${r.link ? `<a href="${esc(r.link)}" rel="noopener noreferrer">${esc(r.name)}</a>` : esc(r.name)}</td>` +
        `<td>${esc(RESULT_LABEL[r.status] ?? r.status)}${r.note ? ` <span class="why">${esc(r.note)}</span>` : ''}</td>` +
        `<td>${esc(oneLine(r.title) || '—')}</td><td>${raw(r.excerpt, 'text rendered on the page', true)}</td>` +
        `<td>${r.screenshot ? `<a href="${esc(r.screenshot)}">image</a>` : '—'}${r.dom ? ` · <a href="${esc(r.dom)}">markup</a>` : ''}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function toolsTable(rows) {
  if (!rows?.length) return '<p class="muted">No tool in the directory takes this type.</p>';
  return `<table><thead><tr><th>Tool</th><th>What it can do</th><th>Flags</th></tr></thead><tbody>${rows
    .map((r) => {
      const flags = [!r.passive && 'active', r.account && 'account', r.cost !== 'free' && r.cost, r.sensitive && 'notice', r.status === 'down' && 'down']
        .filter(Boolean)
        .map((f) => `<span class="flag">${esc(f)}</span>`)
        .join(' ');
      const action =
        r.kind === 'link' && r.link
          ? `<a href="${esc(r.link)}" rel="noopener noreferrer">search link</a>`
          : r.command
            ? `<code>${esc(r.command)}</code>`
            : `<a href="https://osinthub.pages.dev/tools/${esc(r.slug)}" rel="noopener noreferrer">its page</a>`;
      return `<tr><td>${esc(r.name)}</td><td>${action}</td><td>${flags}</td></tr>`;
    })
    .join('')}</tbody></table>`;
}

/**
 * One self-contained HTML file for a case: the plan, every capable tool, what the CLI ran, what it fetched locally,
 * and what the investigator recorded. No external assets, so it opens offline and can be printed or attached.
 *
 * @param {{ title?: string, generated?: string, notes?: string, safe?: boolean, sections?: any[] }} data
 */
export function reportHTML({ title, generated, notes, safe = false, sections = [] } = {}) {
  const when = generated ?? new Date().toISOString().slice(0, 10);
  const runs = sections.flatMap((s) => s.runs ?? []);
  const fetches = sections.flatMap((s) => s.fetches ?? []);
  const renders = sections.flatMap((s) => s.renders ?? []);
  const toolCount = sections.reduce((n, s) => n + (s.rows?.length ?? 0), 0);
  const body = sections
    .map((section) => {
      const summary = section.summary ?? summariseRows(section.rows ?? []);
      return `<section>
  <h2>${esc(section.value)}</h2>
  <p class="meta">${esc(section.type)}${section.via ? ` · derived from ${esc(section.via)}${section.guess ? ' (candidate)' : ''}` : ''}${
    section.note ? ` · ${esc(section.note)}` : ''
  }</p>
  <p class="meta">${summary.total} capable tools · ${summary.passive} passive · ${summary.links} with a search link · ${summary.commands} runnable on your machine · ${summary.sensitive} with a responsible-use notice</p>
  ${section.runs?.length ? `<h3>Ran on your machine</h3>${runsTable(section.runs)}` : ''}
  ${section.fetches?.length ? `<h3>Fetched from the web</h3>${fetchesTable(section.fetches)}` : ''}
  ${section.renders?.length ? `<h3>Rendered in a browser</h3>${rendersTable(section.renders)}` : ''}
  ${section.manual?.length ? `<h3>Do these by hand</h3>${manualList(section.manual)}` : ''}
  <h3>Every capable tool</h3>
  ${toolsTable(section.rows)}
  <h3>Findings</h3>
  ${findingsList(section.findings)}
</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title) || 'Untitled investigation'} — osint-hub case report</title>
<style>
:root{color-scheme:light dark}
body{font:15px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif;max-width:1100px;margin:0 auto;padding:24px;color:#16222a;background:#fbfdfe}
h1{margin:0 0 4px;font-size:1.6rem}
h2{margin:2rem 0 .3rem;font-size:1.2rem;border-top:1px solid #d7e3e8;padding-top:1rem}
h3{margin:1.2rem 0 .4rem;font-size:.95rem;text-transform:uppercase;letter-spacing:.06em;color:#5b7280}
.meta{color:#5b7280;font-size:.9rem;margin:.2rem 0}
.muted{color:#7b8f9a}
table{border-collapse:collapse;width:100%;margin:.3rem 0 1rem;font-size:.9rem}
th,td{border-bottom:1px solid #e3edf1;padding:6px 8px;text-align:left;vertical-align:top}
th{color:#5b7280;font-weight:600}
code,pre{font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:.82rem}
pre{background:#f2f7f9;border:1px solid #e0eaee;border-radius:6px;padding:10px;overflow:auto;max-height:420px;white-space:pre-wrap}
details{margin:.2rem 0}
summary{cursor:pointer;color:#166b80}
.flag{display:inline-block;border:1px solid #cfe0e6;border-radius:999px;padding:0 6px;font-size:.75rem;color:#5b7280;margin-right:4px}
.why{color:#7b8f9a;font-size:.8rem}
.findings{margin:.3rem 0 1rem;padding-left:1.1rem}
.banner{background:#f2f7f9;border:1px solid #dbe8ec;border-radius:8px;padding:12px 14px;font-size:.9rem;color:#3f5560}
footer{margin-top:2rem;border-top:1px solid #d7e3e8;padding-top:1rem;color:#5b7280;font-size:.85rem}
@media print{body{background:#fff}}
</style></head><body>
<h1>${esc(title) || 'Untitled investigation'}</h1>
<p class="meta">Case report compiled ${esc(when)} · ${sections.length} identifier${sections.length === 1 ? '' : 's'} · ${toolCount} capable tools · ${runs.length} command${runs.length === 1 ? '' : 's'} run · ${fetches.length} page${fetches.length === 1 ? '' : 's'} fetched · ${renders.length} page${renders.length === 1 ? '' : 's'} rendered</p>
<p class="banner">Assembled on the investigator's own machine. osint-hub planned it and stores nothing; the commands ran
and the pages were fetched locally, from your connection, and are attributed to you. A tool returning results is not
evidence — verify before acting.${safe ? ' <strong>Safe mode was on</strong>, so nothing that contacts the target or needs an account was included.' : ''}</p>
${body}
${notes && notes.trim() ? `<section><h2>Notes</h2><p>${esc(notes.trim()).replace(/\n/g, '<br>')}</p></section>` : ''}
<footer>Use these tools lawfully, and only on targets you have a legitimate reason to investigate. Every capable tool is listed, including ones this run did not touch.</footer>
</body></html>`;
}

