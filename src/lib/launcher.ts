// Typed wrapper around shared/launcher.mjs, which the CLI and browser extension use too.
import * as core from '../../shared/launcher.mjs';

export type MatcherName = 'eth' | 'btc' | 'ipv4' | 'vin';
export type Template = { url: string; match?: MatcherName };
export type QueryTemplate = string | Record<string, string | Template>;

export const MATCHERS = core.MATCHERS as Record<MatcherName, RegExp>;
export const MATCH_LABELS = core.MATCH_LABELS as Record<MatcherName, string>;
export const templatesFor = core.templatesFor as (qt: QueryTemplate | undefined, inputs: string[]) => Record<string, Template>;
export const applies = core.applies as (t: Template, value: string) => boolean;
export const buildLink = core.buildLink as (t: Template, value: string) => string;
export const detect = core.detect as (raw: string) => string[];

export type Shell = 'posix' | 'powershell';
export const SHELLS = core.SHELLS as Record<Shell, string>;
export const commandTemplatesFor = core.commandTemplatesFor as (t: string | Record<string, string> | undefined, inputs: string[]) => Record<string, string>;
export const commandsFor = core.commandsFor as <T extends { name: string; inputs: string[]; passive: boolean }>(
  tools: T[],
  type: string,
  value: string,
  opts?: { shell?: Shell; includeActive?: boolean },
) => { problem: string; rows: { tool: T; command: string; docker?: string }[] };
