// Shared by the launcher page and the per-tool search box. Runs in the browser: nothing here sends the query anywhere.

export type Template = { url: string; match?: MatcherName };
export type QueryTemplate = string | Record<string, string | Template>;

/** Value formats a template can be limited to. Kept in sync with MATCHERS in scripts/lib/data.mjs. */
export const MATCHERS = {
  eth: /^0x[0-9a-fA-F]{40}$/,
  btc: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  ipv4: /^(\d{1,3}\.){3}\d{1,3}$/,
  vin: /^[A-HJ-NPR-Z0-9]{17}$/,
};
export type MatcherName = keyof typeof MATCHERS;

export const MATCH_LABELS: Record<MatcherName, string> = {
  eth: 'Ethereum addresses',
  btc: 'Bitcoin addresses',
  ipv4: 'IPv4 addresses',
  vin: '17-character VINs',
};

/** A tool's templates, one per input type it can search directly. */
export function templatesFor(qt: QueryTemplate | undefined, inputs: string[]): Record<string, Template> {
  if (!qt) return {};
  if (typeof qt === 'string') return Object.fromEntries(inputs.map((i) => [i, { url: qt }]));
  return Object.fromEntries(Object.entries(qt).map(([i, t]) => [i, typeof t === 'string' ? { url: t } : t]));
}

export function applies(t: Template, value: string): boolean {
  return !t.match || MATCHERS[t.match].test(value.trim());
}

export function buildLink(t: Template, value: string): string {
  return t.url.replace('{query}', encodeURIComponent(value.trim()));
}

/**
 * Guesses what a pasted value is, most likely first. Ambiguous values (a bare word could be a username or a
 * company) return several; the page lets the visitor switch.
 */
export function detect(raw: string): string[] {
  const v = raw.trim();
  if (!v) return [];
  if (/^https?:\/\//i.test(v)) {
    return /\.(jpe?g|png|gif|webp|bmp|avif)(\?|$)/i.test(v) ? ['image', 'url'] : /youtube\.com|youtu\.be/i.test(v) ? ['video', 'url'] : ['url'];
  }
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v)) return ['email'];
  if (MATCHERS.ipv4.test(v) || (/^[0-9a-f:]+$/i.test(v) && v.split(':').length > 2)) return ['ip'];
  if (/^([a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})$/i.test(v)) return ['hash'];
  if (MATCHERS.eth.test(v) || MATCHERS.btc.test(v)) return ['crypto_address'];
  if (MATCHERS.vin.test(v) && /\d/.test(v) && /[A-Z]/.test(v)) return ['vehicle'];
  if (/^(?!-)([a-z0-9-]+\.)+[a-z]{2,}$/i.test(v)) return ['domain'];
  if (/^\+?\d[\d\s().-]{6,}$/.test(v)) return ['phone'];
  if (/\s/.test(v)) return ['name', 'company', 'location'];
  return ['username', 'company', 'aircraft', 'vessel'];
}
