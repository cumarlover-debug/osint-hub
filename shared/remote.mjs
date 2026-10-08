// Running the tools on the machine that has them.
//
// Most of this directory's command-line tools live in a Kali install, not on the desktop: the CLI runs where the
// person is, and the commands run where the tools are. Everything here is about that split - how a command is handed
// to another machine, how the remote shell is quoted, and how readiness is asked about once instead of a hundred
// times.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Run a script and read its output without ever asking Node for a pipe.
 *
 * A confined harness forbids named pipes, so `spawn` with `stdio: 'pipe'` fails with EPERM before the program starts -
 * which is what made the remote path unusable from inside one, however healthy the machine on the other end was. The
 * script goes to a file, the shell redirects the output to another file, and the answer is read with the filesystem.
 * Live output is polling that file rather than streaming a pipe.
 *
 * @returns {Promise<{code: number|null, text: string, timedOut: boolean}>}
 */
export function runViaFiles(commandLine, { timeoutMs = 60000, outPath, tmpDir = tmpdir(), live, spawnImpl = spawn } = {}) {
  const dir = mkdtempSync(join(tmpDir, 'osint-run-'));
  const scriptPath = join(dir, 'run.sh');
  const outFile = outPath ?? join(dir, 'out.txt');
  writeFileSync(scriptPath, String(commandLine.script ?? '').replace(/\r\n/g, '\n'));

  const quote = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const line = `${commandLine.argv.map(quote).join(' ')} < ${quote(scriptPath)} > ${quote(outFile)} 2>&1`;

  return new Promise((resolve) => {
    let child;
    try {
      // stdio ignored: the shell owns the redirection, so no pipe is created and nothing needs to be captured.
      child = spawnImpl(line, { shell: true, stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      return resolve({ code: null, text: '', timedOut: false, error: e.message });
    }

    let timedOut = false;
    let printed = 0;
    const poll = live
      ? setInterval(() => {
          try {
            const text = readFileSync(outFile, 'utf8');
            if (text.length > printed) {
              process.stdout.write(text.slice(printed));
              printed = text.length;
            }
          } catch {
            /* not written yet */
          }
        }, 700)
      : undefined;

    const killTree = () => {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };
    const alarm = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    alarm.unref?.();

    child.on('error', (e) => {
      clearTimeout(alarm);
      clearInterval(poll);
      rmSync(dir, { recursive: true, force: true });
      resolve({ code: null, text: '', timedOut, error: e.message });
    });

    child.on('close', (code) => {
      clearTimeout(alarm);
      clearInterval(poll);
      let text = '';
      try {
        text = readFileSync(outFile, 'utf8');
      } catch {
        /* the redirect file is only created once the shell starts */
      }
      // The output file may be the caller's own (the run log), so only the scratch directory is removed.
      if (!outPath) rmSync(dir, { recursive: true, force: true });
      resolve({ code, text, timedOut });
    });
  });
}

/** Options every ssh call gets. BatchMode means it fails instead of hanging on a password prompt. */
export const SSH_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
];

/** Wrap a string for a POSIX shell. Used for paths and binary names, never for a whole command. */
export const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * What the far side's shell is told before anything is looked up or run.
 *
 * A shell started for one command does not read ~/.zshrc or ~/.bashrc, so pipx, cargo and go binaries - which is how
 * most of this directory's tools are installed - would look missing on a machine that has them. Virtualenvs are the
 * other common home for them, and their bin directories are never on a non-login PATH, so every venv under ~/.venvs is
 * added too: a Kali box with the tools spread between pipx and a venv looks empty without this.
 */
export const REMOTE_PATH = [
  'export PATH="$HOME/.local/bin:$HOME/go/bin:$HOME/.cargo/bin:$PATH"',
  'for d in "$HOME"/.venvs/*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done',
].join('\n');

/**
 * Where a command is handed to. Two transports, because the machine that was configured years ago may not be the
 * machine that exists now: an ssh host, or a WSL distro on this same computer, which needs no network, no sshd and no
 * address that can go stale.
 */
export function parseRemote(spec) {
  const text = String(spec ?? '').trim();
  if (!text) throw new Error('no remote given');
  const wsl = text.match(/^wsl(?::(.*))?$/i);
  if (wsl) {
    const distro = (wsl[1] ?? '').trim() || undefined;
    return { kind: 'wsl', ...(distro && { distro }), label: distro ? `wsl:${distro}` : 'wsl' };
  }
  return { kind: 'ssh', host: text, label: text };
}

/**
 * The argv that runs a script on stdin on that runner.
 *
 * The command itself is never passed as an argument: `bash -s` reads the script from stdin, so a tool command
 * containing quotes, pipes or a stray newline is data rather than something a shell re-parses.
 */
export function runnerArgv(spec) {
  const r = typeof spec === 'string' ? parseRemote(spec) : spec;
  if (r.kind === 'wsl') return ['wsl.exe', ...(r.distro ? ['-d', r.distro] : []), '--', 'bash', '-s'];
  return ['ssh', ...SSH_OPTS, r.host, 'bash', '-s'];
}

/** The ssh invocation that runs a script on stdin. Kept for callers that already know they want ssh. */
export function sshArgv(host) {
  return runnerArgv({ kind: 'ssh', host });
}

/**
 * The script the remote shell runs: change directory if asked, bound the tool's own life with `timeout`, and pass its
 * exit code back. The local `timeout` covers ssh; this one covers the tool, because killing ssh does not reliably
 * kill what it started on the other side.
 */
export function remoteScript(command, { timeoutSeconds, cwd } = {}) {
  const lines = [REMOTE_PATH];
  if (cwd) lines.push(`cd ${shellQuote(cwd)} || exit 1`);
  const bounded = timeoutSeconds ? `timeout -k 5 ${Math.ceil(timeoutSeconds)}s ${command}` : command;
  lines.push(bounded);
  lines.push('exit $?');
  return `${lines.join('\n')}\n`;
}

/** The program a tool command actually runs, skipping a leading `cd … &&` that the command may open with. */
export function commandBinary(command) {
  const text = String(command ?? '').trim();
  const afterCd = text.replace(/^cd\s+[^&]+&&\s*/, '');
  const first = afterCd.split(/\s+/)[0] ?? '';
  return first.replace(/^['"]|['"]$/g, '');
}

/** Read the `binary=path` lines the probe prints. A binary with no path is simply absent. */
export function parseProbe(stdout) {
  const found = new Map();
  for (const line of String(stdout ?? '').split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const name = line.slice(0, at).trim();
    const path = line.slice(at + 1).trim();
    // An empty path is not a path: a shell that prints "bin=" has not found the binary, and recording it as present
    // would have the agent try to run something that is not installed.
    if (!name || !path) continue;
    found.set(name, path);
  }
  return found;
}

/**
 * Ask the machine that will run the tools which of these binaries exist, in one round trip.
 *
 * A case can name a hundred tools; asking one question per tool would open a hundred connections for a fact that one
 * can answer.
 *
 * @param {string} remote - an ssh host, or `wsl:<distro>`.
 * @returns {Promise<{ok: boolean, bins: Map<string,string>, error?: string}>}
 */
export function probeBinaries(remote, binaries, { timeoutMs = 20000, run = runViaFiles } = {}) {
  const list = [...new Set(binaries.filter(Boolean))];
  if (!list.length) return Promise.resolve({ ok: true, bins: new Map() });
  let spec;
  try {
    spec = parseRemote(remote);
  } catch (e) {
    return Promise.resolve({ ok: false, bins: new Map(), error: e.message });
  }
  // The answer is the output, not the exit status: a `for` loop reports its last iteration, so one absent binary at the
  // end of the list would make a good probe look like a failed connection.
  const script = [
    REMOTE_PATH,
    `for b in ${list.map(shellQuote).join(' ')}; do p=$(command -v "$b" 2>/dev/null) && printf '%s=%s\\n' "$b" "$p"; done`,
    'exit 0',
    '',
  ].join('\n');

  return run({ argv: runnerArgv(spec), script }, { timeoutMs }).then(({ code, text, timedOut, error }) => {
    if (timedOut) return { ok: false, bins: new Map(), error: `timed out after ${Math.round(timeoutMs / 1000)}s` };
    if (error) return { ok: false, bins: new Map(), error };
    if (code !== 0) {
      const why = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? `${spec.label} exited ${code}`;
      return { ok: false, bins: new Map(), error: why };
    }
    return { ok: true, bins: parseProbe(text) };
  });
}
