// Marks the web tools that present a search form as by-hand entries.
//
// The directory has a hole in the middle of it: hundreds of tools have no command to run and no search URL to
// request, so nothing can reach them - not the fetcher, not the browser driver - and the workbench shows them as
// "no direct search" with no explanation. Most of them do have a box on the page; the data simply never said so.
//
// This fetches each one and looks for a search-shaped input. Finding one is a fact about the page, not a guess, and
// the mark it writes is what makes the tool attemptable by `agent hands` and visible in the workbench as by-hand.
//
//   node scripts/mark-forms.mjs --dry-run --limit 40     look before writing anything
//   node scripts/mark-forms.mjs --limit 200              mark what has a form, in batches
//   node scripts/mark-forms.mjs --stale                  include the ones checked before (default: skip them)
//
// Requests are polite - a handful in flight, a timeout each - because most of these are small sites that never
// asked to be crawled.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, paths, readYamlDir } from './lib/data.mjs';
import { UA, TIMEOUT_MS, pool } from './lib/net.mjs';
import { searchFormIn } from './lib/forms.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : (argv[i + 1] ?? true);
};
const dryRun = argv.includes('--dry-run');
const limit = Number(flag('limit') ?? 0);
const concurrency = Number(flag('concurrency') ?? 5);
const reportPath = join(root, 'data/pipeline/form-discovery.txt');

/** Field names a search box tends to use. Deliberately generous: a site-wide search box is still a box. */
// The rule itself lives in scripts/lib/forms.mjs and is tested in tests/forms.test.mjs: one copy, so the marking
// this script writes cannot drift from the rule the tests hold.

const candidates = readYamlDir(paths.tools)
  .map(({ slug, tool, file }) => ({ slug, tool, file }))
  .filter(({ tool }) => tool.type === 'web' && !tool.query_template && !tool.command_template && !tool.manual)
  .filter(({ slug }) => !(flag('only') && !String(flag('only')).split(',').map((s) => s.trim()).includes(slug)));

const chosen = limit ? candidates.slice(0, limit) : candidates;
console.log(`${chosen.length} of ${candidates.length} unreachable web tools to look at${dryRun ? ' (dry run)' : ''}\n`);

const marked = [];
const sketched = [];
const walls = [];
const none = [];

await pool(chosen, concurrency, async ({ slug, tool, file }) => {
  const url = String(tool.url);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const html = res.ok ? (await res.text()).slice(0, 600_000) : '';
    res.body?.cancel?.().catch(() => {});
    if (!res.ok) {
      walls.push(`${slug}\tHTTP ${res.status}`);
      return null;
    }
    const found = searchFormIn(html);
    if (!found) {
      none.push(`${slug}\tno search box found at ${url}`);
      return null;
    }
    if (found.wall) {
      walls.push(`${slug}\tbot wall or dead page at ${url}`);
      return null;
    }
    marked.push(`${slug}\t${found.reason}\t${url}`);
    if (!dryRun) {
      const path = join(paths.tools, file);
      const text = readFileSync(path, 'utf8');
      if (!/^manual:/m.test(text)) {
        writeFileSync(path, text.replace(/^(account_required:.*)$/m, '$1\nmanual: post-form'));
      }
    }
    return null;
  } catch (e) {
    walls.push(`${slug}\t${e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code ?? e.message)}`);
    return null;
  }
});

console.log(`${marked.length} have a search box${dryRun ? ' (nothing written)' : ' and were marked as by-hand'}`);
for (const line of marked.slice(0, 12)) console.log(`  + ${line.split('\t')[0].padEnd(28)} ${line.split('\t')[1]}`);
if (marked.length > 12) console.log(`  …and ${marked.length - 12} more`);
console.log(`${none.length} have no box the script can see`);
console.log(`${walls.length} could not be read (bot wall, dead or unreachable)`);

// A record of what was decided about each page, so the marks are auditable rather than mysterious.
if (!dryRun) {
  const stamp = new Date().toISOString().slice(0, 10);
  const body = [
    `# Web tools with no command and no search URL, checked for a search form on ${stamp}`,
    `# ${marked.length} marked as by-hand, ${none.length} with nothing to fill in, ${walls.length} unreadable.`,
    '',
    '## marked as by-hand (post-form)',
    ...marked.map((l) => l.replace(/\t/g, '  # ')),
    '',
    '## nothing to fill in',
    ...none.map((l) => l.replace(/\t/g, '  # ')),
    '',
    '## unreadable (left alone)',
    ...walls.map((l) => l.replace(/\t/g, '  # ')),
    '',
  ].join('\n');
  const existing = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
  writeFileSync(reportPath, `${body}${existing ? `${existing}\n` : ''}`);
  console.log(`\nwrote ${reportPath}`);
}
