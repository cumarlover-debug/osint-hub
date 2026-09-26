// Validates every data/tools/*.yaml against the tool schema (see scripts/lib/data.mjs).
// The enums come from data/taxonomy.json so the site and the validator never drift apart.
import { paths, readYamlDir, toolErrors, playbookErrors, isValidSlug, urlKey } from './lib/data.mjs';

const errors = [];
const seenUrls = new Map();
const entries = readYamlDir(paths.tools);

for (const { slug, file, tool, error } of entries) {
  if (!isValidSlug(slug)) errors.push(`${file}: filename must be lowercase letters, digits and dashes`);
  if (error) {
    errors.push(`${file}: invalid YAML: ${error}`);
    continue;
  }
  const problems = toolErrors(tool);
  if (problems.length) {
    for (const p of problems) errors.push(`${file}: ${p}`);
    continue;
  }
  const key = urlKey(tool.url);
  if (seenUrls.has(key)) errors.push(`${file}: same url as ${seenUrls.get(key)}`);
  seenUrls.set(key, file);
}

// Playbooks reference tools by slug, so a removed or renamed tool must not leave a broken step behind.
const toolSlugs = new Set(entries.map((e) => e.slug));
const playbooks = readYamlDir(paths.playbooks);
for (const { slug, file, tool: playbook, error } of playbooks) {
  if (!isValidSlug(slug)) errors.push(`playbooks/${file}: filename must be lowercase letters, digits and dashes`);
  if (error) errors.push(`playbooks/${file}: invalid YAML: ${error}`);
  else for (const p of playbookErrors(playbook, toolSlugs)) errors.push(`playbooks/${file}: ${p}`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`\n${errors.length} problem(s) found.`);
  process.exit(1);
}
console.log(`OK: ${entries.length} tools and ${playbooks.length} playbooks valid.`);
