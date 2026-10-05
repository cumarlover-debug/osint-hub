// Exercises the plugin the way the harness does: register the tool through the harness's own defineTool, then call
// it. Run it from this directory with the harness installed.
//
//   node dsh-plugin/selftest.mjs
//
// The harness's own packages are not installed in this repo, so the first thing this does is make `@deepseek-ai/dsh-tools`
// resolvable from here by re-exporting the real module out of the installed harness. That keeps the test honest - it is
// the harness's schema conversion and argument validation doing the work, not a stub of mine.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
    const tools = join(c, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
    if (existsSync(tools)) return c;
  }
  throw new Error('harness not found: set DSH_PACKAGE to the installed @deepseek-ai/dsh directory');
}

function makeResolvable(harness) {
  const dir = join(repo, 'node_modules', '@deepseek-ai', 'dsh-tools');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', type: 'module', main: 'index.js' }, null, 2));
  const real = join(harness, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js').replace(/\\/g, '/');
  writeFileSync(join(dir, 'index.js'), `// Written by dsh-plugin/selftest.mjs so this repo can import the real harness module.\nexport * from 'file:///${real}';\n`);
  return dir;
}

const harness = harnessRoot();
const stub = makeResolvable(harness);

const { apply } = await import('./lib/index.js');
const { buildInvocation } = await import('./lib/plan.js');
const { existsSync: exists } = await import('node:fs');

const registered = [];
apply({ tools: { register: (tool) => registered.push(tool) } });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const tool = registered[0];
check('the plugin registers exactly one tool', registered.length === 1 && tool?.name === 'osint_agent', tool?.name);
check('it is described to the model', typeof tool?.description === 'string' && tool.description.length > 200);
check('the harness converted the parameters to JSON Schema', tool?.parameters?.type === 'object' && !!tool.parameters.properties?.action);
check('every action is offered as an enum', Array.isArray(tool.parameters.properties.action.enum) && tool.parameters.properties.action.enum.length === 7);

// A real case, made by the CLI through this tool path, then planned and refused as a run until confirmed.
const casePath = join(repo, '.cache', 'selftest-case.json');
rmSync(casePath, { force: true });
const opened = await tool.execute({ action: 'case_new', title: 'Selftest', values: ['ada@example.org'], basis: 'Plugin selftest, no real subject', out: join(repo, '.cache', 'selftest-out') });
check('case_new opens a case', opened.ok === true && exists(opened.case), opened.case ?? opened.summary);
const caseFile = opened.case ?? casePath;

const planned = await tool.execute({ action: 'plan', case: caseFile });
check('plan reports what is possible', planned.ok === true && /leads from/.test(planned.summary), planned.summary.split('\n')[0]);

const refused = await tool.execute({ action: 'run', case: caseFile });
check('run refuses without confirmation', refused.ok === false && /confirm/.test(refused.summary), refused.summary);

// The harness validates arguments itself and throws before the tool runs, which is the enforcement we want.
let rejectedByHarness = false;
try {
  await tool.execute({ action: 'nope', case: caseFile });
} catch (e) {
  rejectedByHarness = /INVALID_ARGS|invalid arguments/.test(String(e?.code ?? '') + String(e?.message ?? ''));
}
check('an unknown action never reaches the tool', rejectedByHarness);

// The mapping itself, checked without spawning anything.
const argv = buildInvocation({ action: 'run', case: caseFile, confirm: true, max: 3, seconds: 90 }, { root: repo });
check('run maps to a bounded, confirmed command', argv.argv.includes('--yes') && argv.argv.includes('3') && argv.argv.includes('90'));

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}`);
rmSync(stub, { recursive: true, force: true });
process.exitCode = failures ? 1 : 0;
