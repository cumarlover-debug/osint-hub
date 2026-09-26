// Validates every data/tools/*.yaml against the tool schema.
// The enums come from data/taxonomy.json so the site and the validator never drift apart.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import Ajv from 'ajv';

const root = fileURLToPath(new URL('..', import.meta.url));
const taxonomy = JSON.parse(readFileSync(join(root, 'data/taxonomy.json'), 'utf8'));
const inputKeys = Object.keys(taxonomy.inputs);

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'url', 'description', 'category', 'inputs', 'type', 'cost', 'passive', 'account_required'],
  properties: {
    name: { type: 'string', minLength: 1 },
    url: { type: 'string', pattern: '^https://' },
    description: { type: 'string', minLength: 20, maxLength: 240 },
    category: { enum: Object.keys(taxonomy.categories) },
    inputs: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: inputKeys } },
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

const validate = new Ajv({ allErrors: true }).compile(schema);
const dir = join(root, 'data/tools');
const errors = [];
const seenUrls = new Map();

for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
  const slug = file.replace(/\.yaml$/, '');
  if (!/^[a-z0-9-]+$/.test(slug)) errors.push(`${file}: filename must be lowercase letters, digits and dashes`);

  let tool;
  try {
    tool = yaml.load(readFileSync(join(dir, file), 'utf8'));
  } catch (e) {
    errors.push(`${file}: invalid YAML: ${e.message}`);
    continue;
  }

  if (!validate(tool)) {
    for (const err of validate.errors) errors.push(`${file}: ${err.instancePath || '(root)'} ${err.message}`);
    continue;
  }
  if (tool.type === 'cli' && !tool.repo && !tool.install) errors.push(`${file}: CLI tools need a repo or install command`);

  const key = tool.url.replace(/\/+$/, '').toLowerCase();
  if (seenUrls.has(key)) errors.push(`${file}: same url as ${seenUrls.get(key)}`);
  seenUrls.set(key, file);
}

if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`\n${errors.length} problem(s) found.`);
  process.exit(1);
}
console.log(`OK: ${seenUrls.size} tools valid.`);
