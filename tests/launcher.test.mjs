// Tests for shared/launcher.mjs: the value detection, link building and command quoting that the website,
// the CLI and the browser extension all rely on. Run with `npm test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MATCHERS,
  MATCH_LABELS,
  detect,
  applies,
  buildLink,
  templatesFor,
  commandProblem,
  quoteArg,
  commandTemplatesFor,
  commandsFor,
  launchable,
} from '../shared/launcher.mjs';

describe('detect', () => {
  it('returns nothing for empty input', () => {
    assert.deepEqual(detect(''), []);
    assert.deepEqual(detect('   '), []);
  });

  it('recognises emails', () => {
    assert.deepEqual(detect('analyst@example.com'), ['email']);
    assert.deepEqual(detect('  analyst@example.com  '), ['email']);
  });

  it('recognises IPv4 and IPv6 addresses', () => {
    assert.deepEqual(detect('8.8.8.8'), ['ip']);
    assert.deepEqual(detect('2001:db8::1'), ['ip']);
  });

  it('recognises file hashes by length', () => {
    assert.deepEqual(detect('d41d8cd98f00b204e9800998ecf8427e'), ['hash']);
    assert.deepEqual(detect('a'.repeat(40)), ['hash']);
    assert.deepEqual(detect('b'.repeat(64)), ['hash']);
    assert.deepEqual(detect('c'.repeat(31)), ['username', 'company', 'aircraft', 'vessel', 'keyword']);
  });

  it('recognises Ethereum and Bitcoin addresses', () => {
    assert.deepEqual(detect(`0x${'a'.repeat(40)}`), ['crypto_address']);
    assert.deepEqual(detect('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), ['crypto_address']);
  });

  it('recognises VINs, but only when they mix digits and letters', () => {
    assert.deepEqual(detect('1HGCM82633A004352'), ['vehicle']);
    // 17 allowed characters, but all letters: a plausible word, not a VIN.
    assert.deepEqual(detect('HGCMPNPRZAHGCMPNR'), ['username', 'company', 'aircraft', 'vessel', 'keyword']);
  });

  it('recognises domains without a scheme', () => {
    assert.deepEqual(detect('example.com'), ['domain']);
    assert.deepEqual(detect('sub.example.co.uk'), ['domain']);
  });

  it('recognises phone numbers written with digits, spaces and dashes', () => {
    assert.deepEqual(detect('+1 555 010 9999'), ['phone']);
    assert.deepEqual(detect('+60123456789'), ['phone']);
    assert.deepEqual(detect('555-010-9999'), ['phone']);
  });

  it('types URLs, and refines image and video URLs', () => {
    assert.deepEqual(detect('https://example.com/page'), ['url']);
    assert.deepEqual(detect('https://i.imgur.com/x.jpg?w=1'), ['image', 'url']);
    assert.deepEqual(detect('https://www.youtube.com/watch?v=abc'), ['video', 'url']);
    assert.deepEqual(detect('https://youtu.be/abc'), ['video', 'url']);
  });

  it('falls back to the ambiguous types, most specific first', () => {
    assert.deepEqual(detect('John Smith'), ['name', 'company', 'location', 'keyword']);
    assert.deepEqual(detect('sherlock'), ['username', 'company', 'aircraft', 'vessel', 'keyword']);
  });
});

describe('MATCHERS', () => {
  it('describes every matcher it ships', () => {
    assert.deepEqual(Object.keys(MATCH_LABELS).sort(), Object.keys(MATCHERS).sort());
  });

  it('accepts and rejects the values the templates rely on', () => {
    assert.equal(MATCHERS.ipv4.test('8.8.8.8'), true);
    assert.equal(MATCHERS.ipv4.test('example.com'), false);
    assert.equal(MATCHERS.eth.test(`0x${'a'.repeat(40)}`), true);
    assert.equal(MATCHERS.eth.test(`0x${'a'.repeat(39)}`), false);
    assert.equal(MATCHERS.vin.test('1HGCM82633A004352'), true);
    assert.equal(MATCHERS.vin.test('1HGCM82633A00435'), false);
  });
});

describe('templatesFor', () => {
  const inputs = ['email', 'domain'];

  it('returns nothing without a template', () => {
    assert.deepEqual(templatesFor(undefined, inputs), {});
  });

  it('repeats a single template for every input the tool takes', () => {
    assert.deepEqual(templatesFor('https://x.com/?q={query}', inputs), {
      email: { url: 'https://x.com/?q={query}' },
      domain: { url: 'https://x.com/?q={query}' },
    });
  });

  it('normalises per-input templates, with and without a matcher', () => {
    assert.deepEqual(
      templatesFor({ email: 'https://x.com/e/{query}', domain: { url: 'https://x.com/d/{query}', match: 'ipv4' } }, inputs),
      { email: { url: 'https://x.com/e/{query}' }, domain: { url: 'https://x.com/d/{query}', match: 'ipv4' } },
    );
  });

  it('never invents an input type', () => {
    assert.deepEqual(templatesFor({ email: 'https://x.com/e/{query}' }, inputs), { email: { url: 'https://x.com/e/{query}' } });
  });
});

describe('applies / buildLink', () => {
  it('matches every value when the template has no matcher', () => {
    assert.equal(applies({ url: 'https://x/{query}' }, 'anything at all'), true);
  });

  it('honours the matcher, ignoring surrounding whitespace', () => {
    const template = { url: 'https://x/{query}', match: 'ipv4' };
    assert.equal(applies(template, '8.8.8.8'), true);
    assert.equal(applies(template, '  8.8.8.8  '), true);
    assert.equal(applies(template, 'example.com'), false);
  });

  it('encodes the value and trims it', () => {
    assert.equal(buildLink({ url: 'https://x.com/?q={query}' }, '  a b&c  '), 'https://x.com/?q=a%20b%26c');
    // A value that is already a URL stays readable apart from the reserved characters.
    assert.equal(buildLink({ url: 'https://x.com/{query}' }, 'https://y.com/a?b=1'), 'https://x.com/https%3A%2F%2Fy.com%2Fa%3Fb%3D1');
  });
});

describe('commandProblem', () => {
  it('accepts an ordinary value', () => {
    assert.equal(commandProblem('example.com'), '');
  });

  it('refuses an empty value', () => {
    assert.equal(commandProblem(''), 'empty');
    assert.equal(commandProblem('   '), 'empty');
  });

  it('refuses control characters, including line breaks', () => {
    assert.match(commandProblem('a\nb'), /control character/);
    assert.match(commandProblem('a\u0000b'), /control character/);
  });

  it('refuses a leading dash, which the tool would read as an option', () => {
    assert.match(commandProblem('--help'), /starts with "-"/);
  });

  it('refuses a value over 500 characters', () => {
    assert.equal(commandProblem('a'.repeat(500)), '');
    assert.equal(commandProblem('a'.repeat(501)), 'is too long');
  });
});

describe('quoteArg', () => {
  it('leaves safe values unquoted so commands stay readable', () => {
    assert.equal(quoteArg('example.com', 'posix'), 'example.com');
    assert.equal(quoteArg('user@example.com', 'posix'), 'user@example.com');
    assert.equal(quoteArg('+60123456789', 'posix'), '+60123456789');
  });

  it('single-quotes anything else in POSIX shells', () => {
    assert.equal(quoteArg('a b', 'posix'), "'a b'");
    assert.equal(quoteArg('a;rm -rf /', 'posix'), "'a;rm -rf /'");
    assert.equal(quoteArg('$(whoami)', 'posix'), "'$(whoami)'");
  });

  it("escapes a quote in POSIX shells without leaving the quoted string", () => {
    assert.equal(quoteArg("it's", 'posix'), String.raw`'it'\''s'`);
  });

  it('doubles quotes for PowerShell, including the curly ones it also treats as quotes', () => {
    assert.equal(quoteArg("it's", 'powershell'), "'it''s'");
    assert.equal(quoteArg('\u2018quoted\u2019', 'powershell'), "'\u2018\u2018quoted\u2019\u2019'");
  });

  it('quotes a value that could start a second command', () => {
    const quoted = quoteArg('example.com; curl evil.test', 'posix');
    assert.equal(quoted, "'example.com; curl evil.test'");
    assert.ok(quoted.startsWith("'") && quoted.endsWith("'"));
  });
});

describe('commandTemplatesFor', () => {
  const inputs = ['domain', 'ip'];

  it('returns nothing without a template', () => {
    assert.deepEqual(commandTemplatesFor(undefined, inputs), {});
  });

  it('repeats a single command for every input', () => {
    assert.deepEqual(commandTemplatesFor('tool {query}', inputs), { domain: 'tool {query}', ip: 'tool {query}' });
  });

  it('keeps a per-input command as it is', () => {
    assert.deepEqual(commandTemplatesFor({ ip: 'tool -i {query}' }, inputs), { ip: 'tool -i {query}' });
  });
});

describe('commandsFor', () => {
  const tools = [
    { name: 'Zed', inputs: ['domain'], passive: true, command_template: { domain: 'zed {query}' } },
    { name: 'Abc', inputs: ['domain'], passive: true, command_template: 'abc --target {query}' },
    { name: 'Active', inputs: ['domain'], passive: false, command_template: { domain: 'active {query}' } },
    { name: 'Other', inputs: ['ip'], passive: true, command_template: { ip: 'other {query}' } },
    { name: 'NoCommand', inputs: ['domain'], passive: true },
  ];

  it('lists only passive tools by default, usable first', () => {
    const { problem, rows } = commandsFor(tools, 'domain', 'example.com');
    assert.equal(problem, '');
    assert.deepEqual(rows.map((r) => r.tool.name), ['Abc', 'Zed']);
    assert.equal(rows[0].command, 'abc --target example.com');
    assert.equal(rows[1].command, 'zed example.com');
  });

  it('adds active tools when asked, after the passive ones', () => {
    const { rows } = commandsFor(tools, 'domain', 'example.com', { includeActive: true });
    assert.deepEqual(rows.map((r) => r.tool.name), ['Abc', 'Zed', 'Active']);
  });

  it('quotes the value for the chosen shell', () => {
    const posix = commandsFor(tools, 'domain', 'a b', { shell: 'posix' }).rows[0].command;
    const powershell = commandsFor(tools, 'domain', "a'b", { shell: 'powershell' }).rows[0].command;
    assert.equal(posix, "abc --target 'a b'");
    assert.equal(powershell, "abc --target 'a''b'");
  });

  it('reports a problem instead of building a command from a bad value', () => {
    const { problem, rows } = commandsFor(tools, 'domain', '--help');
    assert.match(problem, /starts with "-"/);
    assert.deepEqual(rows, []);
  });

  it('ignores tools with no command for that input type', () => {
    const { rows } = commandsFor(tools, 'ip', '8.8.8.8', { includeActive: true });
    assert.deepEqual(rows.map((r) => r.tool.name), ['Other']);
  });

  it('carries a docker command alongside the plain one', () => {
    const dockerTool = [
      { name: 'D', inputs: ['domain'], passive: true, command_template: 'd {query}', docker_template: 'docker run img {query}' },
    ];
    const { rows } = commandsFor(dockerTool, 'domain', 'example.com');
    assert.equal(rows[0].command, 'd example.com');
    assert.equal(rows[0].docker, 'docker run img example.com');
  });
});

describe('launchable', () => {
  const tools = [
    { name: 'Beta', passive: true, inputs: ['ip'], query_template: { ip: { url: 'https://b/{query}', match: 'ipv4' } } },
    { name: 'Alpha', passive: true, inputs: ['ip'], query_template: 'https://a/{query}' },
    { name: 'Active', passive: false, inputs: ['ip'], query_template: 'https://c/{query}' },
    { name: 'WrongInput', passive: true, inputs: ['domain'], query_template: 'https://d/{query}' },
  ];

  it('lists passive tools that can take the value, by name', () => {
    const rows = launchable(tools, 'ip', '8.8.8.8');
    assert.deepEqual(rows.map((r) => r.tool.name), ['Alpha', 'Beta']);
    assert.equal(rows[0].link, 'https://a/8.8.8.8');
    assert.equal(rows[0].usable, true);
  });

  it('hides active tools unless asked for', () => {
    assert.deepEqual(launchable(tools, 'ip', '8.8.8.8').map((r) => r.tool.name), ['Alpha', 'Beta']);
    assert.deepEqual(launchable(tools, 'ip', '8.8.8.8', { includeActive: true }).map((r) => r.tool.name), ['Alpha', 'Beta', 'Active']);
  });

  it('keeps a mismatched matcher in the list, unusable and last, with no link', () => {
    const rows = launchable(tools, 'ip', 'example.com', { includeActive: true });
    assert.deepEqual(rows.map((r) => r.tool.name), ['Alpha', 'Active', 'Beta']);
    const beta = rows.at(-1);
    assert.equal(beta.usable, false);
    assert.equal(beta.link, undefined);
  });

  it('ignores tools that do not take that input type', () => {
    assert.deepEqual(launchable(tools, 'domain', 'example.com').map((r) => r.tool.name), ['WrongInput']);
  });
});
