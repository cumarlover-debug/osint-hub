// Running the tools on the machine that has them.
//
// Most of this directory's command-line tools live in a Kali install, not on the desktop: the CLI runs where the
// person is, and the commands run where the tools are. Everything here is about that split - how a command is handed
// to another machine, how the remote shell is quoted, and how readiness is asked about once instead of a hundred
// times.
import { spawn } from 'node:child_process';

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
 * Where user-level tools land, prepended on the far side before anything is looked up or run.
 *
 * A shell started for one command does not read ~/.zshrc or ~/.bashrc, so pipx, cargo and go binaries - which is how
 * most of this directory's tools are installed - would look missing on a machine that has them.
 */
export const REMOTE_PATH = 'export PATH="$HOME/.local/bin:$HOME/go/bin:$HOME/.cargo/bin:$PATH"';

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
export function probeBinaries(remote, binaries, { timeoutMs = 20000, spawnImpl = spawn } = {}) {
  const list = [...new Set(binaries.filter(Boolean))];
  if (!list.length) return Promise.resolve({ ok: true, bins: new Map() });
  const spec = parseRemote(remote);
  const argv = runnerArgv(spec);
  // LF only. A carriage return would ride along on every line and bash would read `done\r` as a command of its own,
  // which is exactly how a piped script fails on WSL.
  //
  // The probe's answer is its output, not its exit status: a `for` loop reports the status of its last iteration, so
  // one absent binary at the end of the list made a perfectly good probe look like a failed connection.
  const script = `${REMOTE_PATH}\nfor b in ${list.map(shellQuote).join(' ')}; do p=$(command -v "$b" 2>/dev/null) && printf '%s=%s\\n' "$b" "$p"; done\nexit 0\n`.replace(/\r\n/g, '\n');

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, bins: new Map(), error: e.message });
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ ok: false, bins: new Map(), error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (e) => finish({ ok: false, bins: new Map(), error: e.message }));
    child.on('close', (code) => {
      if (code === 0) return finish({ ok: true, bins: parseProbe(stdout) });
      const why = stderr.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? `${spec.label} exited ${code}`;
      finish({ ok: false, bins: new Map(), error: why });
    });
    child.stdin?.end(script);
  });
}
