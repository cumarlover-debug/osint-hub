import yaml from 'js-yaml';
import { tools, isInputKey, inputLabel, type Tool, type InputKey } from './tools';

export interface Step {
  title: string;
  input?: InputKey;
  why: string;
  do: string;
  look_for?: string[];
  tools: string[];
  opsec?: string;
}

export interface Playbook {
  slug: string;
  title: string;
  summary: string;
  starts_with: InputKey;
  for: string;
  time: string;
  steps: Step[];
}

const files = import.meta.glob('../../data/playbooks/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export const playbooks: Playbook[] = Object.entries(files)
  .map(([path, raw]) => ({ ...(yaml.load(raw) as Omit<Playbook, 'slug'>), slug: path.split('/').pop()!.replace(/\.yaml$/, '') }))
  .sort((a, b) => a.title.localeCompare(b.title));

const bySlug = new Map(tools.map((t) => [t.slug, t]));
export const toolBySlug = (slug: string) => bySlug.get(slug)!;

export const playbooksUsing = (slug: string) => playbooks.filter((p) => p.steps.some((s) => s.tools.includes(slug)));
export const playbooksStartingWith = (input: string) => playbooks.filter((p) => p.starts_with === input);

/**
 * Pivot map for an input type: what the tools that take it can give you, as other input types,
 * and which tools produce each one. Sorted by how many tools lead there.
 */
export function pivotsFrom(input: string): { to: InputKey; label: string; via: Tool[] }[] {
  const byOutput = new Map<InputKey, Tool[]>();
  for (const t of tools) {
    if (!(t.inputs as string[]).includes(input)) continue;
    for (const o of t.outputs ?? []) {
      if (!isInputKey(o) || o === input) continue;
      byOutput.set(o, [...(byOutput.get(o) ?? []), t]);
    }
  }
  return [...byOutput.entries()]
    .map(([to, via]) => ({ to, label: inputLabel(to), via }))
    .sort((a, b) => b.via.length - a.via.length || a.label.localeCompare(b.label));
}
