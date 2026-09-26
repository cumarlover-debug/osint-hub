// Runs when a "Suggest a tool" issue is opened or edited: checks it and posts (or updates) one results comment.
//
//   node scripts/submissions/check.mjs                       in GitHub Actions (reads GITHUB_EVENT_PATH)
//   node scripts/submissions/check.mjs event.json --dry-run  locally: prints the comment instead of posting it
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { parseIssueForm, checkSubmission, renderResults, upsertComment, setStatusLabel } from './lib.mjs';

const dryRun = process.argv.includes('--dry-run');
const eventPath = process.argv.slice(2).find((a) => a.endsWith('.json')) ?? process.env.GITHUB_EVENT_PATH;
const { issue } = JSON.parse(readFileSync(eventPath, 'utf8'));

const isSubmission = issue.labels?.some((l) => l.name === 'tool-submission') || /^### Tool name$/m.test(issue.body ?? '');
if (!isSubmission || issue.state !== 'open') {
  console.log('Not an open tool submission; nothing to do.');
  process.exit(0);
}

const check = await checkSubmission(parseIssueForm(issue.body));
const markdown = renderResults(check, yaml.dump(check.tool, { flowLevel: 1, lineWidth: -1 }));

if (dryRun) {
  console.log(markdown);
} else {
  const repo = process.env.GITHUB_REPOSITORY;
  await upsertComment(repo, issue.number, markdown);
  await setStatusLabel(repo, issue.number, check.ok ? 'ready-for-review' : 'needs-changes');
  console.log(`Issue #${issue.number}: ${check.ok ? 'ready for review' : 'needs changes'}`);
}
