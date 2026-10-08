// Handing a command to the machine that has the tools. The parts worth testing are the ones that decide how a command
// is quoted, how its life is bounded on the far side, and how the same question is asked once instead of a hundred
// times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { commandBinary, parseProbe, parseRemote, probeBinaries, remoteScript, runnerArgv, shellQuote, sshArgv } from '../shared/remote.mjs';

test('refuses to hang on a password prompt', () => {
  const argv = sshArgv('osint-kali');
  assert.ok(argv.includes('BatchMode=yes'), 'a call with no terminal must fail rather than wait');
  assert.ok(argv.includes('ConnectTimeout=10'));
  assert.deepEqual(argv.slice(-3), ['osint-kali', 'bash', '-s']);
});

test('tells the two transports apart, including the one that needs no network', () => {
  // The machine configured years ago may not be the machine that exists: an ssh host needs an address that can go
  // stale, a WSL distro does not.
  assert.deepEqual(parseRemote('osint-kali'), { kind: 'ssh', host: 'osint-kali', label: 'osint-kali' });
  assert.deepEqual(parseRemote('wsl:kali-linux'), { kind: 'wsl', distro: 'kali-linux', label: 'wsl:kali-linux' });
  assert.deepEqual(parseRemote('wsl'), { kind: 'wsl', label: 'wsl' });
  assert.deepEqual(runnerArgv('wsl:kali-linux'), ['wsl.exe', '-d', 'kali-linux', '--', 'bash', '-s']);
  assert.deepEqual(runnerArgv('wsl'), ['wsl.exe', '--', 'bash', '-s']);
  assert.throws(() => parseRemote(''), /no remote/);
});

test('puts user-level tool directories on PATH on the far side', () => {
  // A one-shot shell does not read ~/.zshrc, so pipx, cargo and go binaries would look missing on a machine that has
  // them - which is how most of this directory's tools are installed.
  const script = remoteScript('maigret user');
  assert.ok(script.split('\n')[0].includes('.local/bin'), 'the PATH comes first');
});

test('passes the command as a script on stdin, so nothing re-parses it', () => {
  // This is the whole reason for bash -s: a value with quotes, pipes or a newline in it must not become shell syntax
  // on either machine.
  const script = remoteScript('leaker email "someone@example.com" | tee out.txt');
  assert.match(script, /leaker email "someone@example\.com" \| tee out\.txt/);
  assert.equal(sshArgv('osint-kali').includes('leaker'), false, 'the command is never an ssh argument');
});

test('bounds the tool on the far side, because killing ssh does not kill what it started', () => {
  const script = remoteScript('instaloader someone', { timeoutSeconds: 300 });
  assert.match(script, /timeout -k 5 300s instaloader someone/);
  assert.match(script, /exit \$\?/, 'the tool\'s exit code comes back');
  assert.match(remoteScript('maigret user', { cwd: '/home/amir/tools' }), /^cd '\/home\/amir\/tools' \|\| exit 1/m);
});

test('quotes a path with a space or a quote in it', () => {
  assert.equal(shellQuote('/home/amir/my tools'), `'/home/amir/my tools'`);
  assert.equal(shellQuote("it's here"), `'it'\\''s here'`);
});

test('knows which program a command actually runs', () => {
  assert.equal(commandBinary('maigret user --tags dating'), 'maigret');
  assert.equal(commandBinary("cd ~/tools/blackbird && python3 blackbird.py -u x"), 'python3');
  assert.equal(commandBinary('./h8mail -t x'), './h8mail');
  assert.equal(commandBinary(''), '');
});

test('reads the probe output, including binaries that are not there', () => {
  const bins = parseProbe('sherlock=/usr/bin/sherlock\nholehe=\nh8mail=/home/amir/.local/bin/h8mail\n');
  assert.equal(bins.get('sherlock'), '/usr/bin/sherlock');
  assert.equal(bins.get('h8mail'), '/home/amir/.local/bin/h8mail');
  assert.equal(bins.has('holehe'), false, 'a binary with no path is absent, not present-and-empty');
});

/** A stand-in for ssh that answers with a fixed probe result. */
function fakeSsh({ stdout = '', code = 0, stderr = '' } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: (script) => { child.script = script; } };
    child.kill = () => {};
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child;
  };
}

test('asks about every binary in one connection', async () => {
  const seen = {};
  const result = await probeBinaries('osint-kali', ['sherlock', 'holehe', 'sherlock'], {
    spawnImpl: (cmd, args, opts) => {
      seen.cmd = cmd;
      seen.args = args;
      seen.opts = opts;
      return fakeSsh({ stdout: 'sherlock=/usr/bin/sherlock\n' })();
    },
  });
  assert.equal(seen.cmd, 'ssh');
  assert.equal(result.ok, true);
  assert.equal(result.bins.get('sherlock'), '/usr/bin/sherlock');
  assert.equal(result.bins.has('holehe'), false);
});

test('an unreachable host is reported as unreachable, not as a machine without tools', async () => {
  const result = await probeBinaries('osint-kali', ['sherlock'], {
    spawnImpl: fakeSsh({ code: 255, stderr: 'ssh: connect to host 192.168.86.128 port 22: Connection timed out' }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Connection timed out/);
  assert.equal(result.bins.size, 0);
});

test('no binaries to ask about costs no connection', async () => {
  let called = false;
  const result = await probeBinaries('osint-kali', [], { spawnImpl: () => (called = true) });
  assert.deepEqual(result, { ok: true, bins: new Map() });
  assert.equal(called, false);
});
