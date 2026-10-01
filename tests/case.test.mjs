// Tests for shared/case.mjs: the pivot derivation, the capability map and the dossier format behind /case.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  derivePivots,
  capabilityRows,
  summariseRows,
  groupByCategory,
  isSensitive,
  dossierMarkdown,
  resultsAnnex,
  reportHTML,
  FINDING_STATUS,
  sanitiseCaseState,
  emptyCaseState,
  newCaseFile,
  activeCase,
  uid,
} from '../shared/case.mjs';

const tools = [
  {
    slug: 'sherlock',
    name: 'Sherlock',
    category: 'social-media',
    inputs: ['username'],
    passive: true,
    account_required: false,
    cost: 'free',
    query_template: 'https://sherlock.example/?u={query}',
  },
  {
    slug: 'holehe',
    name: 'Holehe',
    category: 'email',
    inputs: ['email'],
    passive: true,
    account_required: false,
    cost: 'free',
    command_template: { email: 'holehe {query}' },
    install: 'pipx install holehe',
  },
  {
    slug: 'hunter',
    name: 'Hunter',
    category: 'email',
    inputs: ['email', 'domain'],
    passive: true,
    account_required: true,
    cost: 'freemium',
    query_template: { email: 'https://hunter.example/?q={query}', domain: 'https://hunter.example/?d={query}' },
  },
  {
    slug: 'etherscan',
    name: 'Etherscan',
    category: 'crypto',
    inputs: ['crypto_address'],
    passive: true,
    account_required: false,
    cost: 'free',
    query_template: { crypto_address: { url: 'https://etherscan.example/address/{query}', match: 'eth' } },
  },
  {
    slug: 'active-scanner',
    name: 'Active Scanner',
    category: 'domain',
    inputs: ['domain'],
    passive: false,
    account_required: false,
    cost: 'free',
  },
  {
    slug: 'spokeo',
    name: 'Spokeo',
    category: 'people',
    inputs: ['name', 'phone', 'email'],
    passive: true,
    account_required: false,
    manual: 'captcha',
    cost: 'paid',
  },
  {
    slug: 'hashteam',
    name: 'Hash Team',
    category: 'metadata',
    inputs: ['hash'],
    passive: true,
    account_required: false,
    cost: 'free',
    tags: ['leak-data'],
  },
];

describe('derivePivots', () => {
  it('splits an email into its username and domain', () => {
    assert.deepEqual(derivePivots('someone@example.com'), [
      { value: 'someone', type: 'username', via: 'email', guess: false },
      { value: 'example.com', type: 'domain', via: 'email', guess: false },
    ]);
  });

  it('does not invent a username from a role address', () => {
    // A local part with characters that are not username-shaped is left alone.
    assert.deepEqual(derivePivots('first+tag@example.com').map((p) => p.value), ['example.com']);
  });

  it('takes the host out of a URL', () => {
    assert.deepEqual(derivePivots('https://www.example.com/a/b?c=1'), [
      { value: 'example.com', type: 'domain', via: 'url', guess: false },
    ]);
  });

  it('offers the https form of a bare domain', () => {
    assert.deepEqual(derivePivots('example.com'), [{ value: 'https://example.com', type: 'url', via: 'domain', guess: false }]);
  });

  it('strips a phone number down to digits, keeping the leading +', () => {
    assert.deepEqual(derivePivots('+1 555 010 9999'), [{ value: '+15550109999', type: 'phone', via: 'phone', guess: false }]);
    // detect() only treats a leading digit (or +) as a phone number, and derivation follows detection.
    assert.deepEqual(derivePivots('555-010-9999'), [{ value: '5550109999', type: 'phone', via: 'phone', guess: false }]);
  });

  it('leaves a phone number that is already normalised alone', () => {
    assert.deepEqual(derivePivots('+15550109999'), []);
  });

  it('derives nothing from a value with no useful parts', () => {
    assert.deepEqual(derivePivots('d41d8cd98f00b204e9800998ecf8427e'), []);
    assert.deepEqual(derivePivots(''), []);
    assert.deepEqual(derivePivots('   '), []);
  });

  it('does not propose username candidates unless asked', () => {
    assert.deepEqual(derivePivots('John Smith'), []);
  });

  it('proposes candidate usernames from a name only when asked, marked as guesses', () => {
    const pivots = derivePivots('John Smith', { candidates: true });
    assert.deepEqual(pivots.map((p) => p.value), ['johnsmith', 'john.smith', 'jsmith', 'smithj']);
    assert.ok(pivots.every((p) => p.type === 'username' && p.guess === true && p.via === 'name'));
  });

  it('never returns the value it was given', () => {
    for (const value of ['example.com', 'someone@example.com', 'https://example.com']) {
      assert.ok(!derivePivots(value).some((p) => p.value === value), value);
    }
  });
});

describe('capabilityRows', () => {
  it('lists every tool that takes the type, in usable order', () => {
    const rows = capabilityRows(tools, 'email', 'someone@example.com');
    assert.deepEqual(rows.map((r) => r.slug), ['holehe', 'hunter', 'spokeo']);
  });

  it('marks a tool with a matching search URL as a link', () => {
    const [holehe, hunter] = capabilityRows(tools, 'email', 'someone@example.com');
    assert.equal(holehe.kind, 'command');
    assert.equal(holehe.command, 'holehe someone@example.com');
    assert.equal(holehe.install, 'pipx install holehe');
    assert.equal(hunter.kind, 'link');
    assert.equal(hunter.link, 'https://hunter.example/?q=someone%40example.com');
  });

  it('marks a tool with neither a template nor a command as page-only', () => {
    const spokeo = capabilityRows(tools, 'email', 'someone@example.com').at(-1);
    assert.equal(spokeo.kind, 'page');
    assert.equal(spokeo.link, undefined);
  });

  it('keeps a tool whose matcher does not fit, unusable and last, with the reason', () => {
    const rows = capabilityRows(tools, 'crypto_address', 'not-an-address');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].usable, false);
    assert.equal(rows[0].why, 'eth');
    assert.equal(rows[0].link, undefined);
  });

  it('quotes the value in a command for the chosen shell', () => {
    const [row] = capabilityRows(tools, 'email', "o'brien@example.com", { shell: 'powershell' });
    assert.equal(row.command, "holehe 'o''brien@example.com'");
  });

  it('never builds a command from a value that cannot be quoted safely', () => {
    const [row] = capabilityRows(tools, 'email', '--help');
    assert.equal(row.command, undefined);
    assert.equal(row.kind, 'command');
  });

  it('leaves out active and account-only tools in safe mode', () => {
    const safe = capabilityRows(tools, 'domain', 'example.com', { safe: true });
    assert.deepEqual(safe.map((r) => r.slug), []);
    const normal = capabilityRows(tools, 'domain', 'example.com');
    // Passive before active, as everywhere else on the site.
    assert.deepEqual(normal.map((r) => r.slug), ['hunter', 'active-scanner']);
  });

  it('flags sensitive tools so the report can say so', () => {
    const rows = capabilityRows(tools, 'email', 'someone@example.com');
    assert.equal(rows.find((r) => r.slug === 'spokeo').sensitive, true); // people category
    const [hashRow] = capabilityRows(tools, 'hash', 'abc');
    assert.equal(hashRow.sensitive, true); // leak-data tag
  });

  it('ignores tools that do not take the type', () => {
    assert.deepEqual(capabilityRows(tools, 'vessel', 'IMO 9074729'), []);
  });

  it('carries the reason a service has to be used by hand', () => {
    const [row] = capabilityRows(tools, 'email', 'someone@example.com').filter((r) => r.slug === 'spokeo');
    assert.equal(row.manual, 'captcha');
  });

  it('keeps a by-hand service visible in safe mode even when it wants an account', () => {
    // Snusbase and Dehashed are account-based, which safe mode hides. Marked by hand, they are listed instead,
    // because the investigator is the one who logs in.
    const breach = {
      slug: 'snusbase',
      name: 'Snusbase',
      category: 'breach',
      inputs: ['email'],
      passive: true,
      account_required: true,
      manual: 'api-key',
      cost: 'paid',
    };
    const rows = capabilityRows([...tools, breach], 'email', 'someone@example.com', { safe: true });
    assert.ok(rows.some((r) => r.slug === 'snusbase'));
    // Hunter is account-based without being marked, so safe mode still hides it.
    assert.ok(!rows.some((r) => r.slug === 'hunter'));
  });

  it('lists the by-hand services in the report, with their link and reason', () => {
    const manual = capabilityRows(tools, 'email', 'someone@example.com').filter((r) => r.manual);
    const html = reportHTML({ sections: [{ value: 'someone@example.com', type: 'Email address', rows: [], manual }] });
    assert.match(html, /Do these by hand/);
    assert.match(html, /answers only after a captcha/);
  });
});

describe('summariseRows', () => {
  it('counts what a plan offers', () => {
    const summary = summariseRows(capabilityRows(tools, 'email', 'someone@example.com'));
    assert.deepEqual(summary, {
      total: 3,
      passive: 3,
      active: 0,
      account: 1,
      paid: 1,
      links: 1,
      commands: 1,
      pages: 1,
      sensitive: 1,
    });
  });
});

describe('groupByCategory', () => {
  it('groups rows and follows the taxonomy order', () => {
    const rows = capabilityRows(tools, 'email', 'someone@example.com');
    const groups = groupByCategory(rows, ['email', 'social-media', 'people']);
    assert.deepEqual(groups.map((g) => g.category), ['email', 'people']);
    assert.deepEqual(groups[0].rows.map((r) => r.slug), ['holehe', 'hunter']);
  });

  it('puts a category missing from the order last instead of dropping it', () => {
    const groups = groupByCategory(capabilityRows(tools, 'hash', 'abc'), ['email']);
    assert.deepEqual(groups.map((g) => g.category), ['metadata']);
  });
});

describe('isSensitive', () => {
  it('is true for people search and for the sensitive tags', () => {
    assert.equal(isSensitive(tools.find((t) => t.slug === 'spokeo')), true);
    assert.equal(isSensitive(tools.find((t) => t.slug === 'hashteam')), true);
    assert.equal(isSensitive(tools.find((t) => t.slug === 'sherlock')), false);
    assert.equal(isSensitive({ category: 'search', tags: ['personal-data'] }), true);
  });
});

describe('dossierMarkdown', () => {
  const sections = [
    {
      value: 'someone@example.com',
      type: 'email',
      rows: capabilityRows(tools, 'email', 'someone@example.com'),
      findings: [
        { name: 'Hunter', status: 'found', note: 'confirmed the employer', link: 'https://hunter.example/?q=someone%40example.com' },
        { name: 'Holehe', status: 'ran' },
      ],
    },
  ];

  it('writes a header, a summary and one section per identifier', () => {
    const md = dossierMarkdown({ title: 'Case 42', generated: '2026-09-30', sections });
    assert.match(md, /^# Case 42\n/);
    assert.match(md, /Compiled 2026-09-30/);
    assert.match(md, /no tool was queried automatically/);
    assert.match(md, /- 1 identifier\n/);
    assert.match(md, /Findings recorded: 2 \(1 with something found/);
    assert.match(md, /## someone@example\.com/);
    assert.match(md, /Capable tools: 3 \(3 passive, 1 with a direct search link, 1 runnable on your machine\)/);
  });

  it('records each finding with its status and link', () => {
    const md = dossierMarkdown({ sections });
    assert.match(md, /- \[x\] \*\*Hunter\*\* — Found something: confirmed the employer/);
    assert.match(md, /- \[~\] \*\*Holehe\*\* — Ran, nothing useful/);
  });

  it('says when a section has nothing recorded rather than implying a result', () => {
    const md = dossierMarkdown({ sections: [{ value: 'x@y.com', type: 'email', rows: [], findings: [] }] });
    assert.match(md, /_Nothing recorded yet\._/);
  });

  it('marks a derived value and its candidate status', () => {
    const md = dossierMarkdown({ sections: [{ value: 'jsmith', type: 'username', via: 'John Smith', guess: true, rows: [], findings: [] }] });
    assert.match(md, /- Derived from: John Smith \(candidate\)/);
  });

  it('notes when safe mode shaped the plan', () => {
    assert.match(dossierMarkdown({ safe: true, sections: [] }), /Safe mode was on/);
    assert.doesNotMatch(dossierMarkdown({ safe: false, sections: [] }), /Safe mode was on/);
  });

  it('falls back to an untitled report and always carries the lawful-use line', () => {
    const md = dossierMarkdown({});
    assert.match(md, /^# Untitled investigation/);
    assert.match(md, /Use these tools lawfully/);
  });

  it('keeps the investigator\u2019s notes verbatim', () => {
    const md = dossierMarkdown({ notes: 'Asked the client before touching anything.', sections: [] });
    assert.match(md, /## Notes\n\nAsked the client before touching anything\./);
  });

  it('escapes a pipe so a table-breaking value cannot corrupt the report', () => {
    assert.match(dossierMarkdown({ title: 'a | b', sections: [] }), /^# a \\\| b/);
  });
});

describe('FINDING_STATUS', () => {
  it('gives every status a mark and a label', () => {
    for (const [key, value] of Object.entries(FINDING_STATUS)) {
      assert.ok(value.label && value.mark, `${key} needs a label and a mark`);
      assert.equal(typeof value.label, 'string');
    }
  });
});

describe('resultsAnnex', () => {
  const results = [
    { value: 'someone@example.com', type: 'email', slug: 'holehe', name: 'Holehe', command: 'holehe someone@example.com', status: 'ok', exitCode: 0, ms: 1200, file: 'runs/1-holehe.txt' },
    { value: '+1 555 010 9999', type: 'phone', slug: 'phoneinfoga', name: 'PhoneInfoga', command: 'phoneinfoga scan -n \'+1 555 010 9999\'', status: 'failed', exitCode: 127, note: 'command not found', file: 'runs/2-phoneinfoga.txt' },
    { value: 'example.com', type: 'domain', slug: 'dnstwist', name: 'dnstwist', command: 'dnstwist --registered example.com', status: 'skipped' },
  ];

  it('summarises what happened', () => {
    const md = resultsAnnex({ title: 'Case 7', generated: '2026-09-30', shell: 'bash / zsh', results });
    assert.match(md, /^# Case 7 — local run annex/);
    assert.match(md, /Run on the investigator's own machine on 2026-09-30 with bash \/ zsh/);
    assert.match(md, /- 3 commands: 1 exited cleanly, 1 failed, 1 skipped/);
  });

  it('says the site did not run anything', () => {
    const md = resultsAnnex({ results });
    assert.match(md, /the site never runs a tool and never sees the output/);
    assert.match(md, /A clean exit code means the tool ran, not that it found anything/);
  });

  it('lists each command with its verdict, exit code and output file', () => {
    const md = resultsAnnex({ results });
    assert.match(md, /\| someone@example\.com \| Holehe \| ran \| 0 \| runs\/1-holehe\.txt \|/);
    assert.match(md, /\| \+1 555 010 9999 \| PhoneInfoga \| failed \(command not found\) \| 127 \|/);
    assert.match(md, /\| example\.com \| dnstwist \| skipped \| — \| — \|/);
  });

  it('says so when nothing could be run, rather than showing an empty table', () => {
    const md = resultsAnnex({ results: [] });
    assert.match(md, /_No command-line tool in the plan could take these values\._/);
    assert.doesNotMatch(md, /\| Identifier \|/);
  });

  it('escapes a pipe in a value so the table survives', () => {
    const md = resultsAnnex({ results: [{ value: 'a|b', name: 'Tool', status: 'ok', exitCode: 0 }] });
    assert.match(md, /\| a\\\|b \| Tool \|/);
  });
});

describe('reportHTML', () => {
  const sections = [
    {
      value: 'someone@example.com',
      type: 'Email address',
      rows: capabilityRows(tools, 'email', 'someone@example.com'),
      runs: [{ value: 'someone@example.com', name: 'Holehe', status: 'ok', exitCode: 0, output: '[+] github.com\n[-] twitter.com' }],
      fetches: [{ name: 'Hunter', link: 'https://hunter.example/?q=a%40b.com', status: 'ok', http: 200, title: 'Hunter results', excerpt: 'Found 3 emails' }],
      findings: [{ name: 'Holehe', status: 'found', note: 'account on github', link: 'https://github.com/' }],
    },
  ];

  it('is a complete standalone document', () => {
    const html = reportHTML({ title: 'Case 42', generated: '2026-10-01', sections });
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<title>Case 42 — osint-hub case report<\/title>/);
    assert.match(html, /<\/html>$/);
    assert.doesNotMatch(html, /<script/i, 'no scripts: the report must not run anything');
  });

  it('summarises what was collected', () => {
    const html = reportHTML({ title: 'Case 42', generated: '2026-10-01', sections });
    assert.match(html, /Case report compiled 2026-10-01/);
    assert.match(html, /1 identifier/);
    assert.match(html, /1 command run/);
    assert.match(html, /1 page fetched/);
  });

  it('shows every capable tool, not only the ones that ran', () => {
    const html = reportHTML({ sections });
    assert.match(html, /Every capable tool/);
    assert.match(html, /Holehe/);
    assert.match(html, /Hunter/);
    assert.match(html, /Spokeo/, 'a tool with no command and no link is still listed');
  });

  it('includes the commands run and the pages fetched with their text', () => {
    const html = reportHTML({ sections });
    assert.match(html, /Ran on your machine/);
    assert.match(html, /\[\+\] github\.com/);
    assert.match(html, /Fetched from the web/);
    assert.match(html, /Found 3 emails/);
    assert.match(html, /HTTP 200/);
  });

  it('shows what each tool printed, open, rather than a path to go and open', () => {
    const html = reportHTML({ sections });
    assert.match(html, /<details open><summary>output<\/summary><pre>\[\+\] github\.com/);
    assert.doesNotMatch(html, /saved to/, 'the old behaviour printed a file path instead of the output');
  });

  it('says where the untrimmed output lives when a result was trimmed', () => {
    const html = reportHTML({
      sections: [{ value: 'x', type: 'Username', rows: [], runs: [{ name: 'Maigret', status: 'ok', exitCode: 0, output: 'lots', truncated: true, file: 'runs/01-maigret.txt' }] }],
    });
    assert.match(html, /output \(trimmed — full text in runs\/01-maigret\.txt\)/);
  });

  it('records the findings', () => {
    assert.match(reportHTML({ sections }), /<strong>Holehe<\/strong> — Found something: account on github/);
  });

  it('says when nothing was recorded instead of implying a result', () => {
    assert.match(reportHTML({ sections: [{ value: 'x@y.com', type: 'Email address', rows: [], findings: [] }] }), /Nothing recorded yet\./);
  });

  it('escapes tool output, so a page cannot inject markup into the report', () => {
    const html = reportHTML({
      title: '<img src=x onerror=alert(1)>',
      notes: 'quote " and <b>bold</b>',
      sections: [
        {
          value: '<script>alert(1)</script>',
          type: 'Keyword / topic',
          rows: [],
          runs: [{ name: 'Evil', status: 'ok', exitCode: 0, output: '<script>alert(2)</script>' }],
          fetches: [{ name: 'Evil2', status: 'ok', title: '</title><script>alert(3)</script>', excerpt: '<iframe src=//evil>' }],
        },
      ],
    });
    assert.equal(html.includes('<script>'), false, 'no raw script tag may survive');
    assert.equal(html.includes('onerror=alert(1)>'), false, 'attribute injection must be escaped');
    assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
    assert.match(html, /&lt;iframe src=\/\/evil&gt;/);
    assert.match(html, /quote &quot; and &lt;b&gt;bold&lt;\/b&gt;/);
  });

  it('shows a section for pages rendered in a browser, with the screenshot', () => {
    const html = reportHTML({
      sections: [
        {
          value: 'example.com',
          type: 'Domain',
          rows: [],
          renders: [
            { name: 'DNSViz', link: 'https://dnsviz.net/d/example.com/dnssec/', status: 'ok', title: 'example.com | DNSViz', excerpt: 'Delegation: com', screenshot: 'browser/01-dnsviz.png' },
            { name: 'Blocked One', status: 'blocked', title: 'Just a moment...' },
          ],
        },
      ],
    });
    assert.match(html, /Rendered in a browser/);
    assert.match(html, /Delegation: com/);
    assert.match(html, /href="browser\/01-dnsviz\.png"/);
    assert.match(html, /Just a moment\.\.\./);
    assert.match(html, /2 pages rendered/);
  });

  it('escapes a rendered page\u2019s title and text', () => {
    const html = reportHTML({
      sections: [{ value: 'x', type: 'Keyword / topic', rows: [], renders: [{ name: 'Evil', status: 'ok', title: '<script>bad()</script>', excerpt: '<img onerror=alert(1)>' }] }],
    });
    assert.equal(html.includes('<script>bad()'), false);
    assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
  });

  it('flags safe mode in the banner', () => {
    assert.match(reportHTML({ safe: true, sections: [] }), /Safe mode was on/);
    assert.doesNotMatch(reportHTML({ safe: false, sections: [] }), /Safe mode was on/);
  });

  it('always carries the lawful-use footer and the no-evidence warning', () => {
    const html = reportHTML({ sections: [] });
    assert.match(html, /not\s+evidence — verify before acting/);
    assert.match(html, /Use these tools lawfully/);
  });

  it('keeps the investigator\u2019s notes', () => {
    assert.match(reportHTML({ notes: 'Authorised by the client.', sections: [] }), /Authorised by the client\./);
  });
});

describe('the planner never becomes an executor', () => {
  // The promise on the About page is that osint-hub plans a run and never queries anything for the visitor. That
  // holds only while the shared modules have no way to make a request, so it is checked here rather than trusted.
  const sources = ['../shared/case.mjs', '../shared/launcher.mjs'];

  it('has no network or shell access in the shared modules', () => {
    for (const path of sources) {
      const src = readFileSync(new URL(path, import.meta.url), 'utf8');
      for (const needle of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', "node:http", "node:https", 'child_process', 'require(']) {
        assert.ok(!src.includes(needle), `${path} must not contain ${needle}`);
      }
    }
  });

  it('keeps the sensitive-tag list in one place', () => {
    const src = readFileSync(new URL('../shared/case.mjs', import.meta.url), 'utf8');
    assert.match(src, /export const SENSITIVE_TAGS = \[/);
    for (const tag of ['face-recognition', 'personal-data', 'leak-data', 'covert-tracking', 'surveillance']) {
      assert.ok(src.includes(`'${tag}'`), `SENSITIVE_TAGS should include ${tag}`);
    }
  });
});

describe('the case model', () => {
  it('starts with one empty case that is the active one', () => {
    const state = emptyCaseState();
    assert.equal(state.cases.length, 1);
    assert.equal(state.activeId, state.cases[0].id);
    assert.deepEqual(state.cases[0].values, []);
    assert.deepEqual(state.cases[0].findings, []);
  });

  it('gives every case and value a distinct id', () => {
    const ids = new Set([newCaseFile().id, newCaseFile().id, uid(), uid(), uid()]);
    assert.equal(ids.size, 5);
  });

  it('finds the active case and falls back to the first', () => {
    const state = { schema: 1, activeId: 'nope', cases: [newCaseFile('A'), newCaseFile('B')] };
    assert.equal(activeCase(state).title, 'A');
    assert.equal(activeCase({ ...state, activeId: state.cases[1].id }).title, 'B');
  });
});

describe('sanitiseCaseState', () => {
  const valid = {
    schema: 1,
    activeId: 'c1',
    cases: [
      {
        id: 'c1',
        title: 'Case one',
        created: '2026-09-01',
        updated: '2026-09-02',
        notes: 'authorised',
        safe: true,
        values: [
          { id: 'v1', value: 'example.com', type: 'domain' },
          { id: 'v2', value: 'jsmith', type: 'username', via: 'John Smith', guess: true, note: 'candidate' },
        ],
        findings: [
          { valueId: 'v1', slug: 'shodan', status: 'found', note: 'open ports', at: '2026-09-02' },
          { valueId: 'gone', slug: 'shodan', status: 'ran', at: '2026-09-02' },
        ],
      },
    ],
  };

  it('leaves a real case alone', () => {
    const state = sanitiseCaseState(valid);
    assert.equal(state.cases[0].title, 'Case one');
    assert.equal(state.cases[0].safe, true);
    assert.deepEqual(state.cases[0].values.map((v) => v.id), ['v1', 'v2']);
    assert.equal(state.cases[0].findings.length, 1, 'the finding for a removed value is dropped');
    assert.equal(state.cases[0].findings[0].status, 'found');
  });

  it('falls back to an empty case for anything unusable', () => {
    for (const junk of [null, undefined, 'nope', 42, [], {}, { cases: 'nope' }, { cases: [null, 7] }]) {
      const state = sanitiseCaseState(junk);
      assert.equal(state.cases.length, 1, JSON.stringify(junk));
      assert.equal(state.activeId, state.cases[0].id);
    }
  });

  it('drops values with no value or no type', () => {
    const state = sanitiseCaseState({ cases: [{ id: 'c', values: [{ value: '', type: 'domain' }, { value: 'x' }, { value: 'y', type: 'domain' }] }] });
    assert.deepEqual(state.cases[0].values.map((v) => v.value), ['y']);
  });

  it('puts an unknown finding status back to "to do"', () => {
    const state = sanitiseCaseState({ cases: [{ id: 'c', values: [{ id: 'v', value: 'x', type: 'domain' }], findings: [{ valueId: 'v', slug: 's', status: 'banana' }] }] });
    assert.equal(state.cases[0].findings[0].status, 'todo');
  });

  it('only keeps the documented fields, so a hostile backup cannot inject them', () => {
    const state = sanitiseCaseState({
      cases: [{ id: 'c', title: { toString: 'x' }, safe: 'yes', values: [{ id: 'v', value: 'x', type: 'domain', onclick: 'alert(1)' }] }],
    });
    assert.equal(typeof state.cases[0].title, 'string');
    assert.equal(state.cases[0].safe, false);
    assert.equal('onclick' in state.cases[0].values[0], false);
  });

  it('replaces a duplicated or missing id, so findings can still be matched', () => {
    const state = sanitiseCaseState({ cases: [{ id: 'c', values: [{ value: 'a', type: 'domain' }, { value: 'b', type: 'domain' }] }] });
    const [a, b] = state.cases[0].values;
    assert.ok(a.id && b.id && a.id !== b.id);
  });

  it('points activeId at a case that exists', () => {
    const state = sanitiseCaseState({ activeId: 'gone', cases: [{ id: 'c1' }, { id: 'c2' }] });
    assert.equal(state.activeId, 'c1');
  });
});
