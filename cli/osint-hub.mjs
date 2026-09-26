#!/usr/bin/env node
// osint-hub CLI: search the directory, turn a value into search links, and read playbooks from the terminal.
// No dependencies. Data comes from https://osinthub.pages.dev/api/*.json and is cached for a day.
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { detect, launchable, templatesFor, applies, buildLink, commandsFor, SHELLS, MATCH_LABELS } from '../shared/launcher.mjs';

const VERSION = '1.0.0';
const HELP = `osint-hub ${VERSION}: OSINT tools by what you are investigating

Usage
  osint-hub search <words...>          Find tools by keyword
  osint-hub tools [filters]            List tools, e.g. --input email --passive --free
  osint-hub show <tool>                Details for one tool (slug or name)
  osint-hub detect <value>             What kind of value this looks like
  osint-hub launch <value> [options]   Search links for every tool that can take the value
  osint-hub commands <value> [options] Ready-to-run commands for command-line tools that take it
  osint-hub playbooks                  List investigation playbooks
  osint-hub playbook <slug> [--value V] Print a playbook; --value adds search links
  osint-hub update                     Refresh the cached data now

Filters for "tools":  --input <type>  --category <c>  --type <web|cli|...>  --passive  --free  --no-account
Options for "launch": --as <type>  pick the type yourself (e.g. --as company)
                      --active     include tools that contact the target
                      --open       open the links in your browser
Options for "commands": --as <type>  --active  --docker (use Docker images where available)
                      --shell <posix|powershell> (default: powershell on Windows, posix elsewhere)
                      --plain (commands only, one per line)
Global options:       --json  --no-color  --api <base-url>

Your values never leave your machine except to the tools you open.`;

// ---- Arguments ----
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) positional.push(a);
  else if (['--input', '--category', '--type', '--as', '--value', '--api', '--shell'].includes(a)) flags[a.slice(2)] = argv[++i];
  else flags[a.slice(2)] = true;
}
const [command, ...rest] = positional;
const API = (flags.api ?? process.env.OSINT_HUB_API ?? 'https://osinthub.pages.dev').replace(/\/+$/, '');

// ---- Output helpers ----
const color = process.stdout.isTTY && !flags['no-color'] && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint('1');
const dim = paint('2');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');
const out = (s = '') => process.stdout.write(`${s}\n`);
const fail = (msg) => {
  process.stderr.write(`${red('error')} ${msg}\n`);
  process.exit(1);
};
const json = (data) => out(JSON.stringify(data, null, 2));

// ---- Data, cached for a day, with the stale copy used when offline ----
const cacheDir = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'osint-hub')
  : join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'osint-hub');
const DAY = 86_400_000;

async function load(name, { force = false } = {}) {
  const file = join(cacheDir, `${name}.json`);
  const fresh = existsSync(file) && Date.now() - statSync(file).mtimeMs < DAY;
  if (fresh && !force) return JSON.parse(readFileSync(file, 'utf8'));
  try {
    const res = await fetch(`${API}/api/${name}.json`, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': `osint-hub-cli/${VERSION}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, text);
    return JSON.parse(text);
  } catch (e) {
    // An explicit "update" should say it failed rather than quietly reuse old data.
    if (existsSync(file) && !force) {
      process.stderr.write(dim(`(offline: using cached data from ${new Date(statSync(file).mtimeMs).toLocaleString()})\n`));
      return JSON.parse(readFileSync(file, 'utf8'));
    }
    fail(`could not download ${name} from ${API} (${e.message})${existsSync(file) ? '; your cached copy was kept' : ' and there is no cached copy yet'}.`);
  }
}

function openUrl(url) {
  // No shell involved: the URL is passed as a single argument.
  const [cmd, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

// ---- Formatting ----
const badges = (t) =>
  [!t.passive && yellow('active'), t.account_required && dim('account'), t.cost !== 'free' && dim(t.cost), t.status === 'down' && red('down')]
    .filter(Boolean)
    .join(' ');

function toolLine(t, width = 28) {
  const name = t.name.length > width ? `${t.name.slice(0, width - 1)}…` : t.name.padEnd(width);
  return `${bold(name)} ${dim(t.slug.padEnd(26))} ${t.description.slice(0, 90)}${t.description.length > 90 ? '…' : ''} ${badges(t)}`;
}

function findTool(tools, key) {
  const k = key.toLowerCase();
  return tools.find((t) => t.slug === k) ?? tools.find((t) => t.name.toLowerCase() === k) ?? tools.find((t) => t.slug.includes(k) || t.name.toLowerCase().includes(k));
}

// ---- Commands ----
async function main() {
  if (flags.version || command === 'version') return out(VERSION);
  if (!command || flags.help || command === 'help') return out(HELP);

  if (command === 'update') {
    const d = await load('tools', { force: true });
    await load('playbooks', { force: true });
    return out(`${green('updated')} ${d.tools.length} tools, cached in ${cacheDir}`);
  }

  if (command === 'detect') {
    const value = rest.join(' ');
    if (!value) fail('give a value, e.g. osint-hub detect 8.8.8.8');
    const { taxonomy } = await load('tools');
    const types = detect(value);
    if (flags.json) return json({ value, types });
    if (!types.length) return out('Not recognised.');
    return out(`${bold(taxonomy.inputs[types[0]] ?? types[0])}${types.length > 1 ? dim(`  (could also be: ${types.slice(1).map((t) => taxonomy.inputs[t] ?? t).join(', ')})`) : ''}`);
  }

  if (command === 'launch') {
    const value = rest.join(' ');
    if (!value) fail('give a value, e.g. osint-hub launch example.com');
    const { tools, taxonomy } = await load('tools');
    const type = flags.as ?? detect(value)[0];
    if (!type || !(type in taxonomy.inputs)) fail(`could not tell what "${value}" is; pick one with --as <${Object.keys(taxonomy.inputs).join('|')}>`);
    const rows = launchable(tools, type, value, { includeActive: !!flags.active });
    const usable = rows.filter((r) => r.usable);
    if (flags.json) return json({ value, type, links: usable.map((r) => ({ tool: r.tool.slug, name: r.tool.name, passive: r.tool.passive, url: r.link })) });
    out(`${bold(value)} ${dim('as')} ${taxonomy.inputs[type]} ${dim(`· ${usable.length} tools${flags.active ? '' : ' (passive only; add --active for more)'}`)}\n`);
    for (const r of rows) {
      if (r.usable) out(`  ${r.tool.name.padEnd(30)} ${r.link} ${badges(r.tool)}`);
      else out(dim(`  ${r.tool.name.padEnd(30)} only ${MATCH_LABELS[r.template.match]}`));
    }
    if (!rows.length) out(dim(`  No tool can search a ${taxonomy.inputs[type].toLowerCase()} directly. Try: osint-hub tools --input ${type}`));
    if (flags.open) {
      for (const r of usable) openUrl(r.link);
      out(`\n${green('opened')} ${usable.length} tabs`);
    }
    return;
  }

  if (command === 'commands') {
    const value = rest.join(' ');
    if (!value) fail('give a value, e.g. osint-hub commands johndoe');
    const { tools, taxonomy } = await load('tools');
    const type = flags.as ?? detect(value)[0];
    if (!type || !(type in taxonomy.inputs)) fail(`could not tell what "${value}" is; pick one with --as <type>`);
    const shell = flags.shell ?? (process.platform === 'win32' ? 'powershell' : 'posix');
    if (!(shell in SHELLS)) fail(`unknown shell "${shell}"; use ${Object.keys(SHELLS).join(' or ')}`);
    const { problem, rows } = commandsFor(tools, type, value, { shell, includeActive: !!flags.active });
    if (problem) fail(`no commands: the value ${problem}.`);
    const lines = rows.map((r) => ({ tool: r.tool, line: flags.docker && r.docker ? r.docker : r.command }));
    if (flags.json) return json({ value, type, shell, commands: lines.map((l) => ({ tool: l.tool.slug, name: l.tool.name, command: l.line })) });
    if (flags.plain) return lines.forEach((l) => out(l.line)); // just the commands, e.g. to save as a script
    out(`${bold(value)} ${dim('as')} ${taxonomy.inputs[type]} ${dim(`· ${lines.length} commands for ${SHELLS[shell]}${flags.active ? '' : ' (passive only; add --active for more)'}`)}\n`);
    for (const l of lines) out(`  ${dim(`# ${l.tool.name}${l.tool.install ? `  (install: ${l.tool.install})` : l.tool.repo ? `  (https://github.com/${l.tool.repo})` : ''}`)}\n  ${l.line}\n`);
    if (!lines.length) out(dim(`  No command-line tool takes a ${taxonomy.inputs[type].toLowerCase()} yet. Try: osint-hub launch ${value}`));
    return;
  }

  if (command === 'search' || command === 'tools') {
    const { tools, taxonomy } = await load('tools');
    const terms = command === 'search' ? rest.join(' ').toLowerCase().split(/\s+/).filter(Boolean) : [];
    if (command === 'search' && !terms.length) fail('give some words, e.g. osint-hub search subdomains');
    if (flags.input && !(flags.input in taxonomy.inputs)) fail(`unknown input "${flags.input}". Use one of: ${Object.keys(taxonomy.inputs).join(', ')}`);
    const hits = tools.filter(
      (t) =>
        terms.every((w) => `${t.name} ${t.description} ${t.category} ${t.inputs.join(' ')}`.toLowerCase().includes(w)) &&
        (!flags.input || t.inputs.includes(flags.input)) &&
        (!flags.category || t.category === flags.category) &&
        (!flags.type || t.type === flags.type) &&
        (!flags.passive || t.passive) &&
        (!flags.free || t.cost === 'free') &&
        (!flags['no-account'] || !t.account_required),
    );
    if (flags.json) return json(hits);
    for (const t of hits) out(toolLine(t));
    return out(dim(`\n${hits.length} tools. Details: osint-hub show <slug>`));
  }

  if (command === 'show') {
    const { tools, taxonomy, site } = await load('tools');
    const t = rest.length ? findTool(tools, rest.join(' ')) : undefined;
    if (!t) fail(`no tool matching "${rest.join(' ')}". Try: osint-hub search ${rest.join(' ')}`);
    if (flags.json) return json(t);
    out(`${bold(t.name)}  ${badges(t)}\n${t.description}\n`);
    const row = (k, v) => v && out(`  ${dim(k.padEnd(12))} ${v}`);
    row('URL', t.url);
    row('Takes', t.inputs.map((i) => taxonomy.inputs[i]).join(', '));
    row('Gives', t.outputs.map((o) => taxonomy.inputs[o] ?? o.replace(/_/g, ' ')).join(', '));
    row('Type', `${taxonomy.types[t.type]} · ${taxonomy.costs[t.cost]} · ${t.passive ? 'passive' : 'active: contacts the target'}${t.account_required ? ' · account needed' : ''}`);
    row('Install', t.install);
    row('Repo', t.repo && `https://github.com/${t.repo}`);
    row('Searchable', Object.keys(templatesFor(t.query_template, t.inputs)).map((i) => taxonomy.inputs[i]).join(', '));
    row('Link status', t.status);
    row('Page', `${site}/tools/${t.slug}`);
    if (t.notes) out(`\n  ${yellow('Note')} ${t.notes}`);
    return;
  }

  if (command === 'playbooks') {
    const { playbooks } = await load('playbooks');
    if (flags.json) return json(playbooks.map(({ slug, title, summary }) => ({ slug, title, summary })));
    for (const p of playbooks) out(`${bold(p.slug.padEnd(20))} ${p.title} ${dim(`(${p.steps.length} steps, ${p.time})`)}`);
    return out(dim('\nRead one: osint-hub playbook <slug> [--value <what you have>]'));
  }

  if (command === 'playbook') {
    const [{ playbooks }, { tools, taxonomy, site }] = await Promise.all([load('playbooks'), load('tools')]);
    const p = playbooks.find((x) => x.slug === rest[0]);
    if (!p) fail(`no playbook "${rest[0] ?? ''}". List them with: osint-hub playbooks`);
    if (flags.json) return json(p);
    const bySlug = new Map(tools.map((t) => [t.slug, t]));
    out(`${bold(p.title)}\n${p.summary}\n${dim(`Starts with: ${taxonomy.inputs[p.starts_with]} · ${p.time} · ${site}/playbooks/${p.slug}`)}`);
    p.steps.forEach((s, i) => {
      out(`\n${bold(`${i + 1}. ${s.title}`)}`);
      out(`   ${dim('Why')} ${s.why}`);
      out(`   ${dim('Do ')} ${s.do}`);
      for (const l of s.look_for ?? []) out(`   ${dim('•')} ${l}`);
      if (s.opsec) out(`   ${yellow('Careful')} ${s.opsec}`);
      for (const slug of s.tools) {
        const t = bySlug.get(slug);
        if (!t) continue;
        const tpl = flags.value && s.input === p.starts_with ? templatesFor(t.query_template, t.inputs)[s.input] : undefined;
        const link = tpl && applies(tpl, flags.value) ? buildLink(tpl, flags.value) : t.url;
        out(`   → ${t.name.padEnd(28)} ${dim(link)} ${badges(t)}`);
      }
    });
    return;
  }

  fail(`unknown command "${command}". Run osint-hub --help`);
}

main().catch((e) => fail(e.message));
