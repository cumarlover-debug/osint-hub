// Shared machinery for proving that a search link still works: a harmless value per input type, a second
// deliberately different one, and the fetch that asks whether the page echoed either back.
//
// Used by two scripts on purpose. `query-templates.mjs` discovers new templates and needs it to prove a candidate
// is real; `template-check.mjs` re-tests the ones already published, because a search URL that worked when it was
// added can rot quietly when the site changes its parameters.
import { TIMEOUT_MS, UA } from './net.mjs';

/**
 * A harmless value to search for, per input type. Types that have no sensible GET search value (an image, a
 * password, a wallet) are left out: there is nothing to type into a search box to prove the template works.
 */
export const TEST_VALUES = {
  keyword: 'osint',
  username: 'osint',
  name: 'John Smith',
  company: 'Cloudflare',
  domain: 'example.com',
  ip: '8.8.8.8',
  url: 'https://example.com',
  email: 'test@example.com',
  phone: '+12025550123',
  location: 'London',
  crypto_address: `0x${'1'.repeat(40)}`,
  vehicle: '1HGCM82633A004352',
  aircraft: 'N12345',
  vessel: 'IMO 9074729',
  hash: 'd41d8cd98f00b204e9800998ecf8427e',
};

/** A second, deliberately different value per type: a page that echoes both really is reading the query. */
export const SECOND_VALUES = {
  keyword: 'needlefish',
  username: 'needlefish',
  name: 'Ada Lovelace',
  company: 'Wikimedia',
  domain: 'iana.org',
  ip: '1.1.1.1',
  url: 'https://www.iana.org',
  email: 'ada@iana.org',
  phone: '+442079460958',
  location: 'Reykjavik',
  crypto_address: `0x${'2'.repeat(40)}`,
  vehicle: '5YJ3E1EA7HF000337',
  aircraft: 'D-ABCD',
  vessel: 'IMO 9321483',
  hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};

/**
 * Did the page come back with the value we searched for? Tries the raw, %-encoded and form-encoded spellings.
 * Search boxes are stripped first: a value echoed back into the box it came from proves only that the page has a
 * form, not that the search ran.
 */
export function echoed(body, value) {
  const hay = body.replace(/<input\b[^>]*>/gi, ' ').toLowerCase();
  return [value, encodeURIComponent(value), value.replace(/ /g, '+')].some((v) => hay.includes(v.toLowerCase()));
}

/** Fetches a template filled in with one value. { ok: false } means the URL is not a working search URL. */
export async function fetchSearch(template, value) {
  const url = template.replace('{query}', encodeURIComponent(value));
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    if (!res.ok) {
      res.body?.cancel?.().catch(() => {});
      return { ok: false, http: res.status };
    }
    const body = await res.text().catch(() => '');
    return {
      ok: true,
      http: res.status,
      finalUrl: res.url,
      challenged: res.headers.has('cf-mitigated') || /cloudflare|ddos-guard/i.test(res.headers.get('server') ?? ''),
      echoed: echoed(body, value),
    };
  } catch {
    return { ok: false };
  }
}

/** The template to test for one input type: a plain string applies to every input, an object is keyed by input. */
export const templateFor = (template, input) =>
  typeof template === 'string' ? template : (template?.[input] ?? undefined);
