import yaml from 'js-yaml';
import taxonomy from '../../data/taxonomy.json';
import health from '../../data/health.json';
import type { QueryTemplate } from './launcher';

export type InputKey = keyof typeof taxonomy.inputs;
export type CategoryKey = keyof typeof taxonomy.categories;
export type TypeKey = keyof typeof taxonomy.types;
export type CostKey = keyof typeof taxonomy.costs;

export interface Tool {
  slug: string;
  name: string;
  url: string;
  description: string;
  category: CategoryKey;
  inputs: InputKey[];
  outputs?: string[];
  type: TypeKey;
  cost: CostKey;
  passive: boolean;
  account_required: boolean;
  query_template?: QueryTemplate;
  command_template?: string | Record<string, string>;
  docker_template?: string | Record<string, string>;
  repo?: string;
  install?: string;
  language?: string;
  license?: string;
  docker?: boolean;
  platforms?: string[];
  tags?: string[];
  notes?: string;
  /** From data/health.json, written by scripts/healthcheck.mjs. Absent until the first check. */
  health?: Health;
}

export interface Health {
  status: 'up' | 'down' | 'unverified';
  failures: number;
  last_checked: string;
  last_ok?: string;
  reason?: string;
  moved_to?: string;
  repo?: { stars?: number; archived?: boolean; pushed_at?: string; missing?: boolean; renamed_to?: string };
}

const STALE_DAYS = 730;

/** Date of the last push if the repo has had none for two years, otherwise undefined. */
export function staleSince(tool: Tool): string | undefined {
  const pushed = tool.health?.repo?.pushed_at;
  if (!pushed || tool.health?.repo?.archived) return undefined;
  return Date.now() - Date.parse(pushed) > STALE_DAYS * 86_400_000 ? pushed : undefined;
}

/** Down, archived or missing: still listed, but flagged and sorted last. */
export const isBroken = (tool: Tool) =>
  tool.health?.status === 'down' || !!tool.health?.repo?.archived || !!tool.health?.repo?.missing;

// Every data/tools/*.yaml file, read at build time. The filename is the slug.
const files = import.meta.glob('../../data/tools/*.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const healthBySlug = health as Record<string, Health>;

export const tools: Tool[] = Object.entries(files)
  .map(([path, raw]) => {
    const slug = path.split('/').pop()!.replace(/\.yaml$/, '');
    return { ...(yaml.load(raw) as Omit<Tool, 'slug' | 'health'>), slug, health: healthBySlug[slug] };
  })
  .sort((a, b) => Number(isBroken(a)) - Number(isBroken(b)) || a.name.localeCompare(b.name));

export { taxonomy };

export const inputLabel = (key: string) => (taxonomy.inputs as Record<string, string>)[key] ?? key;
export const isInputKey = (key: string): key is InputKey => key in taxonomy.inputs;

export function toolsTaking(input: string, except?: string): Tool[] {
  return tools.filter((t) => t.slug !== except && (t.inputs as string[]).includes(input));
}

/** Input types that have at least one tool, in taxonomy order, with counts. */
export function usedInputs(): { key: InputKey; label: string; count: number }[] {
  return (Object.keys(taxonomy.inputs) as InputKey[])
    .map((key) => ({ key, label: taxonomy.inputs[key], count: toolsTaking(key).length }))
    .filter((i) => i.count > 0);
}
