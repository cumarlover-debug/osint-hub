// Install the repo's DSH skills into the user's harness, so they are available in every workspace rather than only
// when the working directory happens to be this checkout.
//
// DSH reads local skills from, in priority order: <project>/.dsh/skills, <project>/.agents/skills, configured custom
// directories, then <dshHome>/skills. The copy in this repo is canonical because it is versioned with the tool it
// describes; this script puts it where the harness looks.
//
//   node scripts/install-skill.mjs            install, and say what changed
//   node scripts/install-skill.mjs --check    report drift without writing anything
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { root } from './lib/data.mjs';

const checkOnly = process.argv.includes('--check');
const from = join(root, '.dsh', 'skills');
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const to = join(dshHome, 'skills');

if (!existsSync(from)) {
  console.log(`no skills to install: ${from} does not exist`);
  process.exit(0);
}

/** Every skill is a directory with a SKILL.md, or a flat <name>.md. */
const skills = readdirSync(from, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(from, d.name, 'SKILL.md')))
  .map((d) => ({ name: d.name, file: join(from, d.name, 'SKILL.md') }));

if (!skills.length) {
  console.log(`no skill directories found under ${from}`);
  process.exit(0);
}

let installed = 0;
let current = 0;
const problems = [];
for (const skill of skills) {
  const body = readFileSync(skill.file, 'utf8');
  // A skill without frontmatter is not discoverable, and it fails silently: the harness simply never lists it.
  if (!/^---\r?\n[\s\S]*?\bname:\s*\S+[\s\S]*?\bdescription:\s*\S+/m.test(body)) {
    problems.push(`${skill.name}: SKILL.md needs frontmatter with both name and description`);
    continue;
  }
  const target = join(to, skill.name, 'SKILL.md');
  const same = existsSync(target) && readFileSync(target, 'utf8') === body;
  if (same) {
    current += 1;
    continue;
  }
  if (checkOnly) {
    problems.push(`${skill.name}: ${existsSync(target) ? 'installed copy differs from the repo' : 'not installed'}`);
    continue;
  }
  mkdirSync(join(to, skill.name), { recursive: true });
  copyFileSync(skill.file, target);
  installed += 1;
  console.log(`  installed ${skill.name} → ${target}`);
}

console.log(`\n${skills.length} skill${skills.length === 1 ? '' : 's'} in this repo · ${current} already current · ${installed} written`);
if (problems.length) {
  console.log(`\n${checkOnly ? 'out of step' : 'needs attention'}:`);
  for (const p of problems) console.log(`  ${p}`);
  if (checkOnly) process.exitCode = 1;
}
if (!problems.length && checkOnly) console.log('all installed copies match the repo');
console.log(`\nthe harness reads these from ${to} (any workspace) and from ${from} (this checkout only)`);
