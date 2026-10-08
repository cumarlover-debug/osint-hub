// Local defaults: the things you would otherwise type or export on every call.
//
// Written because of a real annoyance. A harness loads its plugins at boot, so a tool that learns a new argument only
// after a restart keeps running the previous behaviour meanwhile - and a person watching their own machine is never
// told which machine the tools ran on. A config file is read by the CLI on every invocation, so it takes effect
// immediately for the tool, for the skill and for a terminal, whatever version of anything is in memory.
//
// Two files, merged, machine-specific last: `~/.config/osint-hub/config.json` and `<repo>/.osint-hub.local.json`.
// Both are local: the repo one is gitignored.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The keys a config file may set, and what each one means. Anything else is ignored rather than guessed at. */
export const CONFIG_KEYS = ['remote', 'basis', 'safe', 'shell', 'data', 'timeout', 'max', 'seconds', 'settle', 'out', 'open'];

export const configPaths = (root, home = homedir()) => [
  join(home, '.config', 'osint-hub', 'config.json'),
  join(root, '.osint-hub.local.json'),
];

/** Read one config file, tolerating absence and never throwing on a bad one: a broken default should not stop work. */
export function readConfig(path, { warn } = {}) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!CONFIG_KEYS.includes(key)) continue;
      if (value === undefined || value === null || value === '') continue;
      clean[key] = typeof value === 'string' ? value.replace(/^~(?=\/|\\)/, homedir()) : value;
    }
    return clean;
  } catch (e) {
    warn?.(`ignoring ${path}: ${e.message}`);
    return {};
  }
}

/** Every config file that exists, later ones winning. */
export function loadConfig(root, { warn, home } = {}) {
  return configPaths(root, home).reduce((acc, path) => ({ ...acc, ...readConfig(path, { warn }) }), {});
}

/**
 * Is this the word for "here", rather than a host to connect to?
 *
 * A machine-wide default of "run on my Kali VM" needs an escape hatch for the run that should not use it: `--remote
 * local` is a decision, not a host name, and treating it as a host would open an ssh connection to a machine called
 * "local".
 */
export const isLocalRemote = (value) => typeof value === 'string' && /^(local|here|none|off|this)$/i.test(value.trim());

/**
 * Fill in what the command line did not say. An explicit flag always wins, including a deliberate `--no-safe`, so a
 * default can never override a decision made for one run.
 *
 * @param {Record<string, unknown>} flags - as parsed from argv.
 * @param {Record<string, unknown>} config - from loadConfig.
 * @returns {Record<string, unknown>} the flags to use.
 */
export function mergeFlags(flags, config) {
  const out = { ...flags };
  for (const key of CONFIG_KEYS) {
    const value = config?.[key];
    if (value === undefined) continue;
    if (key === 'safe') {
      // --no-safe is a decision too: the default only applies when neither was given.
      if (out.safe === undefined && out['no-safe'] === undefined) out.safe = value === true;
      continue;
    }
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}

/** A one-line description of the defaults in force, for the places that report what is about to happen. */
export function describeConfig(config, paths = []) {
  const said = [];
  if (config?.remote) said.push(`tools run on ${config.remote}`);
  if (config?.basis) said.push('a standing basis is recorded');
  if (config?.safe) said.push('safe mode on');
  return said.length ? `${said.join(' · ')} (${paths[paths.length - 1]})` : '';
}
