#!/usr/bin/env node
// osint-hub CLI: search the directory, turn a value into search links, and read playbooks from the terminal.
// No dependencies. Data comes from https://osinthub.pages.dev/api/*.json and is cached for a day.
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { detect, launchable, templatesFor, applies, buildLink, commandsFor, SHELLS, MATCH_LABELS } from '../shared/launcher.mjs';
import { sanitiseCaseState, activeCase, capabilityRows, resultsAnnex, reportHTML } from '../shared/case.mjs';

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
  osint-hub case plan <case.json>      Plan a case exported from the workbench (/case)
  osint-hub case run <case.json>       Run its command-line tools here, and capture what they return
  osint-hub case fetch <case.json>     Fetch its search-link tools here, and keep the pages that came back
  osint-hub case agent <case.json>     Render them in your installed browser, so JavaScript-only tools answer too
  osint-hub case report <case.json>    Rebuild the single-file report from what is in the output folder
  osint-hub update                     Refresh the cached data now

Filters for "tools":  --input <type>  --category <c>  --type <web|cli|...>  --passive  --free  --no-account
Options for "launch": --as <type>  pick the type yourself (e.g. --as company)
                      --active     include tools that contact the target
                      --open       open the links in your browser
Options for "commands": --as <type>  --active  --docker (use Docker images where available)
                      --shell <posix|powershell> (default: powershell on Windows, posix elsewhere)
                      --plain (commands only, one per line)
Options for "case run": --yes (no prompt)  --dry-run (plan only)  --safe / --no-safe (default: as exported
                      from the workbench)  --only a,b  --input <type>  --timeout <seconds>  --out <dir>
                      --force (run even when the tool is not installed)
                      --write-back (also save a case file with what ran, for /case)
Options for "case fetch": --yes  --dry-run (list the pages)  --limit <n>  --delay <ms between requests>
                      --only a,b  --input <type>  --timeout <seconds>  --out <dir>
Options for "case agent": --yes  --dry-run (list the pages)  --limit <n>  --delay <ms between pages>
                      --settle <ms to wait after load, default 2500>  --only a,b  --input <type>
                      --timeout <seconds per page>  --port <devtools port>  --out <dir>
Options for any command: --data <tools.json>  use a local copy of the API instead of downloading it
Global options:       --json  --no-color  --api <base-url>

Every "case" run writes one file — <case>/report.html — holding the plan, every capable tool, what ran, what was
fetched and what you recorded. Your values never leave your machine except to the tools you run or fetch.
"case run" executes the generated commands here and "case fetch" requests the search pages here, both under your
own connection, your own accounts and your own API keys: osint-hub itself never runs or fetches a tool for you.`;

// ---- Arguments ----
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) positional.push(a);
  else if (['--input', '--category', '--type', '--as', '--value', '--api', '--shell', '--only', '--out', '--timeout', '--data', '--limit', '--delay', '--settle', '--port'].includes(a)) flags[a.slice(2)] = argv[++i];
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

/** The tools index, either downloaded and cached or read from --data (which is also how the tests run offline). */
async function loadTools() {
  if (!flags.data) return load('tools');
  const local = JSON.parse(readFileSync(flags.data, 'utf8'));
  const tools = Array.isArray(local) ? local : local.tools;
  if (!Array.isArray(tools)) fail(`${flags.data} does not look like the tools.json from /api/tools.json`);
  if (!local.taxonomy) fail(`${flags.data} has no taxonomy; point --data at the file served by /api/tools.json`);
  return { tools, taxonomy: local.taxonomy, site: local.site ?? API };
}

const slugifyName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'case';

/** One question on the terminal, with the answer read from stdin. */
function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

/** Runs one generated command in the user's shell, capturing what it prints. The child gets no stdin, so a tool
 *  that asks a question fails instead of hanging the run. */
function runCommand(row, value, outDir, index, timeout, shell) {
  const file = join(outDir, 'runs', `${String(index).padStart(2, '0')}-${row.slug}.txt`);
  const started = Date.now();
  return new Promise((resolve) => {
    // The command was quoted for the shell that will run it: PowerShell needs to be invoked as the shell itself,
    // because `shell: true` would hand it to cmd.exe on Windows.
    const [cmd, args, opts] =
      shell === 'powershell'
        ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', row.command], {}]
        : [row.command, [], { shell: true }];
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout, ...opts });
    let stdout = '';
    let stderr = '';
    const keep = (text, chunk) => (text.length > 512_000 ? text : text + String(chunk));
    child.stdout.on('data', (chunk) => { stdout = keep(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = keep(stderr, chunk); });
    const finish = (result) => {
      const ms = Date.now() - started;
      writeFileSync(file, `# ${row.name} (${row.slug})\n# ${row.command}\n# exit ${result.exitCode ?? '-'} in ${ms} ms\n\n${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`);
      resolve({ value: value.value, type: value.type, slug: row.slug, name: row.name, command: row.command, ms, file, ...result });
    };
    child.on('error', (e) => finish({ status: 'failed', note: e.message }));
    child.on('close', (code, signal) =>
      finish({
        status: code === 0 ? 'ok' : 'failed',
        exitCode: code,
        ...(signal ? { note: `killed (${signal})` } : {}),
      }),
    );
  });
}

// ---- The tools that live at a URL ------------------------------------------------------------------------
// A browser is not allowed to read another site's response, so the website can only open these links. Your machine
// can read them, so the CLI requests the search page the plan already built and keeps what came back.

const UA = 'Mozilla/5.0 (compatible; osint-hub-cli/1.0; +https://osinthub.pages.dev)';

/** A bot check dressed up as a page: it must not be counted as a result, whoever fetched it. */
const CHALLENGE = /just a moment|checking your browser|attention required|enable javascript and cookies|verify you are human|are you a robot|cf-browser-verification/i;

/** An error page served with a 200, common with proxies and CDNs. */
const ERROR_PAGE = /^\s*(4\d\d|5\d\d)\b|bad gateway|service unavailable|internal server error|access denied|site can.?t be reached/i;

/** ok, empty (nothing readable), blocked (bot protection) or failed (gone, broken, timeout). */
function classify({ http, text, title, challenged }) {
  if (http && (http === 403 || http === 429 || challenged)) return 'blocked';
  if (http && http >= 400) return 'failed';
  if (CHALLENGE.test(title ?? '') || CHALLENGE.test(String(text ?? '').slice(0, 400))) return 'blocked';
  if (ERROR_PAGE.test(title ?? '')) return 'failed';
  return String(text ?? '').length < 200 ? 'empty' : 'ok';
}

/** Readable text from a page, with scripts and markup stripped. */
function pageText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const decode = (s) => String(s ?? '').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Fetches one result page and keeps both the raw HTML and the readable text. */
async function fetchPage(row, value, outDir, index, timeout) {
  const base = { value: value.value, type: value.type, slug: row.slug, name: row.name, link: row.link };
  try {
    const res = await fetch(row.link, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    const body = res.ok ? (await res.text()).slice(0, 2_000_000) : '';
    res.body?.cancel?.().catch(() => {});
    const text = pageText(body);
    const title = decode((body.match(/<title[^>]*>([^<]*)</i)?.[1] ?? '').replace(/\s+/g, ' ').trim());
    const challenged = res.headers.has('cf-mitigated') || /cloudflare|ddos-guard/i.test(res.headers.get('server') ?? '');
    const file = body ? join(outDir, 'url-results', `${String(index).padStart(2, '0')}-${row.slug}.html`) : undefined;
    if (file) writeFileSync(file, body);
    const status = classify({ http: res.ok ? undefined : res.status, text, title, challenged });
    return { ...base, status, http: res.status, title, excerpt: text.slice(0, 2000), file };
  } catch (e) {
    return { ...base, status: 'failed', note: e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code ?? e.message) };
  }
}

/**
 * The one file: the plan, every capable tool, what the CLI ran, what it fetched, what the browser rendered, and
 * what was recorded. Results already in the output folder are picked up, so this can be rebuilt after any run.
 */
function writeReport({ theCase, plan, tools, outDir, safe, taxonomy }) {
  const readResults = (name) => {
    try {
      const path = join(outDir, name);
      if (!existsSync(path)) return [];
      const data = JSON.parse(readFileSync(path, 'utf8'));
      return Array.isArray(data) ? data : (data.results ?? []);
    } catch {
      return [];
    }
  };
  const runs = readResults('manifest.json');
  const fetches = readResults('fetch.json');
  const renders = readResults('agent.json');

  const sections = plan.map((p) => ({
    value: p.value.value,
    type: taxonomy.inputs[p.value.type] ?? p.value.type,
    via: p.value.via,
    guess: p.value.guess,
    note: p.value.note,
    rows: p.rows,
    runs: runs.filter((r) => r.value === p.value.value),
    fetches: fetches.filter((f) => f.value === p.value.value),
    renders: renders.filter((r) => r.value === p.value.value),
    findings: theCase.findings
      .filter((f) => f.valueId === p.value.id)
      .map((f) => ({
        name: tools.find((t) => t.slug === f.slug)?.name ?? f.slug,
        status: f.status,
        note: f.note,
        link: p.rows.find((r) => r.slug === f.slug)?.link,
      })),
  }));

  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, 'report.html');
  writeFileSync(file, reportHTML({ title: theCase.title, notes: theCase.notes, safe, sections }));
  return file;
}

// ---- The browser agent ------------------------------------------------------------------------------------
// Some tools only build their results in JavaScript, so a plain request sees an empty shell. A real browser
// renders them. This drives the browser that is already installed, headlessly, over the DevTools protocol, using
// nothing but what Node ships — no Playwright, no npm install, and a throwaway profile that is deleted after.

const BROWSER_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/microsoft-edge',
];

const findBrowser = () => BROWSER_PATHS.find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal DevTools-protocol client: one socket, sessions multiplexed by id. */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      } else this.handlers.forEach((h) => h(m));
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(fn) {
    this.handlers.push(fn);
  }
}

async function launchBrowser(port, timeoutMs) {
  const binary = findBrowser();
  const profile = join(tmpdir(), `osint-hub-agent-${Date.now()}`);
  mkdirSync(profile, { recursive: true });
  const child = spawn(
    binary,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--mute-audio',
      '--disable-background-networking',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const deadline = Date.now() + timeoutMs;
  let wsUrl;
  while (Date.now() < deadline && !wsUrl) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) wsUrl = (await res.json()).webSocketDebuggerUrl;
    } catch {
      // still starting
    }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) {
    child.kill();
    throw new Error(`${binary} did not open its debugging port on ${port}`);
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('could not attach to the browser')));
  });
  return { child, cdp: new CDP(ws), profile };
}

function closeBrowser({ child, cdp }) {
  try {
    cdp.ws.close();
  } catch {
    // already gone
  }
  try {
    child.kill();
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } catch {
    // already gone
  }
}

/** Opens one URL in a real browser, waits for it to settle, and keeps the visible text and a screenshot. */
async function renderPage(cdp, row, value, outDir, index, timeout, settle) {
  const base = { value: value.value, type: value.type, slug: row.slug, name: row.name, link: row.link };
  const shot = join(outDir, 'browser', `${String(index).padStart(2, '0')}-${row.slug}.png`);
  let sessionId;
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    const loaded = new Promise((resolve) => cdp.on((m) => m.method === 'Page.loadEventFired' && m.sessionId === sessionId && resolve()));
    await cdp.send('Page.navigate', { url: row.link }, sessionId);
    await Promise.race([loaded, sleep(timeout)]);
    await sleep(settle); // results often arrive after load

    const { result } = await cdp.send(
      'Runtime.evaluate',
      {
        expression: 'JSON.stringify({title: document.title || "", text: (document.body ? document.body.innerText : "") || ""})',
        returnByValue: true,
      },
      sessionId,
    );
    const { title, text } = JSON.parse(result.value);
    const clean = String(text).replace(/\s+/g, ' ').trim();
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(shot, Buffer.from(image.data, 'base64'));
    return {
      ...base,
      status: classify({ text: clean, title }),
      title: title.replace(/\s+/g, ' ').trim(),
      excerpt: clean.slice(0, 2000),
      screenshot: join('browser', `${String(index).padStart(2, '0')}-${row.slug}.png`),
    };
  } catch (e) {
    return { ...base, status: 'failed', note: e.name === 'TimeoutError' ? 'timeout' : e.message };
  } finally {
    if (sessionId) cdp.send('Target.closeTarget', { targetId: sessionId }).catch(() => {});
  }
}

// ---- Formatting ----
const badges = (t) =>
  [!t.passive && yellow('active'), t.account_required && dim('account'), t.cost !== 'free' && dim(t.cost), t.status === 'down' && red('down')]
    .filter(Boolean)
    .join(' ');

/** Program names that run a script you have to have checked out yourself. */
const INTERPRETERS = new Set(['python', 'python3', 'py', 'node', 'ruby', 'perl', 'php', 'bash', 'sh', 'pwsh', 'powershell', 'java']);

/** The full path of a program on PATH, or undefined. Nothing is executed: PATH is only read. */
function resolveProgram(program) {
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of extensions) {
      try {
        const full = join(dir, program + ext);
        if (existsSync(full)) return full;
      } catch {
        // An unreadable PATH entry is simply not a match.
      }
    }
  }
  return undefined;
}

/** Is `program` on PATH? */
function onPath(program) {
  return resolveProgram(program) !== undefined;
}

/** What this machine can actually run, so "nothing is installed" is visible before the plan rather than after. */
function machineSummary() {
  const runtimes = ['python', 'pip', 'pipx', 'node', 'go', 'docker', 'ruby', 'cargo', 'nmap', 'git'];
  const found = runtimes.filter(onPath);
  const missing = runtimes.filter((r) => !found.includes(r));
  return { found, missing };
}

/**
 * What a generated command needs before it can run here. Nothing is executed: PATH is only read.
 *
 *   ready       the program is on this machine
 *   local-file  it starts with an interpreter and the tool's own script (`python sublist3r.py`), so having
 *               Python proves nothing — the tool still has to be cloned
 *   missing     there is no such program on PATH
 */
/**
 * What a generated command needs before it can run here. Nothing is executed: PATH is only read.
 *
 *   ready          the program is on this machine (and `path` says which file, so a program that merely
 *                  shares a name with the tool — Python's httpx is not ProjectDiscovery's httpx — is visible)
 *   needs-package  it calls an interpreter with a module (`python3 -m social-analyzer`), so the interpreter
 *                  being present proves nothing about the module
 *   needs-files    it runs an interpreter over the tool's own script (`python sublist3r.py`), so the tool still
 *                  has to be cloned
 *   missing        there is no such program on PATH
 */
function readiness(command) {
  const parts = command.trim().split(/\s+/);
  const program = parts[0]?.replace(/^['"]|['"]$/g, '') ?? '';
  const second = (parts[1] ?? '').replace(/^['"]|['"]$/g, '');
  if (program.startsWith('./') || program.startsWith('.\\')) return { state: 'needs-files', program };
  if (INTERPRETERS.has(program.toLowerCase())) {
    if (second === '-m') return { state: 'needs-package', program };
    if (/\.(py|sh|js|rb|pl|php|jar)$/i.test(second)) return { state: 'needs-files', program };
  }
  const path = resolveProgram(program);
  return { state: path ? 'ready' : 'missing', program, path };
}

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

  if (command === 'case') {
    const [action, file] = rest;
    if (!['plan', 'run', 'fetch', 'agent', 'report'].includes(action)) {
      fail('usage: osint-hub case plan|run|fetch|agent|report <case.json> [--yes --safe --only a,b --input email --out DIR]');
    }
    if (!file) fail('point at the JSON backup exported from the workbench: /case → Back up (JSON).');
    if (!existsSync(file)) fail(`no such file: ${file}`);

    // A backup is untrusted input: it is reduced to the documented shape before anything reads it.
    let state;
    try {
      state = sanitiseCaseState(JSON.parse(readFileSync(file, 'utf8')));
    } catch (e) {
      return fail(`${file} is not valid JSON (${e.message}).`);
    }
    const theCase = activeCase(state);
    const { tools, taxonomy } = await loadTools();
    const order = Object.keys(taxonomy.categories);
    const shell = flags.shell ?? (process.platform === 'win32' ? 'powershell' : 'posix');
    if (!(shell in SHELLS)) fail(`unknown shell "${shell}"; use ${Object.keys(SHELLS).join(' or ')}`);
    // The workbench saves the case's safe-mode setting for a reason, so it applies here too: --safe forces it on,
    // --no-safe forces it off, and otherwise the exported case decides.
    const safe = flags['no-safe'] ? false : flags.safe === true || theCase.safe === true;
    const only = flags.only ? String(flags.only).split(',').map((s) => s.trim()).filter(Boolean) : [];

    const plan = theCase.values
      .filter((v) => !flags.input || v.type === flags.input)
      .map((v) => {
        const rows = capabilityRows(tools, v.type, v.value, { safe, shell, order });
        const runnable = rows
          .filter((r) => r.kind === 'command' && r.command && (!only.length || only.includes(r.slug)))
          .map((r) => ({ ...r, readiness: readiness(r.command) }));
        return { value: v, rows, runnable };
      });

    const totalCommands = plan.reduce((n, p) => n + p.runnable.length, 0);
    const ready = plan.reduce((n, p) => n + p.runnable.filter((r) => r.readiness.state === 'ready').length, 0);
    const outDir = flags.out ?? `osint-hub-${slugifyName(theCase.title)}`;

    if (flags.json && action === 'plan') {
      return json({
        case: theCase.title,
        shell,
        safe,
        plan: plan.map((p) => ({
          value: p.value.value,
          type: p.value.type,
          capable: p.rows.length,
          links: p.rows.filter((r) => r.link).length,
          commands: p.runnable.map((r) => ({ tool: r.slug, name: r.name, command: r.command, install: r.install, account: r.account })),
        })),
      });
    }

    if (action === 'plan' || (action === 'run' && flags['dry-run'])) {
      const machine = machineSummary();
      out(`${bold(theCase.title)} ${dim(`· ${plan.length} identifier${plan.length === 1 ? '' : 's'} · ${totalCommands} command${totalCommands === 1 ? '' : 's'} · ${ready} ready to run here`)}`);
      out(dim(`shell ${shell}${safe ? ' · safe mode: nothing that contacts the target, nothing needing an account' : ''}`));
      out(dim(`this machine has: ${machine.found.join(', ') || 'nothing the tools need'}${machine.missing.length ? ` · missing: ${machine.missing.join(', ')}` : ''}`));
      out(dim('tools install with pipx (Python), go install (Go), or Docker; the line under each command says which'));
      out('');
      if (totalCommands && !ready) {
        out(yellow('  None of these tools are installed yet — install them with the line under each command.'));
        out('');
      }
      for (const p of plan) {
        out(`${bold(p.value.value)} ${dim(`(${taxonomy.inputs[p.value.type] ?? p.value.type})`)}`);
        out(dim(`  ${p.rows.length} tools can take this value · ${p.runnable.length} with a command · ${p.rows.filter((r) => r.link).length} with a search link`));
        for (const r of p.runnable) {
          const state =
            r.readiness.state === 'ready'
              ? `${green('installed')} ${dim(r.readiness.path)}`
              : dim(
                  `${r.readiness.state === 'needs-package' ? 'needs its package' : r.readiness.state === 'needs-files' ? 'needs its own files' : 'not installed'}` +
                    `${r.install ? ` — ${r.install}` : ''}${r.account ? ' · needs an account' : ''}`,
                );
          out(`    ${r.name.padEnd(26)} ${state}`);
          out(`      ${r.command}`);
        }
        if (!p.runnable.length) out(dim('    no command-line tool here; open the search links in the workbench'));
        out('');
      }
      if (totalCommands && !flags['dry-run']) out(dim(`Run them: ${bold(`npm run cli -- case run "${file}" --data ${flags.data ?? '<tools.json>'}${safe ? ' --safe' : ''}`)}`));
      return;
    }

    // ---- fetch: the tools that live at a URL ----
    if (action === 'fetch') {
      const targets = plan.flatMap((p) =>
        p.rows.filter((r) => r.kind === 'link' && r.link && (!only.length || only.includes(r.slug))).map((r) => ({ value: p.value, row: r })),
      );
      const accountSkipped = targets.filter((t) => t.row.account).length;
      const list = targets.filter((t) => !t.row.account).slice(0, Number(flags.limit ?? 500));

      if (!list.length) return out(dim('Nothing to fetch: no tool with a verified search link takes these values.'));
      if (flags['dry-run']) {
        out(`${bold(theCase.title)} ${dim(`· would fetch ${list.length} page${list.length === 1 ? '' : 's'}`)}`);
        for (const t of list) out(`  ${t.row.name.padEnd(26)} ${dim(t.row.link)}`);
        return;
      }
      out(`${bold(theCase.title)} ${dim(`· fetching ${list.length} result page${list.length === 1 ? '' : 's'} from your connection`)}`);
      out(dim('each request goes from your IP to that site, and some sites do not allow automated access'));
      if (!flags.yes) {
        if (!process.stdin.isTTY) fail('there is no terminal to confirm on: add --yes to fetch unattended, or --dry-run to only list the pages.');
        const answer = (await ask(`  Fetch ${list.length} page${list.length === 1 ? '' : 's'}? [y/N] `)).trim().toLowerCase();
        if (answer !== 'y' && answer !== 'yes') return out(dim('Nothing fetched.'));
      }

      mkdirSync(join(outDir, 'url-results'), { recursive: true });
      const results = [];
      const delay = Number(flags.delay ?? 400);
      for (const t of list) {
        const result = await fetchPage(t.row, t.value, outDir, results.length + 1, Number(flags.timeout ?? 30) * 1000);
        results.push(result);
        if (!flags.json) {
          const mark = result.status === 'ok' ? green('ok') : result.status === 'blocked' ? yellow('blocked') : red(result.status);
          out(`  ${mark.padEnd(3)} ${result.name.padEnd(24)} ${dim(result.title || result.note || result.link || '')}`);
        }
        if (delay) await new Promise((r) => setTimeout(r, delay));
      }

      writeFileSync(join(outDir, 'fetch.json'), JSON.stringify({ case: theCase.title, fetched: new Date().toISOString(), safe, outDir, results }, null, 2));
      const report = writeReport({ theCase, plan, tools, outDir, safe, taxonomy });
      const okPages = results.filter((f) => f.status === 'ok').length;
      if (flags.json) return json({ case: theCase.title, outDir, report, results });
      out(`\n${bold(`${okPages}/${results.length} pages returned readable text`)} ${dim(`· raw pages in ${outDir}/url-results/`)}`);
      if (accountSkipped) out(dim(`${accountSkipped} tool${accountSkipped === 1 ? '' : 's'} skipped: they need an account, so the page would only be a login form.`));
      out(dim('Blocked and empty pages are normal: many sites block bots, and JavaScript-only ones return a shell.'));
      out(`${green('One file with everything:')} ${report}`);
      return;
    }

    // ---- agent: the same pages, rendered in your own browser ----
    if (action === 'agent') {
      const targets = plan.flatMap((p) =>
        p.rows.filter((r) => r.kind === 'link' && r.link && (!only.length || only.includes(r.slug))).map((r) => ({ value: p.value, row: r })),
      );
      const accountSkipped = targets.filter((t) => t.row.account).length;
      const list = targets.filter((t) => !t.row.account).slice(0, Number(flags.limit ?? 60));
      const binary = findBrowser();

      if (!binary) fail('no Chrome or Edge found. The agent drives the browser you already have; install one, or use "case fetch" for the plain-request version.');
      if (!list.length) return out(dim('Nothing to render: no tool with a verified search link takes these values.'));
      if (flags['dry-run']) {
        out(`${bold(theCase.title)} ${dim(`· would render ${list.length} page${list.length === 1 ? '' : 's'} in ${binary}`)}`);
        for (const t of list) out(`  ${t.row.name.padEnd(26)} ${dim(t.row.link)}`);
        return;
      }
      out(`${bold(theCase.title)} ${dim(`· rendering ${list.length} page${list.length === 1 ? '' : 's'} in a headless browser`)}`);
      out(dim(`${binary}`));
      out(dim('a real browser makes these requests from your IP, and some sites will still block or demand a login'));
      if (!flags.yes) {
        if (!process.stdin.isTTY) fail('there is no terminal to confirm on: add --yes to run unattended, or --dry-run to list the pages.');
        const answer = (await ask(`  Render ${list.length} page${list.length === 1 ? '' : 's'}? [y/N] `)).trim().toLowerCase();
        if (answer !== 'y' && answer !== 'yes') return out(dim('Nothing rendered.'));
      }

      mkdirSync(join(outDir, 'browser'), { recursive: true });
      const results = [];
      const delay = Number(flags.delay ?? 300);
      const settle = Number(flags.settle ?? 2500);
      let browser;
      try {
        browser = await launchBrowser(Number(flags.port ?? 9333), 20_000);
      } catch (e) {
        return fail(`could not start the browser: ${e.message}`);
      }
      try {
        for (const t of list) {
          const result = await renderPage(browser.cdp, t.row, t.value, outDir, results.length + 1, Number(flags.timeout ?? 30) * 1000, settle);
          results.push(result);
          if (!flags.json) {
            const mark = result.status === 'ok' ? green('ok') : result.status === 'empty' ? yellow('empty') : red(result.status);
            out(`  ${mark.padEnd(3)} ${result.name.padEnd(24)} ${dim(result.title || result.excerpt?.slice(0, 60) || result.note || '')}`);
          }
          if (delay) await sleep(delay);
        }
      } finally {
        closeBrowser(browser);
      }

      writeFileSync(join(outDir, 'agent.json'), JSON.stringify({ case: theCase.title, rendered: new Date().toISOString(), safe, outDir, results }, null, 2));
      const report = writeReport({ theCase, plan, tools, outDir, safe, taxonomy });
      const okPages = results.filter((f) => f.status === 'ok').length;
      if (flags.json) return json({ case: theCase.title, outDir, report, results });
      out(`\n${bold(`${okPages}/${results.length} pages rendered readable text`)} ${dim(`· screenshots in ${outDir}/browser/`)}`);
      if (accountSkipped) out(dim(`${accountSkipped} tool${accountSkipped === 1 ? '' : 's'} skipped: they need an account, so the page would only be a login form.`));
      out(dim('A page that renders nothing readable is usually a login wall or a bot check.'));
      out(`${green('One file with everything:')} ${report}`);
      return;
    }

    // ---- report: rebuild the single file from whatever is already in the output folder ----
    if (action === 'report') {
      const report = writeReport({ theCase, plan, tools, outDir, safe, taxonomy });
      return out(`${green('wrote')} ${report}`);
    }

    // ---- run ----
    if (!totalCommands) return out(dim('Nothing to run: no command-line tool in this plan takes these values.'));
    if (!ready && !flags.force) {
      fail(`none of the ${totalCommands} commands has its tool installed yet, so every one would fail. The plan prints an install line under each; add --force to run them regardless.`);
    }
    if (!flags.yes && !process.stdin.isTTY) fail('there is no terminal to confirm on: add --yes to run the commands unattended, or --dry-run to only see the plan.');

    // With --json the progress lines are held back, so the output stays machine-readable.
    const say = (s = '') => { if (!flags.json) out(s); };
    mkdirSync(join(outDir, 'runs'), { recursive: true });
    say(`${bold(theCase.title)} ${dim(`· running ${totalCommands} command${totalCommands === 1 ? '' : 's'} with ${shell} → ${outDir}/`)}\n`);

    const results = [];
    let runAll = !!flags.yes;
    let stopped = false;
    for (const p of plan) {
      for (const row of p.runnable) {
        if (stopped) break;
        if (!runAll && !flags.json) {
          const answer = (await ask(`  ${bold(row.name)}${row.readiness.state === 'ready' ? '' : red(` (${row.readiness.state === 'needs-package' ? 'needs its package' : row.readiness.state === 'needs-files' ? 'needs its own files' : 'not installed'})`)}: ${dim(row.command)}\n  Run it? [y]es / [n]o / [a]ll / [q]uit `)).trim().toLowerCase();
          if (answer === 'q') { stopped = true; break; }
          if (answer === 'a') runAll = true;
          else if (answer !== 'y' && answer !== 'yes') {
            results.push({ value: p.value.value, type: p.value.type, slug: row.slug, name: row.name, command: row.command, status: 'skipped', note: 'you said no' });
            say(dim(`  skipped ${row.name}`));
            continue;
          }
        }
        const result = await runCommand(row, p.value, outDir, results.length + 1, Number(flags.timeout ?? 300) * 1000, shell);
        results.push(result);
        say(`  ${result.status === 'ok' ? green('ok') : red('failed')} ${row.name} ${dim(`→ ${result.file}`)}`);
      }
      if (stopped) break;
    }

    const annex = resultsAnnex({ title: theCase.title, shell: SHELLS[shell], results });
    writeFileSync(join(outDir, 'annex.md'), annex);
    writeFileSync(
      join(outDir, 'manifest.json'),
      JSON.stringify({ case: theCase.title, ran: new Date().toISOString(), shell, safe, outDir, results }, null, 2),
    );
    const report = writeReport({ theCase, plan, tools, outDir, safe, taxonomy });

    // Optionally hand the workbench back a case where everything that ran cleanly is marked as run. A command
    // that could not start (not installed, timed out) is not recorded as if it had produced anything.
    if (flags['write-back']) {
      const ran = new Set(results.filter((r) => r.status === 'ok').map((r) => `${r.value}\u0000${r.slug}`));
      for (const v of theCase.values) {
        for (const row of capabilityRows(tools, v.type, v.value, { safe, shell, order })) {
          if (!ran.has(`${v.value}\u0000${row.slug}`)) continue;
          if (theCase.findings.some((f) => f.valueId === v.id && f.slug === row.slug)) continue; // never overwrite what the investigator recorded
          theCase.findings.push({ valueId: v.id, slug: row.slug, status: 'ran', note: 'run locally', at: new Date().toISOString() });
        }
      }
      const back = join(outDir, 'case-with-findings.json');
      writeFileSync(back, JSON.stringify({ ...state, activeId: theCase.id }, null, 2));
      say(dim(`\nCase file with these marked as run: ${back}`));
    }

    const ok = results.filter((r) => r.status === 'ok').length;
    if (flags.json) return json({ case: theCase.title, shell, safe, outDir, annex: join(outDir, 'annex.md'), report, results });
    out(`\n${bold(`${ok}/${results.length} exited cleanly`)} ${dim(`· output in ${outDir}/runs/`)}`);
    if (ready < totalCommands) out(dim(`${totalCommands - ready} command${totalCommands - ready === 1 ? '' : 's'} had no tool installed; the plan lists what to install.`));
    out(dim(`Annex to paste into the dossier: ${join(outDir, 'annex.md')}`));
    out(`${green('One file with everything:')} ${report}`);
    return;
  }

  fail(`unknown command "${command}". Run osint-hub --help`);
}

main().catch((e) => fail(e.message));
