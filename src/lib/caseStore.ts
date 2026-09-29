// Cases live only in this browser, like the toolkit. Storage can be unavailable (private mode, blocked site
// data), so every access is guarded. The case model itself lives in shared/case.mjs so the tests can exercise
// it; this file only moves it in and out of localStorage and backup files.
import {
  CASE_SCHEMA,
  sanitiseCaseState,
  emptyCaseState,
  newCaseFile,
  activeCase as active,
  uid,
} from '../../shared/case.mjs';
import type { FindingStatus } from './case';

export const CHANGED = 'osint-hub:cases-changed';
const KEY = 'osint-hub:cases';

export interface CaseValue {
  id: string;
  value: string;
  type: string;
  /** Set when the value was derived from another one. */
  via?: string;
  /** True for a candidate (an inferred username), which the report labels as such. */
  guess?: boolean;
  note?: string;
}

export interface Finding {
  valueId: string;
  slug: string;
  status: FindingStatus;
  note?: string;
  at: string;
}

export interface CaseFile {
  id: string;
  title: string;
  created: string;
  updated: string;
  notes: string;
  safe: boolean;
  values: CaseValue[];
  findings: Finding[];
}

export interface CaseState {
  schema: number;
  activeId: string | null;
  cases: CaseFile[];
}

export const newCase = newCaseFile as (title?: string) => CaseFile;
export const emptyState = emptyCaseState as () => CaseState;
export const sanitise = sanitiseCaseState as (raw: unknown) => CaseState;
export const activeCase = active as (state: CaseState) => CaseFile;
export { uid };

export function readState(): CaseState {
  try {
    return sanitiseCaseState(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return emptyCaseState() as CaseState;
  }
}

export function writeState(state: CaseState): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...state, schema: CASE_SCHEMA }));
    window.dispatchEvent(new CustomEvent(CHANGED));
    return true;
  } catch {
    return false;
  }
}

export const backupJSON = (state: CaseState) =>
  JSON.stringify({ schema: CASE_SCHEMA, exported: new Date().toISOString(), ...state }, null, 2);

export function restoreJSON(text: string): { state?: CaseState; error?: string } {
  try {
    return { state: sanitiseCaseState(JSON.parse(text)) };
  } catch {
    return { error: 'That file is not valid JSON.' };
  }
}
