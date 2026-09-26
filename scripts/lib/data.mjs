// Shared by validate, healthcheck and the pipeline: paths, the tool schema, and URL normalisation.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import Ajv from 'ajv';

export const root = fileURLToPath(new URL('../..', import.meta.url));
export const paths = {
  tools: join(root, 'data/tools'),
  drafts: join(root, 'data/drafts'),
  health: join(root, 'data/health.json'),
  rejected: join(root, 'data/pipeline/rejected.txt'),
  aliases: join(root, 'data/pipeline/aliases.txt'),
  cache: join(root, '.cache/pipeline'),
};

export const taxonomy = JSON.parse(readFileSync(join(root, 'data/taxonomy.json'), 'utf8'));

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'url', 'description', 'category', 'inputs', 'type', 'cost', 'passive', 'account_required'],
  properties: {
    name: { type: 'string', minLength: 1 },
    url: { type: 'string', pattern: '^https://' },
    description: { type: 'string', minLength: 20, maxLength: 240 },
    category: { enum: Object.keys(taxonomy.categories) },
    inputs: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: Object.keys(taxonomy.inputs) } },
    // Outputs that match an input key become pivots to other tools; anything else is descriptive.
    outputs: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '^[a-z_]+$' } },
    type: { enum: Object.keys(taxonomy.types) },
    cost: { enum: Object.keys(taxonomy.costs) },
    passive: { type: 'boolean' },
    account_required: { type: 'boolean' },
    query_template: { type: 'string', pattern: '^https://.*\\{query\\}' },
    repo: { type: 'string', pattern: '^[\\w.-]+/[\\w.-]+$' },
    install: { type: 'string' },
    language: { type: 'string' },
    license: { type: 'string' },
    docker: { type: 'boolean' },
    platforms: { type: 'array', items: { enum: ['linux', 'macos', 'windows', 'chrome', 'firefox'] } },
    tags: { type: 'array', items: { type: 'string', pattern: '^[a-z0-9-]+$' } },
    notes: { type: 'string' },
    // Link status and GitHub stats are not set here: scripts/healthcheck.mjs writes them to data/health.json.
  },
};

const ajvValidate = new Ajv({ allErrors: true }).compile(schema);

/** Schema and rule problems for one tool, as readable strings. Empty when valid. */
export function toolErrors(tool) {
  if (!ajvValidate(tool)) return ajvValidate.errors.map((e) => `${e.instancePath || '(root)'} ${e.message}`);
  const errors = [];
  if (tool.type === 'cli' && !tool.repo && !tool.install) errors.push('CLI tools need a repo or install command');
  return errors;
}

export const isValidSlug = (slug) => /^[a-z0-9-]+$/.test(slug);

/** URL slug for a tool name: "GHunt" → "ghunt", "archive.today" → "archive-today". */
export const slugify = (name) =>
  name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'tool';

/**
 * One key per tool, however its URL is written: no scheme, no www, no trailing slash or fragment,
 * and GitHub URLs cut down to owner/repo. Used for de-duplication everywhere.
 */
export function urlKey(url) {
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    return url.trim().toLowerCase();
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'github.com') {
    const [owner, repo] = u.pathname.split('/').filter(Boolean);
    if (owner && repo) return `github.com/${owner}/${repo.replace(/\.git$/, '')}`.toLowerCase();
  }
  const path = u.pathname.replace(/\/+$/, '').replace(/\/index\.html?$/, '');
  return `${host}${path}${u.search}`.toLowerCase();
}

/** Catches the same tool listed under a different URL ("ADS-B Exchange" at adsbexchange.com vs globe.adsbexchange.com). */
export const nameKey = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Reads every YAML file in a directory as { slug, file, tool } (tool is undefined on a parse error). */
export function readYamlDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((file) => {
      const slug = file.replace(/\.yaml$/, '');
      try {
        return { slug, file, tool: yaml.load(readFileSync(join(dir, file), 'utf8')) };
      } catch (e) {
        return { slug, file, tool: undefined, error: e.message };
      }
    });
}

/**
 * URLs the pipeline must never suggest again: ones that were rejected, and aliases (the source's old URL
 * for a tool that was published under a corrected one).
 */
export function readRejected() {
  return new Set([...readUrlList(paths.rejected), ...readUrlList(paths.aliases)]);
}

function readUrlList(file) {
  if (!existsSync(file)) return [];
  return (
    readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.replace(/#.*/, '').trim())
      .filter(Boolean)
      .map(urlKey)
  );
}
