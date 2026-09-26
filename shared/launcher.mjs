// Value detection and search-link building, shared by the website, the CLI and the browser extension.
// Plain JavaScript with no dependencies so every one of them can load it as is. The extension keeps a copy
// (extension/lib/launcher.mjs); `npm run validate` fails if the copy drifts from this file.

/** Value formats a template can be limited to. Keep in sync with MATCHERS in scripts/lib/data.mjs. */
export const MATCHERS = {
  eth: /^0x[0-9a-fA-F]{40}$/,
  btc: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  ipv4: /^(\d{1,3}\.){3}\d{1,3}$/,
  vin: /^[A-HJ-NPR-Z0-9]{17}$/,
};

export const MATCH_LABELS = {
  eth: 'Ethereum addresses',
  btc: 'Bitcoin addresses',
  ipv4: 'IPv4 addresses',
  vin: '17-character VINs',
};

/**
 * A tool's templates, one per input type it can search directly.
 * @param {string | Record<string, string | {url: string, match?: string}> | undefined} qt
 * @param {string[]} inputs
 * @returns {Record<string, {url: string, match?: string}>}
 */
export function templatesFor(qt, inputs) {
  if (!qt) return {};
  if (typeof qt === 'string') return Object.fromEntries(inputs.map((i) => [i, { url: qt }]));
  return Object.fromEntries(Object.entries(qt).map(([i, t]) => [i, typeof t === 'string' ? { url: t } : t]));
}

/** @param {{match?: string}} t @param {string} value */
export function applies(t, value) {
  return !t.match || MATCHERS[t.match].test(value.trim());
}

/** @param {{url: string}} t @param {string} value */
export function buildLink(t, value) {
  return t.url.replace('{query}', encodeURIComponent(value.trim()));
}

/**
 * Guesses what a value is, most likely first. Ambiguous values (a bare word could be a username or a company)
 * return several.
 * @param {string} raw
 * @returns {string[]}
 */
export function detect(raw) {
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

/**
 * Tools that can search `value` as `type`, usable first, then passive before active, then by name.
 * @template {{name: string, passive: boolean, inputs: string[], query_template?: any}} T
 * @param {T[]} tools
 * @param {string} type
 * @param {string} value
 * @param {{includeActive?: boolean}} [opts]
 * @returns {{tool: T, template: {url: string, match?: string}, usable: boolean, link?: string}[]}
 */
export function launchable(tools, type, value, { includeActive = false } = {}) {
  return tools
    .map((tool) => ({ tool, template: templatesFor(tool.query_template, tool.inputs)[type] }))
    .filter((r) => r.template && (includeActive || r.tool.passive))
    .map((r) => {
      const usable = applies(r.template, value);
      return { ...r, usable, ...(usable && { link: buildLink(r.template, value) }) };
    })
    .sort((a, b) => Number(!a.usable) - Number(!b.usable) || Number(!a.tool.passive) - Number(!b.tool.passive) || a.tool.name.localeCompare(b.tool.name));
}
