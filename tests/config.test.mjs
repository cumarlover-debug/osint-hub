// Local defaults: the file that makes a harness tool honour a decision it was never told about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONFIG_KEYS, describeConfig, loadConfig, mergeFlags, readConfig } from '../shared/config.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'osint-config-'));
const write = (name, body) => {
  const path = join(scratch, name);
  writeFileSync(path, body);
  return path;
};

test('fills in what the command line did not say, and nothing else', () => {
  const merged = mergeFlags({ command: undefined }, { remote: 'osint-kali', max: 8, shell: 'posix' });
  assert.equal(merged.remote, 'osint-kali');
  assert.equal(merged.max, 8);
  // An explicit argument always wins, so a default can never overrule one run's decision.
  assert.equal(mergeFlags({ remote: 'wsl:kali-linux' }, { remote: 'osint-kali' }).remote, 'wsl:kali-linux');
  assert.equal(mergeFlags({ max: 2 }, { max: 8 }).max, 2);
});

test('safe mode is only a default, never an override', () => {
  assert.equal(mergeFlags({}, { safe: true }).safe, true);
  assert.equal(mergeFlags({ safe: false }, { safe: true }).safe, false, '--safe off stays off');
  // --no-safe is a decision too: a config file must not quietly re-enable what was switched off.
  assert.equal(mergeFlags({ 'no-safe': true }, { safe: true }).safe, undefined);
});

test('ignores keys it does not own, rather than guessing what they meant', () => {
  const merged = mergeFlags({}, { remote: 'osint-kali', somethingElse: 'surprise' });
  assert.equal(merged.somethingElse, undefined);
  assert.deepEqual(CONFIG_KEYS.includes('remote'), true);
});

test('reads a config file, and says so instead of throwing when it is broken', () => {
  const good = write('good.json', JSON.stringify({ remote: 'osint-kali', unknown: 1, empty: '' }));
  assert.deepEqual(readConfig(good), { remote: 'osint-kali' });

  const broken = write('broken.json', '{ this is not json');
  const warnings = [];
  assert.deepEqual(readConfig(broken, { warn: (m) => warnings.push(m) }), {});
  assert.equal(warnings.length, 1, 'a broken default is reported, not fatal');

  assert.deepEqual(readConfig(join(scratch, 'absent.json')), {});
});

test('expands ~ in a path, because that is how people write their home directory', () => {
  const file = write('tilde.json', JSON.stringify({ data: '~/tools.json' }));
  const config = readConfig(file);
  assert.ok(!config.data.startsWith('~'), config.data);
});

test('later files win, so the repo can override the machine', () => {
  const home = mkdtempSync(join(tmpdir(), 'osint-home-'));
  const root = mkdtempSync(join(tmpdir(), 'osint-root-'));
  try {
    writeFileSync(join(root, '.osint-hub.local.json'), JSON.stringify({ remote: 'osint-kali', max: 3 }));
    const merged = loadConfig(root, { home });
    assert.equal(merged.remote, 'osint-kali', 'the repo file applies');
    assert.equal(merged.max, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('describes what is in force, for the places that report it', () => {
  assert.match(describeConfig({ remote: 'osint-kali' }, ['C:/repo/.osint-hub.local.json']), /tools run on osint-kali/);
  assert.equal(describeConfig({}), '');
});

test.after(() => rmSync(scratch, { recursive: true, force: true }));
