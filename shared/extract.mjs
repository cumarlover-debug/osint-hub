// Turns a tool's raw output into structured findings, which is the step that makes a profile possible: the runners
// capture text, and until something reads it, every case is a pile of logs.
//
// Two rules shape everything here.
//
// 1. Secrets are removed on the way in. A case file is copied, retained and shared, and a breach result containing
//    a working credential turns the investigation itself into a liability. Passwords are replaced, combolist lines
//    are cut, and a password hash is recorded as a masked fact rather than a usable one.
// 2. Everything is a candidate. A regex cannot tell "this account belongs to the target" from "this site answers
//    for anybody", so findings carry the tool, the line they came from and a fixed confidence of `candidate`.
//    Promotion to a conclusion is a person's job, recorded in the case file.

/** The kinds of thing a finding can be. Kept in step with the taxonomy's inputs, plus breach and document. */
export const KINDS = [
  'account',
  'email',
  'username',
  'phone',
  'name',
  'org',
  'domain',
  'ip',
  'location',
  'url',
  'breach',
  'document',
  'hash',
  'crypto_address',
  'vehicle',
  'vessel',
  'aircraft',
  'social_post',
];

/** Field names whose value must never be stored. */
const SECRET_FIELD = /\b(pass(?:word|wd|phrase)?|pwd|secret|token|api[-_ ]?key|apikey|auth(?:entication)?|cookie|session[-_ ]?id)\b\s*[:=]\s*(.+)/gi;
/** Combolists: "address:password" or "address;password", sometimes with more fields after. */
const COMBO_LINE = /\b([\w.+-]+@[\w.-]+\.[a-z]{2,})\s*[:;]\s*(\S+)/gi;
/** A hash on its own is a fact about a credential, so it is recorded masked: enough to say one exists, not enough
 *  to use it. */
const HASH = /\b([a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})\b/gi;

const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const URL = /\bhttps?:\/\/[^\s"'<>()\][]+/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const HANDLE = /(?:^|[\s(])@([a-z0-9][a-z0-9._-]{2,30})\b/gi;
// Phone numbers, conservatively: either an international prefix, or separators between groups. A bare run of digits
// is almost always an identifier, a timestamp or a hash fragment, and calling one of those a phone number is how a
// profile fills up with noise.
const PHONE = /(?<!\w)(?:\+\d[\d ().-]{7,18}\d|\(?\d{2,4}\)?[ .-]\d[\d ().-]{5,14}\d)(?!\w)/g;
const CRYPTO = /\b(?:0x[a-f0-9]{40}|bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g;

/** Terminal colour and cursor codes. Tools print them, and left in place they end up inside extracted values:
 *  h8mail's output turned "someone@example.com" into "0msomeone@example.com". */
export const stripAnsi = (text) => String(text ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

/** Tool families whose output needs a pattern more specific than "a URL is present". */
const FAMILIES = [
  { name: 'account', re: /maigret|sherlock|blackbird|nexfil|user-scanner|social-analyzer|whatsmyname|tookie|sylva|namecheckup|osrframework|usersearch|ghunt|tinfoleak|socialscan|namechk|octosearch/i },
  { name: 'breach', re: /h8mail|leaker|dehashed|leakradar|leakcheck|snusbase|intel-?x|intelligence-x|mosint|zehef|breachdirectory|gosearch|hudson-rock|infostealer|checkleaked|dropbase|leakix|vigilante|pwned|breach/i },
  { name: 'phone', re: /phoneinfoga|phonerator|phone-validator|truecaller|sync-?me|shouldianswer/i },
  { name: 'email', re: /holehe|mailcat|emailrep|epieos|hibp|haveibeenpwned|firefox-breach|mozilla-monitor|email-hippo|mailaccess/i },
  { name: 'metadata', re: /exiftool|exif|metadata|jpegsnoop|fotoforensics|invid/i },
];

/** Mask a password hash: the reader learns one exists, and nobody learns the value. */
export const maskHash = (h) => `${h.slice(0, 8)}…(${h.length} hex chars)`;

/** Remove anything that would be a credential if the case file were read by someone else. */
export function redactSecrets(text) {
  return stripAnsi(text)
    .replace(SECRET_FIELD, (_m, field) => `${field}: [redacted]`)
    .replace(COMBO_LINE, (_m, address) => `${address}:[redacted]`)
    .replace(HASH, (m) => maskHash(m));
}

/** Is this line about a site where an account was found, as opposed to one that was merely checked? */
const FOUND_MARK = /\[\+\]|\[\*\]|found|exists|registered|taken|present|hit\b|✓|yes\b/i;
const NOT_FOUND_MARK = /not found|no results?|nothing|absent|available|unregistered|\[-\]|✗|unknown|error|blocked|timeout/i;

const trim = (s, n = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Finds the findings in one tool's output.
 *
 * @param {{ slug: string, name?: string, text: string, value: string, at?: string, source?: string }} input
 * @returns {Array<{kind: string, value: string, confidence: 'candidate', tool: string, evidence: string, at?: string}>}
 */
export function extractFindings({ slug, name, text, value, at, source }) {
  const tool = slug ?? name ?? 'unknown';
  const raw = stripAnsi(String(text ?? ''));
  const safe = redactSecrets(raw);
  const family = FAMILIES.find((f) => f.re.test(tool))?.name;
  const out = [];
  const seen = new Set();
  const accountUrls = new Set();
  const add = (kind, found, evidence) => {
    const v = trim(found, 300);
    if (!v) return;
    // A URL that already came back as a found account is the account, not a second finding.
    if (kind === 'url' && accountUrls.has(v.toLowerCase())) return;
    const key = `${kind}\u0000${v.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (kind === 'account') accountUrls.add(v.toLowerCase());
    out.push({ kind, value: v, confidence: 'candidate', tool, evidence: trim(evidence, 220), ...(at && { at }), ...(source && { source }) });
  };

  // Line-level reading first: a marked line names an account, and the URL on it is the evidence.
  for (const line of safe.split('\n')) {
    const l = line.trim();
    if (!l || l.length > 400) continue;
    const urls = l.match(URL) ?? [];
    if (family === 'account' && FOUND_MARK.test(l) && !NOT_FOUND_MARK.test(l)) {
      for (const u of urls) add('account', u, l);
      const handle = (l.match(HANDLE) ?? [])[0];
      if (handle && !urls.length) add('username', handle.replace(/^@/, ''), l);
      continue;
    }
    if (family === 'breach' && FOUND_MARK.test(l) && !/no (results?|breaches)|not found|clean/i.test(l)) {
      // The breach itself is the finding; the line's credentials were already cut by redactSecrets.
      add('breach', trim(l, 160), l);
      continue;
    }
    if (family === 'phone' && /carrier|operator|country|location|line type|footprint/i.test(l)) {
      add('phone', trim(l, 160), l);
      continue;
    }
    if (family === 'email' && FOUND_MARK.test(l) && !NOT_FOUND_MARK.test(l) && /registered|exists|account|profile/i.test(l)) {
      const addresses = l.match(EMAIL) ?? [];
      for (const a of addresses) add('email', a, l);
      if (!addresses.length) add('account', trim(l, 160), l);
      continue;
    }
    if (family === 'metadata' && /^[A-Za-z][A-Za-z0-9 _/-]{2,30}\s*[:=]/.test(l)) {
      add('document', trim(l, 160), l);
      continue;
    }
  }

  // Then the generic sweep, which every tool contributes to: addresses, links, addresses on the network, handles,
  // wallets and phone-shaped strings.
  for (const m of safe.match(EMAIL) ?? []) add('email', m, m);
  for (const m of safe.match(URL) ?? []) add('url', m.replace(/[.,)]+$/, ''), m);  for (const m of safe.match(CRYPTO) ?? []) add('crypto_address', m, m);
  for (const m of safe.match(IPV4) ?? []) if (!/^0\./.test(m)) add('ip', m, m);
  for (const m of safe.match(HANDLE) ?? []) add('username', m.replace(/^@/, ''), m);
  for (const m of safe.match(PHONE) ?? []) {
    const digits = m.replace(/[^\d+]/g, '');
    const bare = m.replace(/[\s().-]/g, '');
    // A phone number needs a country code or separators, and a plausible number of digits: anything else is an
    // identifier that happens to be numeric.
    const shaped = m.includes('+') || /[\s().-]/.test(m.trim());
    if (shaped && /^\+?\d{9,15}$/.test(bare) && !/^(\+?\d{10}|\+?\d{13})$/.test(digits)) add('phone', bare, m);
  }

  // The target itself is not a finding; it is the thing being investigated.
  const self = String(value ?? '').toLowerCase();
  return out.filter((f) => f.value.toLowerCase() !== self).slice(0, 400);
}

/** Counts by kind, for the profile summary and the report header. */
export function summariseFindings(findings) {
  const byKind = {};
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  return { total: findings.length, byKind };
}
