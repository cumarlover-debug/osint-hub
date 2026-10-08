#!/usr/bin/env node
// osint-hub CLI: search the directory, turn a value into search links, and read playbooks from the terminal.
// No dependencies. Data comes from https://osinthub.pages.dev/api/*.json and is cached for a day.
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { detect, launchable, templatesFor, applies, buildLink, commandsFor, SHELLS, MATCH_LABELS } from '../shared/launcher.mjs';
import { sanitiseCaseState, activeCase, capabilityRows, resultsAnnex, reportHTML, splitByHand, emptyCaseState, uid } from '../shared/case.mjs';
import { extractFindings } from '../shared/extract.mjs';
import { matchIntents, resolveTask, taskProgress } from '../shared/tasks.mjs';
import { commandBinary, parseRemote, probeBinaries, remoteScript, runnerArgv } from '../shared/remote.mjs';
import { emptyProfile, addFindings, profileCounts, profileByKind, toolsRunFor, pivotCandidates, dossierMarkdown, PROFILE_VERSION } from '../shared/profile.mjs';

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
  osint-hub case plan <case.json>      Plan a case exported from the workbench (/case), or made with "case new"
  osint-hub case new "<title>"         Start a case without the workbench: --value <id>[,<id>] [--basis "<authority>"]
  osint-hub case run <case.json>       Run its command-line tools here, and capture what they return
  osint-hub case fetch <case.json>     Fetch its search-link tools here, and keep the pages that came back
  osint-hub case agent <case.json>     Render them in your installed browser, so JavaScript-only tools answer too
  osint-hub case report <case.json>    Rebuild the single-file report from what is in the output folder
  osint-hub agent profile <case.json>  Read everything the case collected into a target profile, and write the dossier
  osint-hub agent next <case.json>     The same, plus what is left to run, what needs installing and what needs a person
  osint-hub agent run <case.json>      Do that work: run and fetch the unattended jobs, and fold each result into the profile
  osint-hub agent hands <case.json>    Try the services that answer only a form: fill the box, submit, read the answer
  osint-hub agent task add "<words>" <case.json>   Assign work in your own words, and see how it is read
  osint-hub agent task list <case.json>            The assigned tasks and how much of each has been tried
  osint-hub agent task done|rm <id> <case.json>    Close or drop a task
  osint-hub agent run <case.json> --task <id>      Do one assigned task's work instead of everything
  osint-hub update                     Refresh the cached data now

Filters for "tools":  --input <type>  --category <c>  --type <web|cli|...>  --passive  --free  --no-account
Options for "launch": --as <type>  pick the type yourself (e.g. --as company)
                      --active     include tools that contact the target
                      --open       open the links in your browser
Options for "commands": --as <type>  --active  --docker (use Docker images where available)
                      --shell <posix|powershell> (default: powershell on Windows, posix elsewhere)
                      --plain (commands only, one per line)
Options for "case run": --remote <ssh-host|wsl:distro> runs the tools on that machine, where the command-line
                      tools are actually installed, e.g. --remote wsl:kali-linux for a Kali distro on this
                      computer or --remote osint-kali for one over ssh. Readiness is checked there, and the
                      same flag works for "agent run" and "agent next"
                      --yes (no prompt)  --dry-run (plan only)  --safe / --no-safe (default: as exported
                      from the workbench)  --only a,b  --input <type>  --timeout <seconds>  --out <dir>
                      --extra "slug=arguments" (add flags to one tool, e.g. --extra "maigret=--tags dating";
                      repeatable)  --force (run even when the tool is not installed)
                      --write-back (also save a case file with what ran, for /case)
Options for "case fetch": --yes  --dry-run (list the pages)  --limit <n>  --delay <ms between requests>
                      --only a,b  --input <type>  --timeout <seconds>  --out <dir>
Options for "case agent": --yes  --show (run the browser visibly, which passes more bot checks)  --dry-run
                      --limit <n>  --delay <ms between pages>  --settle <ms to wait after load, default 2500>
                      --only a,b  --input <type>  --timeout <seconds per page>  --port <devtools port>  --out <dir>
Options for any command: --data <tools.json>  use a local copy of the API instead of downloading itGlobal options:       --json  --no-color  --api <base-url>

Every "case" run writes one file — <case>/report.html — holding the plan, every capable tool, what ran, what was
fetched and what you recorded. Your values never leave your machine except to the tools you run or fetch.
"case run" executes the generated commands here and "case fetch" requests the search pages here, both under your
own connection, your own accounts and your own API keys: osint-hub itself never runs or fetches a tool for you.`;

// ---- Arguments ----
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
const repeatable = ['--extra'];
// Switches that mean "yes" rather than "the next word is my value". Everything else that starts with -- and is
// followed by something that is not another flag is read as taking a value, because forgetting to list an option here
// has silently turned "--max 0" into "--max" (= true, a budget of one) three times now.
const SWITCHES = ['--yes', '--safe', '--no-safe', '--json', '--passive', '--free', '--no-account', '--open', '--active', '--docker', '--plain', '--dry-run', '--show', '--strict', '--include-manual', '--stale', '--help', '--version', '--live'];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) positional.push(a);
  else if (repeatable.includes(a)) {
    const key = a.slice(2);
    flags[key] = [...(flags[key] ?? []), argv[++i]];
  } else if (a.includes('=')) {
    // --key=value, unambiguous whatever the key is.
    const at = a.indexOf('=');
    flags[a.slice(2, at)] = a.slice(at + 1);
  } else if (SWITCHES.includes(a) || (argv[i + 1] ?? '').startsWith('--')) {
    flags[a.slice(2)] = true;
  } else {
    flags[a.slice(2)] = argv[++i];
  }
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
function runCommand(row, value, outDir, index, timeout, shell, live = false, remote) {
  const file = join(outDir, 'runs', `${String(index).padStart(2, '0')}-${row.slug}.txt`);
  const started = Date.now();
  return new Promise((resolve) => {
    // The command was quoted for the shell that will run it: PowerShell needs to be invoked as the shell itself,
    // because `shell: true` would hand it to cmd.exe on Windows.
    // A command sent to another machine is a script on that machine's stdin: `bash -s` means the command text is data
    // rather than something either shell re-parses. Its own `timeout` bounds the tool, because killing ssh here does
    // not reliably kill what it started there.
    const remoteArgv = remote ? runnerArgv(remote) : null;
    const [cmd, args, opts, stdinScript] = remote
      ? [remoteArgv[0], remoteArgv.slice(1), {}, remoteScript(row.command, { timeoutSeconds: Math.ceil(timeout / 1000) })]
      : shell === 'powershell'
        ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', row.command], {}]
        : [row.command, [], { shell: true }];
    const child = spawn(cmd, args, {
      stdio: [stdinScript ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      // A tool that retries, waits or spawns helpers keeps its own process group on POSIX, so the whole tree can be
      // stopped at the deadline. Without this, killing the shell left the real process running: instaloader was told
      // by Instagram to retry in 666 seconds and outlived a 20 minute timeout by two and a half minutes.
      detached: process.platform !== 'win32',
      ...opts,
    });
    if (stdinScript) child.stdin.end(stdinScript);
    let timedOut = false;
    const killTree = () => {
      if (process.platform === 'win32') {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
        } catch {
          child.kill();
        }
        return;
      }
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    };
    const alarm = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeout);
    alarm.unref?.();
    let stdout = '';
    let stderr = '';
    const keep = (text, chunk) => (text.length > 512_000 ? text : text + String(chunk));
    // A tool like maigret runs for minutes. Staying silent until it exits makes the whole run look hung, so the
    // output is echoed as it arrives while still being captured for the report.
    child.stdout.on('data', (chunk) => {
      stdout = keep(stdout, chunk);
      if (live) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = keep(stderr, chunk);
      if (live) process.stderr.write(chunk);
    });
    const finish = (result) => {
      clearTimeout(alarm);
      const ms = Date.now() - started;
      const full = `${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`;
      writeFileSync(file, `# ${row.name} (${row.slug})\n# ${row.command}\n# exit ${result.exitCode ?? '-'} in ${ms} ms\n\n${full}`);
      // The output itself travels with the result, so the report can show it inline instead of a path the reader
      // has to go and open. Long output is trimmed here; the untrimmed text stays in the file beside it.
      const inline = full.slice(0, 60_000);
      resolve({
        value: value.value,
        type: value.type,
        slug: row.slug,
        name: row.name,
        command: row.command,
        ms,
        file,
        ...(inline && { output: inline }),
        ...(full.length > inline.length && { truncated: true }),
        ...result,
      });
    };
    child.on('error', (e) => finish({ status: 'failed', note: e.message }));
    child.on('close', (code, signal) =>
      finish({
        status: code === 0 ? 'ok' : 'failed',
        exitCode: code,
        // Say what actually happened: a tool stopped at the deadline is waiting or being rate limited, which is a
        // different finding from a tool that crashed.
        ...(timedOut
          ? { note: `timed out after ${Math.round(timeout / 1000)}s` }
          : signal
            ? { note: `killed (${signal})` }
            : {}),
      }),
    );
  });
}

// ---- The tools that live at a URL ------------------------------------------------------------------------
// A browser is not allowed to read another site's response, so the website can only open these links. Your machine
// can read them, so the CLI requests the search page the plan already built and keeps what came back.

const UA = 'Mozilla/5.0 (compatible; osint-hub-cli/1.0; +https://osinthub.pages.dev)';

/** A bot check dressed up as a page: it must not be counted as a result, whoever fetched it. */
const CHALLENGE = /just a moment|checking your browser|attention required|enable javascript and cookies|verify you are human|are you a robot|cf-browser-verification|datadome|px-captcha|perimeterx|incapsula|kasada|_pxhd|access denied|automated traffic is not allowed|unusual traffic|access blocked/i;

/** An error page served with a 200, common with proxies and CDNs. */
const ERROR_PAGE = /^\s*(4\d\d|5\d\d)\b|bad gateway|service unavailable|internal server error|site can.?t be reached/i;

/** A page shell that only JavaScript can fill: an empty mount point plus a bundle to run in it. */
const JS_SHELL = /id="(root|app|__next)"|__NEXT_DATA__|data-reactroot|window\.__NUXT__|ng-app/i;

/** ok, empty (nothing readable), needs-js (a shell a browser would fill in), blocked (bot protection) or failed. */
function classify({ http, text, title, challenged, html }) {
  if (http && (http === 403 || http === 429 || challenged)) return 'blocked';
  if (http && http >= 400) return 'failed';
  if (CHALLENGE.test(title ?? '') || CHALLENGE.test(String(text ?? '').slice(0, 400))) return 'blocked';
  if (ERROR_PAGE.test(title ?? '')) return 'failed';
  if (String(text ?? '').length >= 200) return 'ok';
  // A short page that carries a JavaScript mount point is not empty, it is unfinished without a browser.
  if (JS_SHELL.test(String(html ?? ''))) return 'needs-js';
  return 'empty';
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
    const status = classify({ http: res.ok ? undefined : res.status, text, title, challenged, html: body });
    // A page that only a browser can finish is worth naming as such: it tells the reader to try case agent
    // rather than leaving them to conclude the site had nothing.
    const note = status === 'needs-js' ? 'JavaScript-only: try case agent on it' : undefined;
    return { ...base, status, http: res.status, title, excerpt: text.slice(0, 2000), file, ...(note && { note }) };
  } catch (e) {
    return { ...base, status: 'failed', note: e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code ?? e.message) };
  }
}

/**
 * Writes a results file, keeping what an earlier run of the same kind already recorded. Tools have to be run from
 * different working directories (a `python blackbird.py` command only resolves in its own folder), and without this
 * each run would erase the previous one's findings from the report. A tool run again replaces its own entry.
 */
function mergeResults(file, results, meta) {
  const key = (r) => `${r.value}\u0000${r.slug}`;
  let existing = [];
  try {
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      existing = Array.isArray(data) ? data : (data.results ?? []);
    }
  } catch {
    // A corrupt results file is not worth failing a run over; it is replaced.
  }
  const merged = new Map(existing.map((r) => [key(r), r]));
  for (const r of results) merged.set(key(r), r);
  writeFileSync(file, JSON.stringify({ ...meta, results: [...merged.values()] }, null, 2));
  return { kept: [...merged.keys()].length - results.length, total: merged.size };
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
  /**
   * Results recorded before the output started travelling with them only carry a file path. Read the file back so
   * an earlier run still shows its output in the report rather than sending the reader off to open it.
   */
  const withOutput = (r) => {
    if (r.output !== undefined || !r.file) return r;
    try {
      const text = readFileSync(r.file, 'utf8');
      const inline = text.slice(0, 60_000);
      return { ...r, output: inline, ...(text.length > inline.length && { truncated: true }) };
    } catch {
      return r;
    }
  };

  const runs = readResults('manifest.json').map(withOutput);
  const fetches = readResults('fetch.json');
  const renders = readResults('agent.json');

  const sections = plan.map((p) => ({
    value: p.value.value,
    type: taxonomy.inputs[p.value.type] ?? p.value.type,
    via: p.value.via,
    guess: p.value.guess,
    note: p.value.note,
    rows: p.rows,
    // Tools a request cannot get anything from: the report turns these into a to-do list with their links.
    manual: p.rows.filter((r) => r.manual),
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
  // Absolute, so a run started from the wrong folder is obvious instead of quietly writing somewhere else.
  return resolve(file);
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
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

const findBrowser = () => BROWSER_PATHS.find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Root is the norm inside a Kali VM, and Chromium refuses to start its sandbox as root. */
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

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

async function launchBrowser(port, timeoutMs, show = false) {
  const binary = findBrowser();
  const profile = join(tmpdir(), `osint-hub-agent-${Date.now()}`);
  mkdirSync(profile, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--disable-background-networking',
  ];
  // Headless is faster and leaves the desktop alone, but plenty of sites treat it as a bot on sight. --show is a
  // real window, which gets past more of them and lets you watch what is being asked.
  if (show) args.push('--new-window', '--window-size=1280,900');
  else args.push('--headless=new', '--disable-gpu');
  // VMs usually give /dev/shm far less room than Chromium expects, and Kali is normally used as root, where the
  // sandbox refuses to start at all. Both would look like "the browser never came up".
  if (process.platform === 'linux') args.push('--disable-dev-shm-usage');
  if (isRoot) args.push('--no-sandbox', '--disable-setuid-sandbox');
  args.push('about:blank');
  const child = spawn(binary, args, { stdio: 'ignore' });

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

    // A bot check clears after load, then the real page paints. Reading the text once, straight after load, caught
    // the challenge instead of the results, so poll until the page stops changing — with `settle` as the ceiling.
    // The rendered markup comes back too: a page that only a browser can build is exactly the page whose links you
    // cannot get any other way, and saving the DOM lets them be read or grepped afterwards.
    const read = async () => {
      const { result } = await cdp.send(
        'Runtime.evaluate',
        {
          expression:
            'JSON.stringify({title: document.title || "", text: (document.body ? document.body.innerText : "") || "", html: document.documentElement ? document.documentElement.outerHTML : ""})',
          returnByValue: true,
        },
        sessionId,
      );
      const parsed = JSON.parse(result.value);
      return {
        title: String(parsed.title).replace(/\s+/g, ' ').trim(),
        text: String(parsed.text).replace(/\s+/g, ' ').trim(),
        html: String(parsed.html ?? ''),
      };
    };

    const deadline = Date.now() + Math.max(settle, 1000);
    let best = await read();
    while (Date.now() < deadline) {
      await sleep(400);
      const now = await read();
      if (now.text.length > best.text.length) best = now;
      // A bot check is stable while it verifies, so only stop early once the page has settled on something that is
      // not a challenge — otherwise the interesting content, the part after verification, is never seen.
      const held = CHALLENGE.test(now.title) || CHALLENGE.test(now.text.slice(0, 400));
      if (!held && now.text === best.text && now.text.length > 0) break;
    }

    // A page can also hold its content behind a consent gate or below the fold, and then a passive browser sees the
    // application shell rather than the application. start.me is both: its widgets are painted by a client-side app
    // that waits on a cookie-consent banner. So when a page has settled on almost nothing, answer the obvious gate
    // and walk to the bottom once, which is what a person would do.
    if (!CHALLENGE.test(best.title) && best.text.length < 600) {
      const clicked = await cdp.send(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const words = /^(accept|accept all|agree|i agree|allow all|allow|consent|ok|okay|got it|continue)$/i;
            const nodes = [...document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]')];
            const hit = nodes.find((n) => words.test((n.innerText || n.textContent || n.value || '').trim()));
            if (!hit) return '';
            hit.click();
            return (hit.innerText || hit.textContent || hit.value || '').trim();
          })()`,
          returnByValue: true,
        },
        sessionId,
      );
      await sleep(1500);
      for (let step = 1; step <= 10; step++) {
        await cdp.send('Runtime.evaluate', { expression: `window.scrollTo(0, document.body.scrollHeight * ${step / 10})`, returnByValue: true }, sessionId);
        await sleep(350);
        const now = await read();
        if (now.text.length > best.text.length) best = now;
      }
      // Late widgets arrive after the scroll that triggered them, so give them one more window to land.
      const extra = Date.now() + Math.min(Math.max(settle, 4000), 15000);
      while (Date.now() < extra) {
        await sleep(500);
        const now = await read();
        if (now.text.length > best.text.length) best = now;
      }
      const answered = String(clicked.result?.value ?? '').trim();
      if (answered && !flags.json) out(dim(`  answered a consent gate ("${answered}") and scrolled the page`));
    }

    const image = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(shot, Buffer.from(image.data, 'base64'));
    // The DOM is written next to the screenshot only when it holds something the text does not: links to other
    // sites. A page of prose is already in the report; a page of links is not.
    let dom;
    if (best.html && (best.html.match(/href="https?:\/\//g) ?? []).length > 5) {
      dom = join('browser', `${String(index).padStart(2, '0')}-${row.slug}.html`);
      writeFileSync(join(outDir, dom), best.html);
    }
    return {
      ...base,
      status: classify({ text: best.text, title: best.title }),
      title: best.title,
      excerpt: best.text.slice(0, 2000),
      screenshot: join('browser', `${String(index).padStart(2, '0')}-${row.slug}.png`),
      ...(dom && { dom }),
    };
  } catch (e) {
    return { ...base, status: 'failed', note: e.name === 'TimeoutError' ? 'timeout' : e.message };
  } finally {
    if (sessionId) cdp.send('Target.closeTarget', { targetId: sessionId }).catch(() => {});
  }
}

// ---- Driving the services that answer only a form -------------------------------------------------------
// Everything else in the agent either runs a command or requests a URL. A third of the directory cannot be reached
// that way: the service wants a form filled in and submitted, and until now that was left entirely to a person. The
// agent can do the typing and the reading; what it cannot do is solve a captcha or sign in, and it says so plainly
// rather than pretending the attempt failed for another reason.

/** Injected into the page: dismiss an obvious consent gate, find the search box, type the value, submit. */
const formFillScript = (value) => `(() => {
  const out = { filled: false, submitted: false, how: '', what: '', note: '' };
  const visible = (el) => {
    if (!el || el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    return r.width > 8 && r.height > 8 && getComputedStyle(el).visibility !== 'hidden';
  };
  const consent = /^(accept|accept all|agree|i agree|allow all|allow|consent|got it|continue|ok|okay)$/i;
  for (const b of document.querySelectorAll('button, [role="button"]')) {
    if (visible(b) && consent.test((b.innerText || b.textContent || '').trim())) { b.click(); out.note = 'answered a consent gate'; break; }
  }
  const score = (el) => {
    const t = (el.type || '').toLowerCase();
    const s = ((el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
    let n = 0;
    if (['search', 'email', 'text', 'tel', 'url'].includes(t)) n += 2;
    if (/search|query|lookup|email|phone|username|domain|url|name|target|handle/.test(s)) n += 4;
    if (/captcha|newsletter|zip|postal|card/.test(s)) n -= 6;
    if (el.tagName === 'TEXTAREA') n -= 1;
    return n;
  };
  const fields = [...document.querySelectorAll('input, textarea')].filter(visible).map((el) => [score(el), el]).sort((a, b) => b[0] - a[0]);
  const field = fields.length ? fields[0][1] : null;
  if (!field || fields[0][0] < 0) { out.note = (out.note ? out.note + '; ' : '') + 'no search box found'; return out; }
  const label = (field.name || field.id || field.placeholder || field.type || 'field').toString().slice(0, 40);
  try {
    const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(field, ${JSON.stringify(value)});
  } catch { field.value = ${JSON.stringify(value)}; }
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  field.focus();
  out.filled = true;
  out.what = 'typed into "' + label + '"';
  const submit = [...document.querySelectorAll('button, input[type=submit], [role=button], a.button')]
    .filter(visible)
    .find((b) => /search|look ?up|check|find|look|go|submit|scan|track/i.test((b.innerText || b.value || b.textContent || '')));
  if (submit) { submit.click(); out.submitted = true; out.how = 'button'; }
  else {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      field.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
    if (field.form && typeof field.form.requestSubmit === 'function') { try { field.form.requestSubmit(); out.how = 'form'; } catch { out.how = 'enter'; } }
    else out.how = 'enter';
    out.submitted = true;
  }
  return out;
})()`;

/**
 * Drives one form-driven service: open it, type the value, submit, and read what comes back.
 *
 * @returns the same shape as renderPage, plus `attempt` describing what was done, so the report can say whether a
 *          wall was reached or whether the page simply had nothing to fill in.
 */
async function driveForm(cdp, row, toolUrl, value, outDir, index, timeout, settle) {
  const target = row.link ?? toolUrl;
  const base = { value: value.value, type: value.type, slug: row.slug, name: row.name, link: target, byhand: true };
  const shot = join(outDir, 'browser', `${String(index).padStart(2, '0')}-${row.slug}-byhand.png`);
  let sessionId;
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    const loaded = new Promise((resolve) => cdp.on((m) => m.method === 'Page.loadEventFired' && m.sessionId === sessionId && resolve()));
    await cdp.send('Page.navigate', { url: target }, sessionId);
    await Promise.race([loaded, sleep(timeout)]);
    await sleep(1500); // let a client-side app boot before hunting for its search box

    const read = async () => {
      const { result } = await cdp.send(
        'Runtime.evaluate',
        {
          expression:
            'JSON.stringify({title: document.title || "", text: (document.body ? document.body.innerText : "") || "", html: document.documentElement ? document.documentElement.outerHTML : ""})',
          returnByValue: true,
        },
        sessionId,
      );
      const parsed = JSON.parse(result.value);
      return {
        title: String(parsed.title).replace(/\s+/g, ' ').trim(),
        // Horizontal whitespace is tidied but newlines are kept: the finding extractor reads line by line, and
        // collapsing the page into one long line meant a certificate search's hostnames were never picked up.
        text: String(parsed.text)
          .replace(/[^\S\n]+/g, ' ')
          .replace(/\n{2,}/g, '\n')
          .trim(),
        html: String(parsed.html ?? ''),
      };
    };

    const before = await read();
    const fill = await cdp.send('Runtime.evaluate', { expression: formFillScript(value.value), returnByValue: true }, sessionId);
    const attempt = fill.result?.value ?? {};

    // Wait for the answer, not for any change. A cookie banner, a spinner or a "Loading…" label all change the page
    // and none of them is the result, which is how a search that did work came back looking empty. Growth in the
    // text or in the links is what a rendered answer looks like, so the loop waits for that and then for it to stop
    // growing, rather than leaving the moment something moves.
    const deadline = Date.now() + Math.max(settle, 4000);
    const beforeLinks = (before.html.match(/href="https?:/g) ?? []).length;
    let best = before;
    let stable = 0;
    let grew = false;
    await sleep(1200); // a floor, so the first read is not taken mid-submit
    while (Date.now() < deadline) {
      const now = await read();
      const links = (now.html.match(/href="https?:/g) ?? []).length;
      if (now.text.length > before.text.length + 300 || links > beforeLinks + 3) grew = true;
      if (now.text.length > best.text.length) {
        best = now;
        stable = 0;
      } else {
        stable += 1;
      }
      if (CHALLENGE.test(now.title) || CHALLENGE.test(now.text.slice(0, 400))) break;
      // Two quiet reads after real growth means the page has finished; without growth there is nothing to wait for.
      if (grew && stable >= 2) break;
      if (!grew && Date.now() > deadline - 800) break;
      await sleep(600);
    }

    const image = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(shot, Buffer.from(image.data, 'base64'));

    let dom;
    if (best.html && (best.html.match(/href="https?:\/\//g) ?? []).length > 5) {
      dom = join('browser', `${String(index).padStart(2, '0')}-${row.slug}-byhand.html`);
      writeFileSync(join(outDir, dom), best.html);
    }

    const challenged = CHALLENGE.test(best.title) || CHALLENGE.test(best.text.slice(0, 400));
    const status = challenged ? 'blocked' : classify({ text: best.text, title: best.title });
    const bits = [attempt.note, attempt.what, attempt.submitted ? `submitted with ${attempt.how}` : 'could not submit'].filter(Boolean);
    const note = challenged
      ? `still a bot check after submitting — this one needs a person${bits.length ? ` (${bits.join('; ')})` : ''}`
      : bits.join('; ') || 'nothing to fill in';

    return {
      ...base,
      status,
      title: best.title,
      excerpt: best.text.slice(0, 2000),
      screenshot: join('browser', `${String(index).padStart(2, '0')}-${row.slug}-byhand.png`),
      note,
      formFill: { filled: !!attempt.filled, submitted: !!attempt.submitted, how: attempt.how || '' },
      ...(dom && { dom }),
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
function readiness(command, has) {
  const parts = command.trim().split(/\s+/);
  const program = parts[0]?.replace(/^['"]|['"]$/g, '') ?? '';
  const second = (parts[1] ?? '').replace(/^['"]|['"]$/g, '');
  if (program.startsWith('./') || program.startsWith('.\\')) return { state: 'needs-files', program };
  if (INTERPRETERS.has(program.toLowerCase())) {
    if (second === '-m') return { state: 'needs-package', program };
    if (/\.(py|sh|js|rb|pl|php|jar)$/i.test(second)) return { state: 'needs-files', program };
  }
  // Where a tool lives is a question for the machine that will run it: locally that is this PATH, and remotely it is
  // what the caller probed over ssh.
  if (has) return { state: has(program) ? 'ready' : 'missing', program };
  const path = resolveProgram(program);
  return { state: path ? 'ready' : 'missing', program, path };
}

/**
 * Readiness on the machine that will run the commands. One connection answers it for every tool, and a machine that
 * does not answer stops the run rather than looking like one with nothing installed.
 */
async function remoteReady(remote, commands, json) {
  const binaries = commands.map((command) => commandBinary(command)).filter(Boolean);
  let spec;
  try {
    spec = parseRemote(remote);
  } catch (e) {
    return fail(e.message);
  }
  const probe = await probeBinaries(remote, binaries);
  if (!probe.ok) {
    const hint =
      spec.kind === 'wsl'
        ? 'Is the distro installed and does it start? Check with: wsl -l -v'
        : 'Check the machine is running and that the host name matches your ssh config.';
    fail(`cannot reach ${spec.label} (${spec.kind === 'wsl' ? 'WSL' : 'ssh'}): ${probe.error}\n  the tools run there, so nothing can be planned until it answers. ${hint}`);
  }
  if (!json) out(dim(`commands run on ${remote} \u00b7 ${probe.bins.size} of ${new Set(binaries).size} tools found there`));
  return (program) => probe.bins.has(program);
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

  // ---- agent: read what the case already collected, build the profile, and say what to do next ----
  if (command === 'agent') {
    const [action, ...args] = rest;
    // Task subcommands read as sentences, so they take their own shape: agent task add "<what to find>" <case.json>.
    const taskSub = action === 'task' ? args[0] : undefined;
    const file = action === 'task' ? (taskSub === 'list' ? args[1] : args[2]) : args[0];
    if (!['next', 'profile', 'run', 'hands', 'task'].includes(action)) {
      fail('usage: osint-hub agent next|profile|run|hands <case.json> [--yes --max N --seconds S --only a,b --out DIR]');
    }
    if (action === 'task' && !['add', 'list', 'done', 'rm'].includes(taskSub)) {
      fail('usage: osint-hub agent task add "<what to find>" <case.json> | list <case.json> | done <id> <case.json> | rm <id> <case.json>');
    }
    if (!file) fail('point at the JSON backup exported from the workbench: /case → Back up (JSON).');
    if (!existsSync(file)) fail(`no such file: ${file}`);

    let state;
    try {
      state = sanitiseCaseState(JSON.parse(readFileSync(file, 'utf8')));
    } catch (e) {
      return fail(`${file} is not valid JSON (${e.message}).`);
    }
    const theCase = activeCase(state);
    const { tools, taxonomy } = await loadTools();
    const order = Object.keys(taxonomy.categories);
    let shell = flags.shell ?? (process.platform === 'win32' ? 'powershell' : 'posix');
    // --remote runs the tools on the machine that has them, so the command forms must be that machine's.
    const remote = typeof flags.remote === 'string' ? flags.remote : undefined;
    if (remote && shell !== 'posix') shell = 'posix';
    if (!(shell in SHELLS)) fail(`unknown shell "${shell}"; use ${Object.keys(SHELLS).join(' or ')}`);
    const safe = flags['no-safe'] ? false : flags.safe === true || theCase.safe === true;
    const outDir = flags.out ?? `osint-hub-${slugifyName(theCase.title)}`;
    mkdirSync(outDir, { recursive: true });
    const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

    // Read whatever the case folder already holds. Run files carry a four-line header; the rest is the tool's own
    // output, which is what the extractor wants.
    const readJson = (name) => {
      try {
        return JSON.parse(readFileSync(join(outDir, name), 'utf8'));
      } catch {
        return null;
      }
    };
    const runText = (file) => {
      try {
        const text = readFileSync(file, 'utf8');
        return text.startsWith('# ') ? text.split('\n').slice(4).join('\n') : text;
      } catch {
        return '';
      }
    };

    const profilePath = join(outDir, 'profile.json');
    let profile = readJson('profile.json');
    if (!profile || profile.version !== PROFILE_VERSION) profile = emptyProfile(theCase.title, theCase.notes);

    let ingested = 0;
    let findings = 0;
    const ingest = (results, source) => {
      for (const r of results ?? []) {
        const text = source === 'command' ? runText(r.file ?? '') : (r.output ?? r.excerpt ?? '');
        if (!text) continue;
        const found = extractFindings({ slug: r.slug, name: r.name, text, value: r.value, at: r.at, source });
        addFindings(profile, {
          value: r.value,
          valueType: r.type,
          tool: r.name ?? r.slug,
          slug: r.slug,
          status: r.status,
          findings: found,
          at: r.at,
          source,
        });
        ingested += 1;
        findings += found.length;
      }
    };
    ingest(readJson('manifest.json')?.results, 'command');
    ingest(readJson('fetch.json')?.results, 'page');
    ingest(readJson('agent.json')?.results, 'render');
    profile.updated = new Date().toISOString().slice(0, 10);
    writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);

    // ---- what is left to do, per identifier ----
    const plan = theCase.values.map((v) => {
      const rows = capabilityRows(tools, v.type, v.value, { safe, shell, order });
      const done = toolsRunFor(profile, v.value);
      const fresh = rows.filter((r) => !done.has(r.slug));
      return {
        v,
        rows,
        done: rows.filter((r) => done.has(r.slug)).length,
        canRun: fresh.filter((r) => r.kind === 'command' && r.command && !r.manual).map((r) => ({ ...r })),
        canFetch: fresh.filter((r) => r.kind === 'link' && r.link && !r.manual),
        byHand: fresh.filter((r) => r.manual),
        links: fresh.filter((r) => r.kind === 'link' && r.link && !r.manual).length,
      };
    });

    // Readiness is a question for whichever machine will run these, asked once for all of them.
    {
      const has = remote ? await remoteReady(remote, plan.flatMap((p) => p.canRun.map((r) => r.command)), !!flags.json) : undefined;
      for (const p of plan) for (const r of p.canRun) r.readiness = has ? readiness(r.command, has) : readiness(r.command);
    }

    // ---- assigned tasks: the investigator's own words, mapped to the directory ----
    const tasksPath = join(outDir, 'tasks.json');
    const tasksFile = readJson('tasks.json') ?? { case: theCase.title, tasks: [] };
    const saveTasks = () => writeFileSync(tasksPath, `${JSON.stringify(tasksFile, null, 2)}\n`);

    // --task narrows everything that follows - the plan, the run, the by-hand work - to one assigned piece of work.
    let activeTask;
    if (flags.task) {
      activeTask = tasksFile.tasks.find((t) => t.id === flags.task);
      if (!activeTask) fail(`no task "${flags.task}" in ${tasksPath} — agent task list ${file}`);
      const slugs = new Set(activeTask.slugs ?? []);
      const wanted = new Set(activeTask.values ?? []);
      for (const p of plan) {
        p.canRun = p.canRun.filter((r) => slugs.has(r.slug));
        p.canFetch = p.canFetch.filter((r) => slugs.has(r.slug));
        p.byHand = p.byHand.filter((r) => slugs.has(r.slug));
        if (wanted.size && !wanted.has(p.v.value)) {
          p.canRun = [];
          p.canFetch = [];
          p.byHand = [];
        }
      }
      if (!flags.json && action !== 'profile') out(dim(`task ${activeTask.id}: ${activeTask.text}`));
    }

    // ---- run: do the unattended work, one job at a time, folding each result into the profile as it lands ----
    // This is the loop the rest of the agent exists for: plan, execute, read the result, update the profile, and
    // stop on a budget. A command that is not installed, or a service that needs a person, is not attempted here -
    // those are reported instead, because a run that wastes its budget on walls is worse than no run.
    const runSummary = { attempted: 0, ok: 0, other: 0, fetched: 0, findings: 0, stopped: '' };
    if (action === 'run') {
      const budget = Number(flags.max ?? 12);
      const seconds = Number(flags.seconds ?? 600);
      const deadline = Date.now() + seconds * 1000;
      const only = flags.only ? String(flags.only).split(',').map((s) => s.trim()).filter(Boolean) : [];
      const queue = [];
      for (const p of plan) {
        for (const r of p.canRun) {
          if (r.readiness.state !== 'ready') continue;
          if (only.length && !only.includes(r.slug)) continue;
          queue.push({ value: p.v, row: r, how: 'run' });
        }
        for (const r of p.canFetch) {
          if (only.length && !only.includes(r.slug)) continue;
          queue.push({ value: p.v, row: r, how: 'fetch' });
        }
      }

      if (!queue.length) {
        if (!flags.json) out(dim('Nothing unattended left to do: install a tool, turn safe mode off, or work the by-hand list.'));
      } else {
        if (!flags.json) {
          out(`${bold(theCase.title)} ${dim(`· ${queue.length} unattended job${queue.length === 1 ? '' : 's'} queued (budget ${budget} tools, ${seconds}s)`)}`);
          out(dim('every job is a request from your connection to that site; add --yes to run them without asking'));
        }
        if (!flags.yes && !process.stdin.isTTY && budget > 0) fail('there is no terminal to confirm on: add --yes to run these unattended, or --max 0 to only plan.');
        // The runners write into these, so they have to exist before the first job starts.
        mkdirSync(join(outDir, 'runs'), { recursive: true });
        mkdirSync(join(outDir, 'url-results'), { recursive: true });
        let runAll = !!flags.yes;
        // Numbering continues from what is already there, so a resumed run does not overwrite earlier output.
        let index = (readJson('manifest.json')?.results?.length ?? 0) + 1;
        for (const job of queue) {
          if (runSummary.attempted >= budget) {
            runSummary.stopped = `budget of ${budget} tools reached`;
            break;
          }
          if (Date.now() > deadline) {
            runSummary.stopped = `time budget of ${seconds}s reached`;
            break;
          }
          if (!runAll) {
            const answer = (await ask(`  ${job.how === 'run' ? 'run' : 'fetch'} ${bold(job.row.name)} for ${job.value.value}? [y]es / [n]o / [a]ll / [q]uit `)).trim().toLowerCase();
            if (answer === 'q') {
              runSummary.stopped = 'you stopped it';
              break;
            }
            if (answer === 'a') runAll = true;
            else if (answer !== 'y' && answer !== 'yes') continue;
          }

          const result =
            job.how === 'run'
              ? await runCommand(job.row, job.value, outDir, index, Number(flags.timeout ?? 300) * 1000, shell, !flags.json, remote)
              : await fetchPage(job.row, job.value, outDir, index, Number(flags.timeout ?? 60) * 1000);
          index += 1;
          runSummary.attempted += 1;
          if (result.status === 'ok') runSummary.ok += 1;
          else runSummary.other += 1;
          if (job.how === 'fetch') runSummary.fetched += 1;

          // Saved straight away, so an interrupted run keeps everything it had already collected.
          const target = join(outDir, job.how === 'run' ? 'manifest.json' : 'fetch.json');
          mergeResults(target, [result], {
            case: theCase.title,
            ...(job.how === 'run' ? { ran: new Date().toISOString(), shell } : { fetched: new Date().toISOString() }),
            safe,
            outDir,
          });

          const text = job.how === 'run' ? runText(result.file ?? '') : (result.excerpt ?? '');
          const found = extractFindings({ slug: result.slug, name: result.name, text, value: result.value, at: result.at, source: job.how === 'run' ? 'command' : 'page' });
          addFindings(profile, {
            value: result.value,
            valueType: job.value.type,
            tool: result.name ?? result.slug,
            slug: result.slug,
            status: result.status,
            findings: found,
            at: new Date().toISOString(),
            source: job.how === 'run' ? 'command' : 'page',
          });
          runSummary.findings += found.length;
          writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);

          if (!flags.json) {
            out(`  ${result.status === 'ok' ? green('ok') : yellow(result.status)} ${job.row.name} ${dim(`→ ${found.length} finding${found.length === 1 ? '' : 's'}`)}`);
          }
        }
      }
    }

    // ---- assigned tasks: the investigator's own words, mapped to the directory ----
    const nextTaskId = () => `t${Math.max(0, ...tasksFile.tasks.map((t) => Number(String(t.id).replace(/\D/g, '')) || 0)) + 1}`;
    if (action === 'task') {
      if (taskSub === 'add') {
        const text = args[1];
        if (!text) fail('say what the task is: osint-hub agent task add "find accounts for this username" <case.json>');
        const resolved = resolveTask({ text, values: theCase.values, tools, taxonomy, shell, safe, order });
        const slugs = [...new Set(resolved.perValue.flatMap((p) => p.rows).map((r) => r.slug))];
        const task = {
          id: nextTaskId(),
          text,
          at: new Date().toISOString(),
          status: 'open',
          intents: resolved.intents.map((i) => i.id),
          intentsLabel: resolved.intents.map((i) => i.label),
          values: resolved.values,
          slugs,
          counts: resolved.counts,
          ...(resolved.unplaced && { unplaced: resolved.unplaced }),
        };
        tasksFile.tasks.push(task);
        saveTasks();
        if (flags.json) return json({ task, path: tasksPath });
        out(`${bold(`Task ${task.id}`)} ${dim('·')} ${text}`);
        if (!resolved.matched) {
          out(yellow('  nothing in that sentence maps to a family of work'));
          out(dim('  the agent proposes no tools rather than guessing: name what to look for (accounts, breaches,'));
          out(dim('  infrastructure, identity, documents, places, crypto, transport, phones) or say "everything"'));
        } else {
          out(`  reading it as: ${bold(resolved.intents.map((i) => i.label).join(' + '))}`);
          out(`  about: ${resolved.values.map((v) => bold(v)).join(', ') || dim('no values in the case yet')}`);
          out(`  ${resolved.counts.tools} tools (${resolved.counts.runnable} runnable, ${resolved.counts.fetchable} fetchable, ${resolved.counts.byHand} by hand)`);
          if (resolved.unplaced) out(dim(`  could not place: "${resolved.unplaced}"`));
          out(dim(`  saved to ${tasksPath} — run it with: agent run ${file} --task ${task.id}`));
        }
        return;
      }

      const find = (id) => tasksFile.tasks.find((t) => t.id === id);
      if (taskSub === 'list') {
        if (flags.json) return json({ tasks: tasksFile.tasks.map((t) => ({ ...t, progress: taskProgress(t, profile) })), path: tasksPath });
        if (!tasksFile.tasks.length) return out(dim('No tasks assigned yet: agent task add "find accounts for this username" <case.json>'));
        out(`${bold(theCase.title)} ${dim(`· ${tasksFile.tasks.length} task${tasksFile.tasks.length === 1 ? '' : 's'}`)}`);
        for (const t of tasksFile.tasks) {
          const p = taskProgress(t, profile);
          const mark = t.status === 'done' ? green('done') : p.done ? yellow('started') : dim('open');
          out(`  ${mark.padEnd(3)} ${bold(t.id)} ${t.text}`);
          out(dim(`      ${(t.intentsLabel ?? []).join(' + ') || 'unmapped'} · ${t.values.join(', ')} · ${p.done}/${p.total} tried${p.left ? ` · ${p.left} left` : ''}`));
        }
        out(dim(`\n  run one with: agent run ${file} --task <id>`));
        return;
      }
      const id = args[1];
      const task = find(id);
      if (!task) fail(`no task "${id}" in ${tasksPath}`);
      if (taskSub === 'done') {
        task.status = 'done';
        task.closed = new Date().toISOString();
      } else if (taskSub === 'rm') {
        tasksFile.tasks = tasksFile.tasks.filter((t) => t.id !== id);
      }
      saveTasks();
      if (flags.json) return json({ task: taskSub === 'rm' ? { id } : task, path: tasksPath });
      return out(taskSub === 'rm' ? dim(`Removed task ${id}.`) : `${green('Done:')} ${task.text}`);
    }

    const gaps = [];
    // ---- hands: drive the services that answer only a form ----
    // Only the two reasons the agent can attempt: a form, and a form behind a bot check it might get past. A service
    // that wants a login or an API key is not attempted, because the agent holds no credentials and should not.
    const handsSummary = { attempted: 0, ok: 0, blocked: 0, other: 0, findings: 0, skipped: 0 };
    if (action === 'hands') {
      const only = flags.only ? String(flags.only).split(',').map((s) => s.trim()).filter(Boolean) : [];
      const bySlug = new Map(tools.map((t) => [t.slug, t]));
      const list = plan.flatMap((p) =>
        splitByHand(p.byHand)
          .attemptable.filter((r) => !only.length || only.includes(r.slug))
          .filter((r) => bySlug.get(r.slug)?.url)
          .map((r) => ({ value: p.v, row: r, toolUrl: bySlug.get(r.slug)?.url })),
      );
      handsSummary.skipped = plan.reduce((n, p) => n + splitByHand(p.byHand).humanOnly.length, 0);

      if (!list.length) {
        if (!flags.json) out(dim('No form-driven work for these values: nothing marked as a form, or everything already tried.'));
      } else {
        const budget = Number(flags.max ?? 6);
        const seconds = Number(flags.seconds ?? 300);
        const deadline = Date.now() + seconds * 1000;
        const settle = Number(flags.settle ?? 8000);
        if (!flags.json) {
          out(`${bold(theCase.title)} ${dim(`· ${list.length} form-driven service${list.length === 1 ? '' : 's'} to try (budget ${budget}, ${seconds}s)`)}`);
          out(dim('the agent fills the box and reads the answer; a captcha or a login will stop it, and it will say so'));
        }
        if (!flags.yes && !process.stdin.isTTY && budget > 0) fail('there is no terminal to confirm on: add --yes to try these unattended, or --max 0 to only plan.');
        if (budget <= 0 && !flags.json) out(dim('--max 0: planned only, nothing attempted'));
        mkdirSync(join(outDir, 'browser'), { recursive: true });
        let browser;
        if (budget > 0) {
          try {
            browser = await launchBrowser(Number(flags.port ?? 9333), 20_000, !!flags.show);
          } catch (e) {
            fail(`could not start the browser: ${e.message} — install Chrome or Edge, or use case fetch instead`);
          }
        }
        const hands = [];
        const delay = Number(flags.delay ?? 500);
        try {
          for (const job of list) {
            if (handsSummary.attempted >= budget) break;
            if (Date.now() > deadline) break;
            if (!flags.yes) {
              const answer = (await ask(`  try ${bold(job.row.name)} for ${job.value.value}? [y]es / [n]o / [q]uit `)).trim().toLowerCase();
              if (answer === 'q') break;
              if (answer !== 'y' && answer !== 'yes') continue;
            }
            handsSummary.attempted += 1;
            const result = await driveForm(browser.cdp, job.row, job.toolUrl, job.value, outDir, hands.length + 1, Number(flags.timeout ?? 35) * 1000, settle);
            hands.push(result);
            if (result.status === 'ok') handsSummary.ok += 1;
            else if (result.status === 'blocked') handsSummary.blocked += 1;
            else handsSummary.other += 1;

            // Kept in the rendered-pages file so the single report shows the attempt beside the pages it already
            // holds, and saved at once so an interrupted run keeps what it got.
            mergeResults(join(outDir, 'agent.json'), [result], { case: theCase.title, rendered: new Date().toISOString(), safe, outDir });
            const found = extractFindings({ slug: result.slug, name: result.name, text: result.excerpt ?? '', value: result.value, at: new Date().toISOString(), source: 'by-hand' });
            addFindings(profile, { value: result.value, valueType: job.value.type, tool: result.name ?? result.slug, slug: result.slug, status: result.status, findings: found, at: new Date().toISOString(), source: 'by-hand' });
            handsSummary.findings += found.length;
            writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);

            if (!flags.json) {
              const mark = result.status === 'ok' ? green('ok') : result.status === 'blocked' ? yellow('blocked') : red(result.status);
              out(`  ${mark.padEnd(3)} ${job.row.name.padEnd(24)} ${dim(result.note ?? '')}`);
            }
            if (delay) await sleep(delay);
          }
        } finally {
          if (browser) closeBrowser(browser);
        }
      }
    }

    for (const p of plan) {
      for (const r of p.canRun) if (r.readiness.state !== 'ready') gaps.push(`${r.name} (${p.v.value}) — ${r.readiness.state === 'needs-package' ? 'install its package' : r.readiness.state === 'needs-files' ? 'needs its own files' : 'not installed'}${r.install ? `: ${r.install}` : ''}`);
    }
    const manual = plan.flatMap((p) => p.byHand.slice(0, 6).map((r) => ({ name: r.name, link: r.link, why: r.manual === 'captcha' ? 'answers only after a captcha' : r.manual === 'post-form' ? 'answers only a submitted form' : r.manual === 'api-key' ? 'needs an API key' : r.manual === 'login' ? 'needs a logged-in session' : 'is an interactive console' })));
    const dossier = dossierMarkdown(profile, {
      gaps,
      manual,
      tasks: tasksFile.tasks.map((t) => ({ ...t, progress: taskProgress(t, profile) })),
    });
    writeFileSync(join(outDir, 'dossier.md'), dossier);

    // After a run the single-file report is rebuilt too, so the evidence and the profile stay in step. The report
    // expects plan entries shaped around a value, which is what the agent's plan already carries.
    const report = action === 'run' ? writeReport({ theCase, plan: plan.map((p) => ({ value: p.v, rows: p.rows })), tools, outDir, safe, taxonomy }) : undefined;

    const counts = profileCounts(profile);
    if (flags.json) {
      return json({
        case: theCase.title,
        outDir,
        profile: profilePath,
        dossier: join(outDir, 'dossier.md'),
        ...(report && { report }),
        counts,
        ...(action === 'run' && { run: runSummary }),
        plan: plan.map((p) => ({ value: p.v.value, type: p.v.type, done: p.done, canRun: p.canRun.length, canFetch: p.canFetch.length, byHand: p.byHand.length })),
      });
    }

    if (action === 'run' && runSummary.attempted) {
      out(`\n${bold(`${runSummary.ok}/${runSummary.attempted} finished cleanly`)} ${dim(`· ${runSummary.findings} findings folded into the profile${runSummary.stopped ? ` · stopped: ${runSummary.stopped}` : ''}`)}`);
      if (runSummary.other) out(yellow(`  ${runSummary.other} returned nothing readable — a wall, a login or an empty result, all recorded in the report`));
    } else if (action === 'run') {
      out(`\n${dim(runSummary.stopped ? `nothing run: ${runSummary.stopped}` : 'nothing run')}`);
    }

    if (action === 'hands') {
      if (handsSummary.attempted) {
        out(`\n${bold(`${handsSummary.ok}/${handsSummary.attempted} answered`)} ${dim(`· ${handsSummary.blocked} still a bot check · ${handsSummary.findings} findings folded into the profile`)}`);
        out(dim('  pages the agent could not get past are listed in the report with the reason, not counted as empty'));
      } else {
        out(`\n${dim('nothing attempted')}`);
      }
      if (handsSummary.skipped) out(dim(`  ${handsSummary.skipped} skipped on purpose: they need a login or an API key, and the agent holds no credentials`));
    }

    out(`${bold(theCase.title)} ${dim(`· ${counts.leads} leads from ${counts.toolsRun} tool runs`)}`);
    out(dim(`read ${ingested} results · ${findings} findings extracted${ingested ? '' : ' — nothing collected yet, run the case runners first'}`));
    out('');
    for (const [kind, list] of Object.entries(profileByKind(profile))) {
      out(`  ${String(list.length).padStart(4)}  ${kind}${list.length ? dim(`  (${list.slice(0, 3).map((e) => flat(e.value)).join(', ')}${list.length > 3 ? ', …' : ''})`) : ''}`);
    }
    if (!counts.leads) out(dim('  no leads yet'));
    out('');
    if (action === 'next') {
      for (const p of plan) {
        const ready = p.canRun.filter((r) => r.readiness.state === 'ready').length;
        out(`${bold(p.v.value)} ${dim(`(${taxonomy.inputs[p.v.type] ?? p.v.type})`)}`);
        out(dim(`  ${p.canRun.length} runnable (${ready} installed) · ${p.canFetch.length} fetchable · ${p.byHand.length} by hand · ${p.done} already done`));
        for (const r of p.canRun.slice(0, 6)) out(`    ${r.name.padEnd(26)} ${r.readiness.state === 'ready' ? green('ready') : dim(r.readiness.state)}`);
        if (p.canRun.length > 6) out(dim(`    …and ${p.canRun.length - 6} more`));
      }
    } else {
      const totals = plan.reduce((n, p) => ({ canRun: n.canRun + p.canRun.filter((r) => r.readiness.state === 'ready').length, canFetch: n.canFetch + p.canFetch.length, byHand: n.byHand + p.byHand.length }), { canRun: 0, canFetch: 0, byHand: 0 });
      out(dim(`${totals.canRun} runnable now · ${totals.canFetch} fetchable · ${totals.byHand} by hand  (agent next for the list)`));
    }
    const pivots = pivotCandidates(profile).slice(0, 8);
    if (pivots.length) {
      out(`\n${bold('Worth pivoting on')} ${dim('— found in the results, not yet treated as inputs')}`);
      for (const p of pivots) out(`  ${p.kind.padEnd(10)} ${p.value.slice(0, 60)} ${dim(`(${p.sources} source${p.sources === 1 ? '' : 's'})`)}`);
    }
    if (gaps.length) out(`\n${yellow(`${gaps.length} tools need installing before the agent can run them`)}`);
    if (manual.length) out(yellow(`${manual.length} have to be done by hand`));
    out(`\n${green('Profile:')} ${profilePath}\n${green('Dossier:')} ${join(outDir, 'dossier.md')}${report ? `\n${green('Report:')} ${report}` : ''}`);
    return;
  }

  if (command === 'case') {
    const [action, file] = rest;
    if (!['plan', 'run', 'fetch', 'agent', 'report', 'new'].includes(action)) {
      fail('usage: osint-hub case plan|run|fetch|agent|report <case.json> [--yes --safe --only a,b --input email --out DIR]\n       osint-hub case new "<title>" --value <identifier>[,<identifier>...] [--type <type>] [--basis "<authority>"]');
    }

    // Starting a case without the workbench. The browser is one way to make a case; a chat harness has no page to
    // export a backup from, and the agent is unusable without a case file to point at.
    if (action === 'new') {
      const title = file;
      if (!title) fail('name the case: osint-hub case new "Ada Lovelace" --value ada@example.org');
      const { taxonomy } = await loadTools();
      const raw = String(typeof flags.value === 'string' ? flags.value : '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!raw.length) fail('give it at least one thing to look into: --value ada@example.org,shiineslife,example.org');
      const forced = typeof flags.type === 'string' ? flags.type : undefined;
      if (forced && !taxonomy.inputs[forced]) fail(`unknown input type "${forced}"; one of: ${Object.keys(taxonomy.inputs).join(', ')}`);
      const values = raw.map((v) => ({ id: uid(), value: v, type: forced ?? detect(v)[0] ?? 'keyword' }));
      const state = emptyCaseState();
      const opened = state.cases[0];
      opened.title = title;
      opened.updated = new Date().toISOString();
      opened.values = values;
      // The basis is what makes the difference between an investigation and a fishing trip, so it is asked for here
      // and carried into every report the agent writes.
      if (typeof flags.basis === 'string') opened.notes = flags.basis;
      if (flags.safe === true) opened.safe = true;
      const path = typeof flags.out === 'string' ? flags.out : `osint-hub-${slugifyName(title)}.json`;
      writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);

      if (flags.json) return json({ case: path, title, values });
      out(`${bold(title)} ${dim('· new case')}`);
      for (const v of values) out(`  ${v.value.padEnd(34)} ${dim(taxonomy.inputs[v.type] ?? v.type)}`);
      out(dim(`\n  saved to ${path}`));
      if (opened.notes) out(dim(`  basis: ${opened.notes}`));
      else out(yellow('  no basis recorded — the dossier carries this line, and it should say who asked and on what authority'));
      out(`\n${bold('Next')}`);
      out(`  osint-hub agent task add "find accounts for this username" ${path}`);
      out(`  osint-hub agent run ${path} --yes --max 6`);
      out(`  osint-hub agent hands ${path} --yes --max 3`);
      return;
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
    let shell = flags.shell ?? (process.platform === 'win32' ? 'powershell' : 'posix');
    // --remote hands the commands to the machine that has the tools, whose shell forms are not this machine's.
    const remote = typeof flags.remote === 'string' ? flags.remote : undefined;
    if (remote && shell !== 'posix') shell = 'posix';
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
          // A tool marked "by hand" is never started automatically, even when it has a command: that marking is a
          // statement that a person has to drive it. --include-manual overrides.
          .filter((r) => r.kind === 'command' && r.command && (flags['include-manual'] || !r.manual) && (!only.length || only.includes(r.slug)))
          .map((r) => ({ ...r }));
        return { value: v, rows, runnable };
      });

    // One connection answers readiness for every command this case might run, on whichever machine will run them.
    {
      const has = remote
        ? await remoteReady(remote, plan.flatMap((p) => p.runnable.map((r) => r.command)), !!flags.json)
        : undefined;
      for (const p of plan) for (const r of p.runnable) r.readiness = has ? readiness(r.command, has) : readiness(r.command);
    }

    // --extra "slug=arguments" lets one tool run with flags the directory does not carry, so a narrower or deeper
    // pass still lands in the same report. The arguments are appended to the command the tool data already built.
    const extras = new Map();
    for (const raw of flags.extra ?? []) {
      const text = String(raw ?? '').trim();
      const eq = text.indexOf('=');
      if (eq < 1) fail(`--extra wants "slug=arguments", for example --extra "maigret=--tags dating" (got "${text}")`);
      extras.set(text.slice(0, eq).trim(), text.slice(eq + 1).trim());
    }
    const usedExtras = new Set();
    if (extras.size) {
      for (const p of plan) {
        p.runnable = p.runnable.map((r) => {
          const extra = extras.get(r.slug);
          if (!extra) return r;
          usedExtras.add(r.slug);
          return { ...r, command: `${r.command} ${extra}`, extra };
        });
      }
      for (const slug of extras.keys()) {
        if (!usedExtras.has(slug)) {
          // Not an error: the tool may simply not take these values, and the run should still happen.
          out(yellow(`  --extra for "${slug}" matched nothing in this plan — check the slug with case plan.`));
        }
      }
    }

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
        const byHand = p.rows.filter((r) => r.manual);
        if (byHand.length) {
          // Said plainly, because these will not appear in fetch or agent output and would otherwise look missing.
          out(yellow(`  ${byHand.length} have to be done by hand (${byHand.map((r) => r.name).slice(0, 5).join(', ')}${byHand.length > 5 ? ', …' : ''})`));
        }
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
      // Only mention --data when the run is actually using a local copy; printing a placeholder made people copy a
      // command that could not work.
      if (totalCommands && !flags['dry-run']) {
        const dataFlag = flags.data ? ` --data ${flags.data}` : '';
        out(dim(`Run them: ${bold(`npm run cli -- case run "${file}"${dataFlag}${safe ? ' --safe' : ''}`)}`));
      }
      return;
    }

    // ---- fetch: the tools that live at a URL ----
    if (action === 'fetch') {
      const targets = plan.flatMap((p) =>
        p.rows.filter((r) => r.kind === 'link' && r.link && (!only.length || only.includes(r.slug))).map((r) => ({ value: p.value, row: r })),
      );
      const accountSkipped = targets.filter((t) => t.row.account).length;
      // Tools that only answer a form, a captcha or a key are left for a human: a request gets a wall, and the
      // report lists them instead. --include-manual forces them through anyway.
      const manualSkipped = targets.filter((t) => t.row.manual || t.row.account).length;
      const eligible = targets.filter((t) => flags['include-manual'] || (!t.row.manual && !t.row.account));
      if (!eligible.length) {
        if (manualSkipped) out(dim(`Nothing to fetch: all ${manualSkipped} of these have to be done by hand. The report lists them.`));
        else out(dim('Nothing to fetch: no tool with a verified search link takes these values.'));
        return;
      }
      const list = eligible.slice(0, Number(flags.limit ?? 500));

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

      const merged = mergeResults(join(outDir, 'fetch.json'), results, { case: theCase.title, fetched: new Date().toISOString(), safe, outDir });
      const report = writeReport({ theCase, plan, tools, outDir, safe, taxonomy });
      const okPages = results.filter((f) => f.status === 'ok').length;
      if (flags.json) return json({ case: theCase.title, outDir, report, results });
      out(`\n${bold(`${okPages}/${results.length} pages returned readable text`)} ${dim(`· raw pages in ${outDir}/url-results/`)}`);
      if (accountSkipped) out(dim(`${accountSkipped} tool${accountSkipped === 1 ? '' : 's'} skipped: they need an account, so the page would only be a login form.`));
      if (manualSkipped) out(yellow(`  ${manualSkipped} skipped as manual: a form, a captcha or a key is what they answer, so a request gets a wall. The report lists them to do by hand.`));
      const needsJs = results.filter((f) => f.status === 'needs-js').length;
      if (needsJs) out(yellow(`  ${needsJs} of these build their content in JavaScript, so a plain request sees an empty shell. Run case agent to render them.`));
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
      const manualSkipped = targets.filter((t) => t.row.manual || t.row.account).length;
      const eligible = targets.filter((t) => flags['include-manual'] || (!t.row.manual && !t.row.account));
      const list = eligible.slice(0, Number(flags.limit ?? 60));
      const binary = findBrowser();

      if (!binary) fail('no Chrome or Edge found. The agent drives the browser you already have; install one, or use "case fetch" for the plain-request version.');
      if (!list.length) {
        if (manualSkipped) return out(dim(`Nothing to render: all ${manualSkipped} of these have to be done by hand. The report lists them.`));
        return out(dim('Nothing to render: no tool with a verified search link takes these values.'));
      }
      if (flags['dry-run']) {
        out(`${bold(theCase.title)} ${dim(`· would render ${list.length} page${list.length === 1 ? '' : 's'} in ${binary}`)}`);
        for (const t of list) out(`  ${t.row.name.padEnd(26)} ${dim(t.row.link)}`);
        return;
      }
      out(`${bold(theCase.title)} ${dim(`· rendering ${list.length} page${list.length === 1 ? '' : 's'} in ${flags.show ? 'a visible' : 'a headless'} browser`)}`);
      out(dim(`${binary}${flags.show ? ' — a window will open and close itself' : ''}`));
      if (isRoot) out(yellow('  running as root: the browser sandbox is off, which is what Kali needs but is not free'));
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
        browser = await launchBrowser(Number(flags.port ?? 9333), 20_000, !!flags.show);
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

      mergeResults(join(outDir, 'agent.json'), results, { case: theCase.title, rendered: new Date().toISOString(), safe, outDir });
      const report = writeReport({ theCase, plan, tools, outDir, safe, taxonomy });
      const okPages = results.filter((f) => f.status === 'ok').length;
      if (flags.json) return json({ case: theCase.title, outDir, report, results });
      out(`\n${bold(`${okPages}/${results.length} pages rendered readable text`)} ${dim(`· screenshots in ${outDir}/browser/`)}`);
      if (accountSkipped) out(dim(`${accountSkipped} tool${accountSkipped === 1 ? '' : 's'} skipped: they need an account, so the page would only be a login form.`));
      if (manualSkipped) out(yellow(`  ${manualSkipped} skipped as manual: a form, a captcha or a key is what they answer, so rendering them just shows a wall. The report lists them to do by hand.`));
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
    say(`${bold(theCase.title)} ${dim(`· running ${totalCommands} command${totalCommands === 1 ? '' : 's'} with ${shell} → ${resolve(outDir)}/`)}\n`);

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
        // Say what is starting before it starts, so a three-minute tool does not look like a hung one, and echo its
        // output as it arrives. Each result is also written to the manifest straight away, so an interrupted run
        // keeps everything it had already collected.
        say(`  ${dim('running')} ${bold(row.name)} ${dim(row.command)}`);
        const result = await runCommand(row, p.value, outDir, results.length + 1, Number(flags.timeout ?? 300) * 1000, shell, !flags.json, remote);
        results.push(result);
        mergeResults(join(outDir, 'manifest.json'), [result], { case: theCase.title, ran: new Date().toISOString(), shell, safe, outDir });
        say(`  ${result.status === 'ok' ? green('ok') : red('failed')} ${row.name} ${dim(`→ ${result.file}`)}\n`);
      }
      if (stopped) break;
    }

    const annex = resultsAnnex({ title: theCase.title, shell: SHELLS[shell], results });
    writeFileSync(join(outDir, 'annex.md'), annex);
    const merged = mergeResults(join(outDir, 'manifest.json'), results, { case: theCase.title, ran: new Date().toISOString(), shell, safe, outDir });
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
