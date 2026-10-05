// Assigning work in your own words: what the sentence asks about, which identifiers it applies to, and which tools
// that comes to. The mapping has to be predictable, because a wrong guess spends an investigation's budget on the
// wrong family of tools and the investigator has no way to see why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchIntents, taskTargets, resolveTask, unplacedWords, taskProgress } from '../shared/tasks.mjs';

const tools = [
  { slug: 'sherlock', name: 'Sherlock', category: 'social-media', inputs: ['username'], type: 'cli', passive: true, account_required: false, command_template: 'sherlock {query}' },
  { slug: 'h8mail', name: 'h8mail', category: 'breach', inputs: ['email'], type: 'cli', passive: true, account_required: false, command_template: 'h8mail -t {query}' },
  { slug: 'crt-sh', name: 'crt.sh', category: 'domain', inputs: ['domain'], type: 'web', passive: true, account_required: false, query_template: 'https://crt.sh/?q={query}' },
  { slug: 'subfinder', name: 'Subfinder', category: 'domain', inputs: ['domain'], type: 'cli', passive: true, account_required: false, command_template: 'subfinder -d {query}' },
  { slug: 'shodan-search', name: 'Shodan', category: 'network', inputs: ['ip', 'domain'], type: 'web', passive: true, account_required: true, query_template: 'https://www.shodan.io/search?query={query}' },
  { slug: 'epieos', name: 'Epieos', category: 'email', inputs: ['email'], type: 'web', passive: true, account_required: false, manual: 'post-form' },
  { slug: 'whitepages', name: 'Whitepages', category: 'people', inputs: ['name', 'phone'], type: 'web', passive: true, account_required: false, manual: 'post-form' },
  { slug: 'flightradar', name: 'Flightradar24', category: 'transport', inputs: ['aircraft'], type: 'web', passive: true, account_required: false, query_template: 'https://www.flightradar24.com/data/aircraft/{query}' },
];
const taxonomy = {
  categories: { 'social-media': {}, breach: {}, domain: {}, network: {}, email: {}, people: {}, transport: {} },
  inputs: { username: {}, email: {}, domain: {}, ip: {} },
};
const values = [
  { id: 'v1', type: 'username', value: 'shiineslife' },
  { id: 'v2', type: 'email', value: 'ada@example.org' },
  { id: 'v3', type: 'domain', value: 'example.org' },
];
const resolve = (text) => resolveTask({ text, values, tools, taxonomy, order: Object.keys(taxonomy.categories) });

test('reads the family of work out of a sentence', () => {
  assert.deepEqual(matchIntents('find accounts for this username').map((i) => i.id), ['accounts']);
  assert.deepEqual(matchIntents('check if the email is in a breach').map((i) => i.id), ['breach']);
  assert.deepEqual(matchIntents('map the infrastructure of the domain').map((i) => i.id), ['infrastructure']);
  assert.deepEqual(matchIntents('who owns the company behind this').map((i) => i.id), ['business']);
  assert.deepEqual(matchIntents('reverse image search and exif').map((i) => i.id), ['media']);
});

test('a sentence about two things matches both, in the order they were written', () => {
  assert.deepEqual(matchIntents('check the breach and then find the accounts').map((i) => i.id), ['breach', 'accounts']);
});

test('a sentence it cannot place matches nothing, rather than falling back to something', () => {
  // The important case: guessing here would spend a budget on a family of tools nobody asked for.
  assert.deepEqual(matchIntents('do something clever with it'), []);
  const r = resolve('do something clever with it');
  assert.equal(r.matched, false);
  assert.equal(r.counts.tools, 0, 'an unmapped task proposes no work at all');
  assert.equal(r.unplaced, 'clever', 'the one word carrying meaning is what gets reported back');
});

test('applies to the identifier it names, and to the type it implies otherwise', () => {
  assert.deepEqual(taskTargets('check ada@example.org for breaches', values, matchIntents('check ada@example.org for breaches')).map((v) => v.value), ['ada@example.org']);
  const implied = resolve('check the email for breaches');
  assert.deepEqual(implied.values, ['ada@example.org'], 'the email intent picks the email, not every value');
});

test('a task with no target that fits still applies to the case', () => {
  const r = resolveTask({ text: 'protect the investigation with better opsec', values: [{ id: 'x', type: 'location', value: 'Kuala Lumpur' }], tools, taxonomy });
  assert.deepEqual(r.values, ['Kuala Lumpur']);
});

test('the task decides which tools are in scope', () => {
  const accounts = resolve('find accounts for shiineslife');
  assert.deepEqual(accounts.perValue.flatMap((p) => p.rows).map((r) => r.slug), ['sherlock']);
  const breach = resolve('check ada@example.org for breaches');
  assert.deepEqual(breach.perValue.flatMap((p) => p.rows).map((r) => r.slug), ['h8mail']);
  const infra = resolve('map the infrastructure of example.org');
  assert.deepEqual(infra.perValue.flatMap((p) => p.rows).map((r) => r.slug).sort(), ['crt-sh', 'shodan-search', 'subfinder']);
});

test('everything means the whole playbook for the named value, not one family', () => {
  // "everything on this username" names a value word that is also intent vocabulary; asking for everything must win.
  const named = resolve('everything on this username');
  assert.deepEqual(named.values, ['shiineslife'], 'the value word is a value, not an intent');
  // Breadth is what the catch-all changes: the domain has tools in two categories and both come back.
  const wide = resolve('everything on example.org');
  assert.deepEqual(wide.perValue.flatMap((p) => p.rows).map((r) => r.slug).sort(), ['crt-sh', 'shodan-search', 'subfinder']);
});

test('counts what the task can reach and what needs a person', () => {
  const r = resolve('find accounts and emails for this person');
  assert.ok(r.counts.tools > 0);
  assert.equal(typeof r.counts.runnable, 'number');
  assert.equal(typeof r.counts.byHand, 'number');
});

test('progress is judged from the profile, so a task knows what is left', () => {
  const task = { values: ['ada@example.org'], slugs: ['h8mail', 'epieos'] };
  const profile = { runs: { 'ada@example.org': { h8mail: { status: 'ok', found: 0 } } } };
  assert.deepEqual(taskProgress(task, profile), { done: 1, total: 2, left: 1 });
  assert.deepEqual(taskProgress(task, {}), { done: 0, total: 2, left: 2 });
});

test('leaves the intent words out when reporting what it could not place', () => {
  assert.equal(unplacedWords('find accounts for the weird thing', matchIntents('find accounts for the weird thing')), 'weird thing');
});
