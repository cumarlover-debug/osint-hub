// Shared by validate, healthcheck and the pipeline: paths, the tool schema, and URL normalisation.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import Ajv from 'ajv';

export const root = fileURLToPath(new URL('../..', import.meta.url));
export const paths = {
  tools: join(root, 'data/tools'),
  playbooks: join(root, 'data/playbooks'),
  drafts: join(root, 'data/drafts'),
  health: join(root, 'data/health.json'),
  rejected: join(root, 'data/pipeline/rejected.txt'),
  aliases: join(root, 'data/pipeline/aliases.txt'),
  cache: join(root, '.cache/pipeline'),
};

export const taxonomy = JSON.parse(readFileSync(join(root, 'data/taxonomy.json'), 'utf8'));

const templateUrl = { type: 'string', pattern: '^https://.*\\{query\\}' };
// A command line with exactly one {query}, not inside quotes (the value is quoted when it is filled in).
const commandLine = { type: 'string', pattern: '^[^{}\'"`$;&|<>]*\\{query\\}[^{}\'"`$;&|<>]*$' };
const commandTemplate = {
  oneOf: [commandLine, { type: 'object', minProperties: 1, propertyNames: { enum: Object.keys(taxonomy.inputs) }, additionalProperties: commandLine }],
};

/** Value formats a query template can be limited to. Kept in sync with src/lib/launcher.ts. */
export const MATCHERS = {
  eth: '^0x[0-9a-fA-F]{40}$',
  btc: '^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$',
  ipv4: '^(\\d{1,3}\\.){3}\\d{1,3}$',
  vin: '^[A-HJ-NPR-Z0-9]{17}$',
};

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
    // Why a service has to be used by hand: it only answers a submitted form, hides behind a captcha, needs a key,
    // needs a login, or is an interactive console. Marked tools are listed in the report as a to-do list and are
    // left out of the fetch and browser passes, which cannot get anything from them.
    manual: { enum: ['captcha', 'post-form', 'api-key', 'login', 'interactive'] },
    // Either one search URL for every input, or one per input type. A per-input entry can be limited to one value
    // format with `match` (see MATCHERS), e.g. Etherscan only takes Ethereum addresses.
    query_template: {
      oneOf: [
        templateUrl,
        {
          type: 'object',
          minProperties: 1,
          propertyNames: { enum: Object.keys(taxonomy.inputs) },
          additionalProperties: {
            oneOf: [
              templateUrl,
              {
                type: 'object',
                additionalProperties: false,
                required: ['url', 'match'],
                properties: { url: templateUrl, match: { enum: Object.keys(MATCHERS) } },
              },
            ],
          },
        },
      ],
    },
    // Command lines for tools you run yourself: one for every input, or one per input type. {query} is replaced by
    // the shell-quoted value (see commandFor in shared/launcher.mjs). docker_template is the same, run via Docker.
    command_template: commandTemplate,
    docker_template: commandTemplate,
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
  for (const field of ['query_template', 'command_template', 'docker_template']) {
    if (tool[field] && typeof tool[field] === 'object') {
      for (const input of Object.keys(tool[field]))
        if (!tool.inputs.includes(input)) errors.push(`${field} has "${input}", which is not one of the tool's inputs`);
    }
  }
  if ((tool.command_template || tool.docker_template) && tool.type !== 'cli') errors.push('command_template and docker_template are only for command-line tools');
  if (tool.docker_template && !tool.command_template) errors.push('docker_template needs a command_template too');
  return errors;
}

export const isValidSlug = (slug) => /^[a-z0-9-]+$/.test(slug);

const inputEnum = { enum: Object.keys(taxonomy.inputs) };
const playbookSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'starts_with', 'for', 'time', 'steps'],
  properties: {
    title: { type: 'string', minLength: 5 },
    summary: { type: 'string', minLength: 20, maxLength: 200 },
    starts_with: inputEnum,
    for: { type: 'string' },
    time: { type: 'string' },
    steps: {
      type: 'array',
      minItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'why', 'do', 'tools'],
        properties: {
          title: { type: 'string' },
          input: inputEnum,
          why: { type: 'string' },
          do: { type: 'string' },
          look_for: { type: 'array', items: { type: 'string' } },
          tools: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '^[a-z0-9-]+$' } },
          opsec: { type: 'string' },
        },
      },
    },
  },
};
const ajvPlaybook = new Ajv({ allErrors: true }).compile(playbookSchema);

/** Schema problems plus references to tools that do not exist. */
export function playbookErrors(playbook, toolSlugs) {
  if (!ajvPlaybook(playbook)) return ajvPlaybook.errors.map((e) => `${e.instancePath || '(root)'} ${e.message}`);
  const errors = [];
  playbook.steps.forEach((step, i) => {
    for (const slug of step.tools) if (!toolSlugs.has(slug)) errors.push(`step ${i + 1} uses unknown tool "${slug}"`);
  });
  return errors;
}

/** URL slug for a tool name: "GHunt" → "ghunt", "archive.today" → "archive-today". */
export const slugify = (name) =>
  name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/['’]/g, '') // "Jotti's" → "jottis", not "jotti-s"
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
