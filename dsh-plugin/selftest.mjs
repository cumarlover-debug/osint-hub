// Exercises the plugin the way the harness does: register the tool, then call it. Run it with the harness installed.
//
//   node dsh-plugin/selftest.mjs
//
// Two things are checked here that a plain unit test cannot. The plugin must load with nothing from the harness
// resolvable - an earlier version imported `@deepseek-ai/dsh-tools`, which cannot resolve from a profile, and the tool
// then silently never appeared in any session. And the JSON Schema this plugin generates must equal the one the
// harness's own `defineTool` generates from the same spec, so the hand-written conversion cannot drift from the real
// one. The harness's module is borrowed for that comparison by re-exporting it into this repo, then removed again.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dirname;
const repo = join(here, '..');

function harnessRoot() {
  const candidates = [
    process.env.DSH_PACKAGE,
    'C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh',
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(join(c, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))) return c;
  }
  return undefined;
}

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// 1. The plugin imports nothing from the harness, so it loads wherever a profile can load it.
const source = readFileSync(join(here, 'lib', 'index.js'), 'utf8');
const bare = /from\s+['"]@deepseek-ai\//.test(source);
check('the plugin imports nothing from the harness', !bare, bare ? 'found a bare @deepseek-ai import' : 'no bare imports');

const { apply, tool } = await import('./lib/index.js');
const registered = [];
apply({ tools: { register: (t) => registered.push(t) } });
check('it registers exactly one tool', registered.length === 1 && registered[0]?.name === 'osint_agent', registered[0]?.name);
check('the description tells the model what it does', String(tool.description ?? '').length > 300);
check('every action is offered as an enum', Array.isArray(tool.parameters?.properties?.action?.enum) && tool.parameters.properties.action.enum.length === 7);
check('required arguments are declared', Array.isArray(tool.parameters?.required) && tool.parameters.required.includes('action'));

// 2. The hand-written schema conversion must match the harness's own, because that is what the registry validates against.
const harness = harnessRoot();
if (!harness) {
  console.log('  skip no harness installation found; the schema cross-check needs it');
} else {
  const stub = join(repo, 'node_modules', '@deepseek-ai', 'dsh-tools');
  mkdirSync(stub, { recursive: true });
  writeFileSync(join(stub, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', type: 'module', main: 'index.js' }, null, 2));
  const real = join(harness, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js').replace(/\\/g, '/');
  writeFileSync(join(stub, 'index.js'), `export * from 'file:///${real}';\n`);
  try {
    const { defineTool } = await import('@deepseek-ai/dsh-tools');
    const { PARAMETERS, OUTPUT_SCHEMA } = await import('./lib/plan.js');
    const reference = defineTool({ name: 'osint_agent', description: 'x', parameters: PARAMETERS, output: { schema: OUTPUT_SCHEMA, render: () => [] } });
    const mine = JSON.stringify(tool.parameters);
    const theirs = JSON.stringify(reference.parameters);
    check('the parameters schema equals the harness\u2019s own conversion', mine === theirs, mine === theirs ? '' : `mine ${mine.slice(0, 80)}… theirs ${theirs.slice(0, 80)}…`);
    const sameOutput = JSON.stringify(tool.output.schema) === JSON.stringify(reference.output.schema);
    check('the output schema equals the harness\u2019s own conversion', sameOutput);
  } catch (e) {
    check('the schema cross-check ran', false, e.message.slice(0, 120));
  } finally {
    rmSync(stub, { recursive: true, force: true });
  }
}

// 3. Real calls, through the tool interface.
const out = join(repo, '.cache', 'selftest-out');
const opened = await tool.execute({ action: 'case_new', title: 'Selftest', values: ['ada@example.org'], basis: 'Plugin selftest, no real subject', out });
check('case_new opens a case', opened.ok === true && existsSync(opened.case ?? ''), opened.case ?? opened.summary);
check('plan reports what is possible', (await tool.execute({ action: 'plan', case: opened.case })).summary.includes('leads from'));
const refused = await tool.execute({ action: 'run', case: opened.case });
check('run refuses without confirmation', refused.ok === false && /confirm/.test(refused.summary));
const noBasis = await tool.execute({ action: 'case_new', title: 'No basis', values: ['x'] });
check('a case without a basis is refused', noBasis.ok === false && /basis/.test(noBasis.summary));

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}`);
process.exitCode = failures ? 1 : 0;
