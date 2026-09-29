// Whole-project data invariants: the things scripts/validate.mjs does not already check, but that break the
// site just as badly when they drift — tools without a health entry, the same tool listed twice under
// different URLs or names, a taxonomy key nothing uses, and the extension's copy of the shared launcher.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, root, taxonomy, readYamlDir, readRejected, toolErrors, playbookErrors, urlKey, nameKey } from '../scripts/lib/data.mjs';

let tools = [];
let playbooks = [];

before(() => {
  tools = readYamlDir(paths.tools).map(({ slug, file, tool, error }) => ({ slug, file, tool, error }));
  playbooks = readYamlDir(paths.playbooks);
});

describe('data/tools', () => {
  it('has tools to test at all', () => {
    assert.ok(tools.length > 500, `expected a populated directory, found ${tools.length}`);
  });

  it('parses and validates every file', () => {
    const problems = [];
    for (const { file, tool, error } of tools) {
      if (error) problems.push(`${file}: invalid YAML: ${error}`);
      else for (const p of toolErrors(tool)) problems.push(`${file}: ${p}`);
    }
    assert.deepEqual(problems, []);
  });

  it('lists no tool twice, by URL', () => {
    const seen = new Map();
    const duplicates = [];
    for (const { slug, tool } of tools) {
      const key = urlKey(tool.url);
      if (seen.has(key)) duplicates.push(`${slug} and ${seen.get(key)} both use ${key}`);
      seen.set(key, slug);
    }
    assert.deepEqual(duplicates, []);
  });

  it('lists no tool twice, by name', () => {
    const seen = new Map();
    const duplicates = [];
    for (const { slug, tool } of tools) {
      const key = nameKey(tool.name);
      if (seen.has(key)) duplicates.push(`${slug} and ${seen.get(key)} are both "${tool.name}"`);
      seen.set(key, slug);
    }
    assert.deepEqual(duplicates, []);
  });

  it('names every file after a valid slug', () => {
    for (const { slug } of tools) assert.match(slug, /^[a-z0-9-]+$/, `bad filename: ${slug}.yaml`);
  });

  it('gives every tool a health entry and no health entry to a tool that is gone', () => {
    const health = JSON.parse(readFileSync(paths.health, 'utf8'));
    const slugs = new Set(tools.map((t) => t.slug));
    const missing = [...slugs].filter((s) => !health[s]);
    const orphaned = Object.keys(health).filter((s) => !slugs.has(s));
    assert.deepEqual(missing, [], 'tools with no entry in data/health.json');
    assert.deepEqual(orphaned, [], 'data/health.json entries for tools that no longer exist');
  });

  it('records a usable health status for every tool', () => {
    const health = JSON.parse(readFileSync(paths.health, 'utf8'));
    for (const [slug, entry] of Object.entries(health)) {
      assert.ok(['up', 'down', 'unverified'].includes(entry.status), `${slug} has status ${entry.status}`);
      assert.equal(typeof entry.failures, 'number', `${slug} needs a failure count`);
      assert.match(entry.last_checked, /^\d{4}-\d{2}-\d{2}$/, `${slug} needs a last_checked date`);
    }
  });
});

describe('data/taxonomy.json', () => {
  it('has no input, category, type or cost that nothing uses', () => {
    const used = {
      inputs: new Set(tools.flatMap(({ tool }) => tool.inputs)),
      categories: new Set(tools.map(({ tool }) => tool.category)),
      types: new Set(tools.map(({ tool }) => tool.type)),
      costs: new Set(tools.map(({ tool }) => tool.cost)),
    };
    for (const group of Object.keys(used)) {
      const dead = Object.keys(taxonomy[group]).filter((key) => !used[group].has(key));
      assert.deepEqual(dead, [], `unused ${group} in data/taxonomy.json`);
    }
  });
});

describe('data/playbooks', () => {
  it('validates every playbook and its tool references', () => {
    const slugs = new Set(tools.map((t) => t.slug));
    const problems = [];
    for (const { file, tool, error } of playbooks) {
      if (error) problems.push(`${file}: invalid YAML: ${error}`);
      else for (const p of playbookErrors(tool, slugs)) problems.push(`${file}: ${p}`);
    }
    assert.deepEqual(problems, []);
  });

  it('starts every playbook from an input that tools exist for', () => {
    for (const { file, tool } of playbooks) {
      if (!tool) continue;
      const count = tools.filter(({ tool: t }) => t.inputs.includes(tool.starts_with)).length;
      assert.ok(count > 0, `${file} starts from "${tool.starts_with}", which no tool takes`);
    }
  });
});

describe('data/pipeline', () => {
  it('reads the rejected and alias lists as normalised URL keys', () => {
    const rejected = readRejected();
    assert.ok(rejected.size > 0, 'expected the rejected and alias lists to be populated');
    for (const key of rejected) {
      assert.equal(key, key.trim());
      assert.equal(key, key.toLowerCase());
      assert.ok(!key.startsWith('http'), `expected a urlKey, found the raw URL ${key}`);
    }
  });

  it('never lists a tool whose URL was already rejected', () => {
    const rejected = readRejected();
    const clashing = tools.filter(({ tool }) => rejected.has(urlKey(tool.url))).map(({ slug }) => slug);
    assert.deepEqual(clashing, [], 'listed tools that the pipeline has on its rejected or alias list');
  });
});

describe('shared code', () => {
  it('ships the extension an identical copy of the shared launcher', () => {
    // The extension cannot import files outside its own folder, so the copy is checked instead.
    const shared = readFileSync(join(root, 'shared/launcher.mjs'), 'utf8');
    const copy = readFileSync(join(root, 'extension/lib/launcher.mjs'), 'utf8');
    assert.equal(copy, shared, 'run npm run extension:sync');
  });
});
