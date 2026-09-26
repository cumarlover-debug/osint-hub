// Runs when a maintainer adds the "approved" label to a tool submission.
//
//   node scripts/submissions/approve.mjs              re-check, write data/tools/<slug>.yaml, health-check it,
//                                                     and leave a commit message in $RUNNER_TEMP for the workflow
//   node scripts/submissions/approve.mjs --announce   after the push: comment with the link and close the issue
//
// Locally: node scripts/submissions/approve.mjs event.json --dry-run   (writes the file, skips GitHub and permissions)
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import { paths, root } from '../lib/data.mjs';
import { parseIssueForm, checkSubmission, renderResults, upsertComment, github } from './lib.mjs';

const dryRun = process.argv.includes('--dry-run');
const announce = process.argv.includes('--announce');
const eventPath = process.argv.slice(2).find((a) => a.endsWith('.json')) ?? process.env.GITHUB_EVENT_PATH;
const { issue, sender } = JSON.parse(readFileSync(eventPath, 'utf8'));
const repo = process.env.GITHUB_REPOSITORY;
const msgFile = join(process.env.RUNNER_TEMP ?? tmpdir(), 'osint-hub-commit-msg.txt');
const output = (key, value) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);

const check = await checkSubmission(parseIssueForm(issue.body));
const { tool, slug } = check;

if (announce) {
  await github('POST', `/repos/${repo}/issues/${issue.number}/comments`, {
    body: `Published: https://osinthub.pages.dev/tools/${slug} (live once the site finishes deploying, usually within a few minutes). Thank you!`,
  });
  await github('PATCH', `/repos/${repo}/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });
  process.exit(0);
}

// Labels can only be added by people with triage rights or more; publishing additionally needs write access.
if (!dryRun) {
  const perm = await github('GET', `/repos/${repo}/collaborators/${encodeURIComponent(sender.login)}/permission`);
  if (!['admin', 'maintain', 'write'].includes(perm.permission)) {
    await github('POST', `/repos/${repo}/issues/${issue.number}/comments`, { body: 'Only maintainers with write access can publish a submission.' });
    await github('DELETE', `/repos/${repo}/issues/${issue.number}/labels/approved`).catch(() => {});
    output('published', 'false');
    process.exit(0);
  }
}

const file = join(paths.tools, `${slug}.yaml`);
const blocker = !check.ok ? 'the automatic check has ❌ items' : existsSync(file) ? `data/tools/${slug}.yaml already exists` : '';
if (blocker) {
  const note = `### Not published: ${blocker}\n\nFix the issue (the check re-runs on edit), then add the \`approved\` label again.`;
  if (dryRun) console.log(note);
  else {
    await upsertComment(repo, issue.number, `${note}\n\n${renderResults(check, yaml.dump(tool, { flowLevel: 1, lineWidth: -1 }))}`);
    await github('DELETE', `/repos/${repo}/issues/${issue.number}/labels/approved`).catch(() => {});
  }
  output('published', 'false');
  process.exit(0);
}

writeFileSync(file, yaml.dump(tool, { flowLevel: 1, lineWidth: -1 }));
spawnSync(process.execPath, [join(root, 'scripts/healthcheck.mjs'), slug], { stdio: ['ignore', 'ignore', 'inherit'] });

// The commit message goes through a file, never through the shell, because the tool name comes from the issue.
writeFileSync(
  msgFile,
  `Add ${tool.name.replace(/[\r\n]/g, ' ')} (community submission)\n\n` +
    `Submitted in #${issue.number} by @${issue.user.login}, approved by @${sender.login}.\n\nCloses #${issue.number}\n`,
);
output('published', 'true');
output('slug', slug);
console.log(`Wrote data/tools/${slug}.yaml; commit message in ${msgFile}`);
