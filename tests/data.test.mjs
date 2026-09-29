// Tests for scripts/lib/data.mjs: the URL/name normalisation every de-duplication depends on, the tool and
// playbook schemas, and the matcher list that must stay identical to shared/launcher.mjs. Run with `npm test`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { urlKey, nameKey, slugify, toolErrors, playbookErrors, isValidSlug, MATCHERS, taxonomy } from '../scripts/lib/data.mjs';
import { MATCHERS as launcherMatchers, MATCH_LABELS } from '../shared/launcher.mjs';

describe('urlKey', () => {
  it('ignores the scheme, www, trailing slash and fragment', () => {
    assert.equal(urlKey('https://www.Example.com/path/'), 'example.com/path');
    assert.equal(urlKey('http://example.com/path#section'), 'example.com/path');
    assert.equal(urlKey('https://example.com/'), 'example.com');
    assert.equal(urlKey('https://example.com'), 'example.com');
  });

  it('treats a directory index as the directory itself', () => {
    assert.equal(urlKey('https://example.com/index.html'), 'example.com');
    assert.equal(urlKey('https://example.com/docs/index.htm'), 'example.com/docs');
  });

  it('cuts GitHub URLs down to owner/repo', () => {
    assert.equal(urlKey('https://github.com/sherlock-project/sherlock'), 'github.com/sherlock-project/sherlock');
    assert.equal(urlKey('https://github.com/sherlock-project/sherlock/'), 'github.com/sherlock-project/sherlock');
    assert.equal(urlKey('https://github.com/sherlock-project/sherlock.git'), 'github.com/sherlock-project/sherlock');
    assert.equal(urlKey('https://github.com/sherlock-project/sherlock/tree/main/docs'), 'github.com/sherlock-project/sherlock');
  });

  it('keeps the query but lower-cases the whole key', () => {
    assert.equal(urlKey('https://x.com/s?q=Example'), 'x.com/s?q=example');
  });

  it('falls back to the trimmed, lower-cased text when the URL cannot be parsed', () => {
    assert.equal(urlKey('  Not A Url  '), 'not a url');
  });
});

describe('nameKey', () => {
  it('ignores case, spaces and punctuation so one tool is not listed twice', () => {
    assert.equal(nameKey('ADS-B Exchange'), 'adsbexchange');
    assert.equal(nameKey('adsbexchange'), 'adsbexchange');
    assert.equal(nameKey("Jotti's Malware Scan"), 'jottismalwarescan');
  });
});

describe('slugify', () => {
  it('makes a URL slug from a tool name', () => {
    assert.equal(slugify('GHunt'), 'ghunt');
    assert.equal(slugify('archive.today'), 'archive-today');
    assert.equal(slugify('Shodan  Search'), 'shodan-search');
  });

  it("drops apostrophes rather than turning them into a dash", () => {
    assert.equal(slugify("Jotti's"), 'jottis');
  });

  it('never returns an empty or over-long slug', () => {
    assert.equal(slugify('!!!'), 'tool');
    assert.equal(slugify(''), 'tool');
    assert.equal(slugify('a'.repeat(80)).length, 40);
  });

  it('always produces a slug the validator accepts', () => {
    for (const name of ['GHunt', "Jotti's", 'archive.today', 'aaa-bbb', 'Ünïcode Name', '!!!']) {
      assert.equal(isValidSlug(slugify(name)), true, `${name} -> ${slugify(name)}`);
    }
  });
});

describe('MATCHERS stay in step with the launcher', () => {
  // scripts/lib/data.mjs holds the regexes as JSON Schema strings, shared/launcher.mjs as RegExp objects.
  // Nothing else links them, so a matcher added to one side only would silently validate templates the
  // launcher cannot fill in.
  it('defines the same matcher names on both sides', () => {
    assert.deepEqual(Object.keys(MATCHERS).sort(), Object.keys(launcherMatchers).sort());
    assert.deepEqual(Object.keys(MATCH_LABELS).sort(), Object.keys(MATCHERS).sort());
  });

  it('agrees, matcher by matcher, on what a matching value looks like', () => {
    const samples = { eth: `0x${'a'.repeat(40)}`, btc: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', ipv4: '8.8.8.8', vin: '1HGCM82633A004352' };
    const notSamples = { eth: '0xnope', btc: 'not-a-btc-address', ipv4: 'example.com', vin: 'too-short' };
    for (const name of Object.keys(MATCHERS)) {
      assert.equal(new RegExp(MATCHERS[name]).test(samples[name]), true, `${name} should accept its sample`);
      assert.equal(launcherMatchers[name].test(samples[name]), true, `launcher ${name} should accept its sample`);
      assert.equal(new RegExp(MATCHERS[name]).test(notSamples[name]), false, `${name} should reject ${notSamples[name]}`);
      assert.equal(launcherMatchers[name].test(notSamples[name]), false, `launcher ${name} should reject ${notSamples[name]}`);
    }
  });
});

const validTool = {
  name: 'Example',
  url: 'https://example.com',
  description: 'A tool description that is comfortably over twenty characters.',
  category: 'search',
  inputs: ['keyword'],
  type: 'web',
  cost: 'free',
  passive: true,
  account_required: false,
};

describe('toolErrors', () => {
  it('accepts a minimal valid tool', () => {
    assert.deepEqual(toolErrors(validTool), []);
  });

  it('rejects an unknown field, so typos cannot pass silently', () => {
    assert.match(toolErrors({ ...validTool, pasive: true }).join('\n'), /additional properties/);
  });

  it('rejects unknown categories and input types', () => {
    assert.ok(toolErrors({ ...validTool, category: 'nope' }).length > 0);
    assert.ok(toolErrors({ ...validTool, inputs: ['nope'] }).length > 0);
  });

  it('requires https and a {query} placeholder in a query template', () => {
    assert.ok(toolErrors({ ...validTool, query_template: 'http://example.com/?q={query}' }).length > 0);
    assert.ok(toolErrors({ ...validTool, query_template: 'https://example.com/?q=static' }).length > 0);
    assert.deepEqual(toolErrors({ ...validTool, query_template: 'https://example.com/?q={query}' }), []);
  });

  it('rejects a description outside 20-240 characters', () => {
    assert.ok(toolErrors({ ...validTool, description: 'too short' }).length > 0);
    assert.ok(toolErrors({ ...validTool, description: 'a'.repeat(241) }).length > 0);
  });

  it('makes CLI tools say how to install them', () => {
    assert.deepEqual(toolErrors({ ...validTool, type: 'cli', install: 'pipx install example' }), []);
    assert.deepEqual(toolErrors({ ...validTool, type: 'cli', repo: 'owner/example' }), []);
    assert.match(toolErrors({ ...validTool, type: 'cli' }).join('\n'), /CLI tools need a repo or install command/);
  });

  it('rejects a per-input template for an input the tool does not take', () => {
    const errors = toolErrors({ ...validTool, query_template: { domain: 'https://example.com/{query}' } });
    assert.match(errors.join('\n'), /query_template has "domain", which is not one of the tool's inputs/);
  });

  it('keeps command templates to command-line tools, and docker with a plain command', () => {
    assert.match(toolErrors({ ...validTool, command_template: 'example {query}' }).join('\n'), /only for command-line tools/);
    const cli = { ...validTool, type: 'cli', install: 'pipx install example' };
    assert.deepEqual(toolErrors({ ...cli, command_template: 'example {query}' }), []);
    assert.match(toolErrors({ ...cli, docker_template: 'docker run example {query}' }).join('\n'), /docker_template needs a command_template/);
    assert.deepEqual(toolErrors({ ...cli, command_template: 'example {query}', docker_template: 'docker run example {query}' }), []);
  });

  it('rejects a command template that could break out of its argument', () => {
    const cli = { ...validTool, type: 'cli', install: 'pipx install example' };
    for (const bad of ['example {query}; rm -rf /', 'example "{query}"', 'example $( {query} )']) {
      assert.ok(toolErrors({ ...cli, command_template: bad }).length > 0, `should reject: ${bad}`);
    }
    assert.deepEqual(toolErrors({ ...cli, command_template: 'example --target {query}' }), []);
  });
});

const validPlaybook = {
  title: 'A playbook',
  summary: 'A summary that is long enough to pass the schema.',
  starts_with: 'domain',
  for: 'Anyone',
  time: '30 minutes',
  steps: [
    { title: 'First', why: 'why', do: 'do', tools: ['exiftool'] },
    { title: 'Second', why: 'why', do: 'do', tools: ['exiftool'] },
  ],
};
const toolSlugs = new Set(['exiftool']);

describe('playbookErrors', () => {
  it('accepts a valid playbook', () => {
    assert.deepEqual(playbookErrors(validPlaybook, toolSlugs), []);
  });

  it('catches a step that points at a tool which does not exist', () => {
    const broken = { ...validPlaybook, steps: [{ ...validPlaybook.steps[0], tools: ['gone'] }, validPlaybook.steps[1]] };
    assert.match(playbookErrors(broken, toolSlugs).join('\n'), /step 1 uses unknown tool "gone"/);
  });

  it('rejects a playbook with fewer than two steps', () => {
    assert.ok(playbookErrors({ ...validPlaybook, steps: [validPlaybook.steps[0]] }, toolSlugs).length > 0);
  });

  it('rejects a starting input that is not in the taxonomy', () => {
    assert.ok(playbookErrors({ ...validPlaybook, starts_with: 'nope' }, toolSlugs).length > 0);
  });

  it('rejects a step with an unknown field', () => {
    const broken = { ...validPlaybook, steps: [{ ...validPlaybook.steps[0], reason: 'typo' }, validPlaybook.steps[1]] };
    assert.match(playbookErrors(broken, toolSlugs).join('\n'), /additional properties/);
  });
});

describe('taxonomy', () => {
  it('keeps a label for every key in each enum', () => {
    for (const group of ['inputs', 'categories', 'types', 'costs']) {
      assert.ok(Object.keys(taxonomy[group]).length > 0, `${group} should not be empty`);
      for (const [key, label] of Object.entries(taxonomy[group])) {
        assert.match(key, /^[a-z0-9_-]+$/, `${group} key ${key}`);
        assert.equal(typeof label, 'string');
        assert.ok(label.length > 0, `${group}.${key} needs a label`);
      }
    }
  });
});
