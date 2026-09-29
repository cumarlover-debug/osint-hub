// Typed wrapper around shared/case.mjs, which holds the pivot, capability and report logic. The page imports
// this; the tests import shared/case.mjs directly, so both run the same implementation.
import * as core from '../../shared/case.mjs';

export type FindingStatus = 'todo' | 'ran' | 'found' | 'deadend';
export type Shell = 'posix' | 'powershell';

/** The shape /case embeds for every tool: only what the capability map needs. */
export interface CaseTool {
  slug: string;
  name: string;
  category: string;
  inputs: string[];
  passive: boolean;
  account_required: boolean;
  cost: string;
  query_template?: unknown;
  command_template?: unknown;
  install?: string;
  tags?: string[];
  status?: string;
}

export interface Pivot {
  value: string;
  type: string;
  via: string;
  guess: boolean;
}

export interface CapabilityRow {
  slug: string;
  name: string;
  category: string;
  passive: boolean;
  account: boolean;
  cost: string;
  sensitive: boolean;
  status?: string;
  kind: 'link' | 'command' | 'page';
  usable: boolean;
  why?: string;
  link?: string;
  command?: string;
  install?: string;
}

export interface RowSummary {
  total: number;
  passive: number;
  active: number;
  account: number;
  paid: number;
  links: number;
  commands: number;
  pages: number;
  sensitive: number;
}

export interface DossierFinding {
  name: string;
  status: FindingStatus;
  note?: string;
  link?: string;
}

export interface DossierSection {
  value: string;
  type: string;
  via?: string;
  guess?: boolean;
  note?: string;
  rows?: CapabilityRow[];
  findings?: DossierFinding[];
}

export const SENSITIVE_TAGS = core.SENSITIVE_TAGS as string[];
export const FINDING_STATUS = core.FINDING_STATUS as Record<FindingStatus, { label: string; mark: string }>;

export const derivePivots = core.derivePivots as (raw: string, opts?: { candidates?: boolean }) => Pivot[];
export const capabilityRows = core.capabilityRows as (
  tools: CaseTool[],
  type: string,
  value: string,
  opts?: { safe?: boolean; shell?: Shell; order?: string[] },
) => CapabilityRow[];
export const summariseRows = core.summariseRows as (rows: CapabilityRow[]) => RowSummary;
export const groupByCategory = core.groupByCategory as (rows: CapabilityRow[], order?: string[]) => { category: string; rows: CapabilityRow[] }[];
export const isSensitive = core.isSensitive as (tool: { category: string; tags?: string[] }) => boolean;
export const dossierMarkdown = core.dossierMarkdown as (data: {
  title?: string;
  generated?: string;
  notes?: string;
  sections?: DossierSection[];
  safe?: boolean;
}) => string;
