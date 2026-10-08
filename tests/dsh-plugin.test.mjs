// The tool's mapping from a call to a command, and the rules it refuses to break. It lives in dsh-plugin/lib/plan.js
// with no harness imports precisely so this can run wherever the project runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIONS,
  NEEDS_CONFIRM,
  OUTPUT_SCHEMA,
  PARAMETERS,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  buildInvocation,
  errorSummary,
  outFor,
  parseJsonOutput,
  resolveRoot,
  summarise,
  toJsonSchema,
} from '../dsh-plugin/lib/plan.js';

test('converts a parameter map the way the harness does', () => {
  const schema = toJsonSchema(PARAMETERS);
  assert.equal(schema.type, 'object');
  // The harness hoists each property's inline `required: true` into one array at the root, and does not close the root
  // object. Both details matter: they are what its registry validates the model's arguments against.
  assert.deepEqual(schema.required, ['action']);
  assert.equal(schema.additionalProperties, undefined);
  assert.equal(schema.properties.action.required, undefined);
  assert.deepEqual(schema.properties.action.enum, ['case_new', 'task_add', 'task_list', 'plan', 'profile', 'run', 'hands']);
  assert.deepEqual(schema.properties.values.items, { type: 'string' });
  assert.equal(schema.properties.max.type, 'integer');
});

test('converts an output schema that names its own type', () => {
  const schema = toJsonSchema(OUTPUT_SCHEMA);
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false, 'what the spec asked for is kept');
  assert.deepEqual(schema.required, ['ok', 'action', 'summary']);
  assert.deepEqual(Object.keys(schema.properties), ['ok', 'action', 'summary', 'case', 'out', 'data']);
});

test('the plugin imports nothing from the harness', () => {
  // This is the bug that made the tool invisible: `@deepseek-ai/dsh-tools` cannot be resolved from a profile, the
  // import throws during boot, and the session simply has no such tool. Nothing warns the user.
  const source = readFileSync(join(import.meta.dirname, '..', 'dsh-plugin', 'lib', 'index.js'), 'utf8');
  assert.ok(!/from\s+['"]@deepseek-ai\//.test(source), 'a bare harness import cannot resolve from a profile');
  assert.match(source, /ctx\.tools\.register\(tool\)/, 'the tool is still registered');
  assert.equal(TOOL_NAME, 'osint_agent');
  assert.ok(TOOL_DESCRIPTION.length > 300, 'the model needs a real description to know when to call it');
});

const root = 'C:\\repo\\osint-hub';
const env = { root, data: 'C:\\repo\\osint-hub\\dist\\api\\tools.json' };
const CASE = 'C:\\cases\\ada.json';

test('finds the checkout, and says how to fix it when it cannot', () => {
  assert.equal(resolveRoot({ OSINT_HUB: root }, (p) => p.startsWith(root)), root);
  assert.equal(resolveRoot({ OSINT_HUB_ROOT: root }, (p) => p.startsWith(root)), root);
  assert.throws(() => resolveRoot({}, () => false), /Set OSINT_HUB/);
});

test('opens a case only with identifiers and a stated basis', () => {
  const ok = buildInvocation({ action: 'case_new', title: 'Ada', values: ['ada@example.org', 'shiineslife'], basis: 'Mandate 4412', out: 'C:\\cases\\ada-out' }, env);
  assert.deepEqual(ok.argv, [
    'case', 'new', 'Ada',
    '--value', 'ada@example.org,shiineslife',
    '--basis', 'Mandate 4412',
    '--out', 'C:\\cases\\ada-out',
    '--json', '--data', env.data,
  ]);
  // The basis is the difference between an investigation and a fishing trip, so a case cannot be opened without one.
  assert.throws(() => buildInvocation({ action: 'case_new', title: 'Ada', values: ['x'] }, env), /basis/);
  assert.throws(() => buildInvocation({ action: 'case_new', title: 'Ada', basis: 'b' }, env), /values/);
  assert.throws(() => buildInvocation({ action: 'case_new', values: ['x'], basis: 'b' }, env), /title/);
});

test('assigns a task in the user\u2019s words', () => {
  const r = buildInvocation({ action: 'task_add', case: CASE, text: 'find every account this username has' }, env);
  assert.deepEqual(r.argv.slice(0, 5), ['agent', 'task', 'add', 'find every account this username has', CASE]);
  assert.ok(r.argv.includes('--json'));
});

test('every other action needs the case it acts on', () => {
  for (const action of ['task_list', 'plan', 'profile', 'run', 'hands']) {
    assert.throws(() => buildInvocation({ action, confirm: true }, env), /needs the case/, `${action} without a case`);
  }
});

test('spending the user\u2019s connection needs an explicit confirmation', () => {
  for (const action of NEEDS_CONFIRM) {
    assert.throws(() => buildInvocation({ action, case: CASE }, env), /confirm: true/, `${action} must refuse without it`);
  }
  assert.deepEqual(NEEDS_CONFIRM, ['run', 'hands']);
});

test('budgets default small, and pass through when given', () => {
  const run = buildInvocation({ action: 'run', case: CASE, confirm: true }, env);
  assert.ok(run.argv.includes('--yes'));
  assert.equal(run.argv[run.argv.indexOf('--max') + 1], '8');
  assert.equal(run.argv[run.argv.indexOf('--seconds') + 1], '240');
  const hands = buildInvocation({ action: 'hands', case: CASE, confirm: true }, env);
  assert.equal(hands.argv[hands.argv.indexOf('--max') + 1], '4');
  const tight = buildInvocation({ action: 'run', case: CASE, confirm: true, max: 2, seconds: 60 }, env);
  assert.equal(tight.argv[tight.argv.indexOf('--max') + 1], '2');
  assert.equal(tight.argv[tight.argv.indexOf('--seconds') + 1], '60');
});

test('plan and the run actions narrow to one assigned task', () => {
  for (const action of ['plan', 'run', 'hands']) {
    const r = buildInvocation({ action, case: CASE, task: 't2', confirm: true }, env);
    assert.ok(r.argv.includes('--task') && r.argv.includes('t2'), `${action} should pass --task`);
  }
});

test('artefacts land beside the case unless the caller says otherwise', () => {
  assert.equal(outFor('C:\\cases\\ada.json'), 'C:\\cases\\ada-out');
  assert.equal(buildInvocation({ action: 'plan', case: CASE }, env).out, 'C:\\cases\\ada-out');
  const r = buildInvocation({ action: 'plan', case: CASE, out: 'D:\\work' }, env);
  assert.equal(r.out, 'D:\\work');
});

test('the local tool data is used when it is there, and skipped when it is not', () => {
  assert.ok(buildInvocation({ action: 'plan', case: CASE }, env).argv.includes(env.data));
  assert.ok(!buildInvocation({ action: 'plan', case: CASE }, { root }).argv.includes('--data'));
});

test('refuses an action it does not know, and lists the ones it does', () => {
  assert.throws(() => buildInvocation({ action: 'exfiltrate', case: CASE }, env), /unknown action/);
  for (const action of ['case_new', 'task_add', 'task_list', 'plan', 'profile', 'run', 'hands']) {
    assert.ok(ACTIONS.includes(action), `${action} should be exposed`);
  }
});

test('reads the JSON the CLI prints, even with other lines around it', () => {
  assert.deepEqual(parseJsonOutput('{"ok":true}'), { ok: true });
  assert.deepEqual(parseJsonOutput('noise\n{"leads":3}\n'), { leads: 3 });
  assert.equal(parseJsonOutput('not json at all'), undefined);
  assert.equal(parseJsonOutput(''), undefined);
});

test('says so when a task was not understood, instead of inventing work', () => {
  const unmapped = summarise('task_add', { task: { id: 't3', text: 'do something clever with it', intentsLabel: [], values: [] } });
  assert.match(unmapped, /not understood/);
  assert.match(unmapped, /proposes no tools/);
  const mapped = summarise('task_add', { task: { id: 't1', text: 'find accounts', intentsLabel: ['accounts and profiles'], values: ['johndoe'], counts: { tools: 62, runnable: 8, fetchable: 11, byHand: 10 } } });
  assert.match(mapped, /accounts and profiles/);
  assert.match(mapped, /62 tools in scope/);
});

test('the run summary reports what happened, including nothing happening', () => {
  const text = summarise('run', {
    counts: { leads: 270, toolsRun: 2, byKind: { domain: 212, ip: 58 } },
    run: { ok: 1, attempted: 1, findings: 92, stopped: 'time budget of 150s reached' },
    profile: 'P', dossier: 'D', report: 'R',
  });
  assert.match(text, /1\/1 finished cleanly/);
  assert.match(text, /212 domain/);
  assert.match(text, /stopped: time budget/);
});

test('a failure reports the error line rather than the whole dump', () => {
  assert.equal(errorSummary('warning: noise\nerror no such file: x.json\nmore noise', ''), 'error no such file: x.json');
  assert.equal(errorSummary('', ''), 'the command failed without saying why');
});
