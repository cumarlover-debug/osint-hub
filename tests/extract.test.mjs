// The agent's core is two pure functions: reading findings out of tool output, and folding them into a profile.
// Both are testable without a network, which is the point of keeping them separate from the runners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFindings, redactSecrets, summariseFindings, maskHash } from '../shared/extract.mjs';
import { emptyProfile, addFindings, profileCounts, profileByKind, toolsRunFor, pivotCandidates, dossierMarkdown } from '../shared/profile.mjs';

test('redacts anything that would be a working credential', () => {
  assert.equal(redactSecrets('password: hunter2'), 'password: [redacted]');
  assert.equal(redactSecrets('api_key = sk-live-9f2'), 'api_key: [redacted]');
  // A combolist line keeps the address so the finding is still usable, and loses the secret.
  assert.equal(redactSecrets('someone@example.com:SuperSecret123'), 'someone@example.com:[redacted]');
  assert.match(redactSecrets('hash 5baa61e4c9b93f3f0682250b6cf8331b7ee68fd8'), /5baa61e4…\(40 hex chars\)/);
  assert.equal(maskHash('a'.repeat(64)), `${'a'.repeat(8)}…(64 hex chars)`);
});

test('reads found accounts from a marked line, and ignores the ones that were not found', () => {
  const text = [
    '[+] GitHub: https://github.com/shiineslife',
    '[-] Twitter: not found',
    '[+] Steam: https://steamcommunity.com/id/shiineslife',
  ].join('\n');
  const found = extractFindings({ slug: 'maigret', text, value: 'shiineslife' });
  const accounts = found.filter((f) => f.kind === 'account').map((f) => f.value);
  assert.deepEqual(accounts, ['https://github.com/shiineslife', 'https://steamcommunity.com/id/shiineslife']);
  assert.ok(!found.some((f) => f.value.includes('twitter')), 'a checked-but-absent site is not a finding');
  // The account URL is the account: it is not also reported as a page.
  assert.equal(found.filter((f) => f.kind === 'url').length, 0);
  assert.equal(found[0].confidence, 'candidate');
  assert.equal(found[0].tool, 'maigret');
});

test('never returns the target itself as a finding', () => {
  const found = extractFindings({ slug: 'sherlock', text: 'target: shiineslife\n[+] site: https://example.com/shiineslife', value: 'shiineslife' });
  assert.ok(!found.some((f) => f.value === 'shiineslife'));
});

test('treats a breach line as an indication, with the credential already gone', () => {
  const text = 'someone@example.com:SuperSecret123 found in Adobe (2013)';
  const found = extractFindings({ slug: 'h8mail', text, value: 'root@example.org' });
  assert.ok(found.some((f) => f.kind === 'breach'));
  assert.ok(!JSON.stringify(found).includes('SuperSecret123'), 'the password must not survive extraction');
});

test('sweeps the generic shapes out of any output', () => {
  const text = 'contact ada@example.org or @ada on 8.8.8.8 see https://example.org/a and bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const kinds = new Set(extractFindings({ slug: 'some-tool', text, value: 'x' }).map((f) => f.kind));
  for (const kind of ['email', 'username', 'ip', 'url']) assert.ok(kinds.has(kind), `expected a ${kind} finding`);
});

test('deduplicates and caps what it returns', () => {
  const text = Array.from({ length: 500 }, (_, i) => `[+] site ${i}: https://example.com/u${i}`).join('\n');
  const found = extractFindings({ slug: 'sherlock', text, value: 'x' });
  assert.ok(found.length <= 400, 'output is capped so one enormous tool cannot flood the profile');
  assert.equal(new Set(found.map((f) => `${f.kind}:${f.value}`)).size, found.length, 'no duplicates');
  assert.equal(summariseFindings(found).total, found.length);
});

test('strips terminal colour codes so they cannot end up inside a value', () => {
  // Real tool output: h8mail prints addresses in colour, and the escape code used to be captured as part of the
  // address ("0msomeone@example.com").
  const coloured = '\u001b[96m  someone@example.com \u001b[0m found in breach data';
  const found = extractFindings({ slug: 'h8mail', text: coloured, value: 'other@example.org' });
  assert.deepEqual(found.filter((f) => f.kind === 'email').map((f) => f.value), ['someone@example.com']);
});

test('does not mistake an identifier for a phone number', () => {
  const found = extractFindings({ slug: 'some-tool', text: 'id 1360774040222168 and epoch 1759650000000', value: 'x' });
  assert.equal(found.filter((f) => f.kind === 'phone').length, 0, 'a bare run of digits is an identifier, not a number');
  const formatted = extractFindings({ slug: 'some-tool', text: 'call +60 11-2883 9650 or 020 7946 0958', value: 'x' });
  assert.ok(formatted.some((f) => f.kind === 'phone'), 'a formatted number still reads as one');
});

test('lifts the hostnames a certificate or DNS tool answers with', () => {
  // The answer to "what is under this domain" is the list of names, so they are the findings - and a subdomain found
  // here is what the next stage searches for.
  const text = ['*.example.com   example.com   SSL Corporation   7/30/2026', 'api.example.com   Let us Encrypt   1/2/2026', 'assets/logo.png'].join('\n');
  const found = extractFindings({ slug: 'certkit-ct-search', text, value: 'example.com' });
  const domains = found.filter((f) => f.kind === 'domain').map((f) => f.value);
  // The wildcard is kept because it says the certificate covers every subdomain, and the bare parent is not a
  // finding: it is the value being searched for.
  assert.deepEqual(domains, ['*.example.com', 'api.example.com']);
  assert.ok(!domains.some((d) => d.endsWith('.png')), 'an asset filename is not a host');
});

test('does not read a DNS tool\u2019s numeric columns as telephone numbers', () => {
  // dnstwist prints a table with numeric identifiers in it, and an earlier version turned every one into a phone lead.
  const text = ['10316817237   example.com   1.2.3.4', '103224182241   exxample.com   5.6.7.8'].join('\n');
  const found = extractFindings({ slug: 'dnstwist', text, value: 'example.com' });
  assert.equal(found.filter((f) => f.kind === 'phone').length, 0);
  const domains = found.filter((f) => f.kind === 'domain').map((f) => f.value);
  assert.ok(domains.includes('exxample.com'), 'the domains, which are the point, are still found');
});

test('folds findings into a profile, keeping every source', () => {
  const profile = emptyProfile('Test target', 'Written consent, 2026-10-05');
  addFindings(profile, { value: 'ada@example.org', valueType: 'email', slug: 'holehe', tool: 'Holehe', status: 'ok', findings: [{ kind: 'account', value: 'https://github.com/ada', evidence: '[+] github', tool: 'holehe' }] });
  addFindings(profile, { value: 'ada@example.org', valueType: 'email', slug: 'maigret', tool: 'Maigret', status: 'ok', findings: [{ kind: 'account', value: 'https://github.com/ada', evidence: '[+] GitHub', tool: 'maigret' }] });

  const groups = profileByKind(profile);
  assert.equal(groups.account.length, 1, 'the same account found twice is one entity');
  assert.equal(groups.account[0].sources.length, 2, 'and it keeps both sources');
  const counts = profileCounts(profile);
  assert.equal(counts.leads, 1);
  assert.equal(counts.toolsRun, 2);
});

test('records the runs that found nothing, so the same ground is not covered twice', () => {
  const profile = emptyProfile('Test target');
  addFindings(profile, { value: 'ada@example.org', valueType: 'email', slug: 'holehe', tool: 'Holehe', status: 'ok', findings: [] });
  assert.deepEqual([...toolsRunFor(profile, 'ada@example.org')], ['holehe']);
  assert.equal(profileCounts(profile).leads, 0);
});

test('offers findings as pivots, target first out', () => {
  const profile = emptyProfile('Test target');
  addFindings(profile, {
    value: 'ada@example.org',
    valueType: 'email',
    slug: 'holehe',
    tool: 'Holehe',
    findings: [
      { kind: 'username', value: 'ada', tool: 'holehe' },
      { kind: 'domain', value: 'ada.example', tool: 'holehe' },
    ],
  });
  addFindings(profile, { value: 'ada@example.org', valueType: 'email', slug: 'maigret', tool: 'Maigret', findings: [{ kind: 'username', value: 'ada', tool: 'maigret' }] });
  const pivots = pivotCandidates(profile);
  assert.deepEqual(pivots[0], { kind: 'username', value: 'ada', sources: 2, firstSeen: pivots[0].firstSeen });
  assert.ok(!pivots.some((p) => p.value === 'ada@example.org'), 'the target is not a pivot, it is the subject');
});

test('the dossier names its sources and never carries a credential', () => {
  const profile = emptyProfile('Test target', 'Client mandate, reference 4412');
  addFindings(profile, {
    value: 'ada@example.org',
    valueType: 'email',
    slug: 'h8mail',
    tool: 'h8mail',
    status: 'ok',
    findings: [
      { kind: 'breach', value: 'ada@example.org found in Adobe', evidence: 'ada@example.org:SuperSecret123 found in Adobe (2013)', tool: 'h8mail' },
      { kind: 'username', value: 'ada', evidence: '[+] github', tool: 'h8mail' },
    ],
  });
  const md = dossierMarkdown(profile, { gaps: ['Some Tool (ada@example.org) — not installed'], manual: [{ name: 'Dehashed', link: 'https://dehashed.example', why: 'needs an API key' }] });
  assert.match(md, /Client mandate, reference 4412/, 'the authority is carried into the report');
  assert.match(md, /candidate/, 'leads are labelled as candidates');
  assert.match(md, /h8mail/, 'the tool that found it is named');
  assert.match(md, /Do these by hand/);
  assert.match(md, /Dehashed/);
  assert.ok(!md.includes('SuperSecret123'), 'a credential must never reach the report');
  assert.match(md, /\[redacted\]/);
});
