// Assigning work in your own words.
//
// The agent can already decide what is appropriate from the capability data, but "appropriate" is not the same as
// "wanted": a case with a username in it has forty tools that could be pointed at it, and the investigator knows
// which question they are actually asking. A task is that question, written down.
//
// The mapping is deliberately deterministic and readable rather than clever. An investigator can see exactly which
// question maps to which part of the directory - and when their words match nothing, the agent says so instead of
// guessing at a family of tools and spending a budget on it.
import { capabilityRows } from './case.mjs';

/**
 * What a task can be about. Each entry names the categories and input types it draws on, using the taxonomy's own
 * keys, so the mapping cannot drift from the directory it is mapping.
 */
export const INTENTS = [
  {
    id: 'accounts',
    label: 'accounts and profiles',
    re: /\b(accounts|account|profiles|profile|social|handles|handle|signed up|signup|registrations|registration|usernames|username)/i,
    // Account discovery is filed under both: a username sweep lives in social media, and the tools that answer "does
    // this address have an account here" are email tools.
    categories: ['social-media', 'email'],
    inputs: ['username', 'email', 'phone', 'name'],
  },
  {
    id: 'breach',
    label: 'breaches and leaks',
    re: /\b(breach|breaches|leak|leaks|leaked|pwned|compromis\w*|dump|dumps|stealer|password|passwords|credential)/i,
    categories: ['breach'],
    inputs: ['email', 'phone', 'username', 'domain', 'keyword', 'password'],
  },
  {
    id: 'infrastructure',
    label: 'domains, hosts and certificates',
    re: /\b(infrastructure|subdomain|subdomains|dns|certificate|certificates|host|hosts|server|servers|port|ports|network|netblock|asset|assets|attack surface)/i,
    categories: ['domain', 'network'],
    inputs: ['domain', 'ip', 'url'],
  },
  {
    id: 'mail',
    label: 'email addresses and patterns',
    // The bare word "email" names a target far more often than it asks for the mail family, so this one wants the
    // language of pattern-finding: "harvest", "email addresses", "naming convention".
    re: /\b(harvest\w*|email address(es)?|e-?mail pattern|address pattern|naming (?:convention|pattern)|email format)\b/i,
    categories: ['email'],
    inputs: ['domain', 'name', 'company', 'email'],
  },
  {
    id: 'identity',
    label: 'identity and background',
    re: /\b(identity|who is|whose|real name|person|people|background|namesake|criminal|court|record|records)\b/i,
    categories: ['people'],
    inputs: ['username', 'email', 'phone', 'name'],
  },
  {
    id: 'business',
    label: 'companies and ownership',
    re: /\b(company|companies|business|corporate|registration|filing|filings|organisation|organization|director|ownership|shareholders)\b/i,
    categories: ['business'],
    inputs: ['company', 'name', 'domain'],
  },
  {
    id: 'media',
    label: 'images, video and metadata',
    re: /\b(image|images|photo|photos|picture|video|reverse image|exif|metadata|document|documents|pdf|file|files|audio)\b/i,
    categories: ['image-video', 'metadata'],
    inputs: ['image', 'video', 'document', 'url', 'audio'],
  },
  {
    id: 'places',
    label: 'places and movement',
    // "map" is a verb as often as it is a noun - "map the infrastructure" is not a request for cartography - so the
    // geographic reading needs a noun phrase ("the map", "maps of") or one of the unambiguous words.
    re: /\b(location|locations|geolocat\w*|where|place|places|coordinates?|gps|travel|isochrone|distance|nearby|satellite|street ?view|the map|maps? of)\b/i,
    categories: ['geolocation'],
    inputs: ['location', 'image', 'social_post', 'vehicle', 'vessel', 'aircraft'],
  },
  {
    id: 'crypto',
    label: 'crypto addresses',
    re: /\b(crypto|wallet|wallets|bitcoin|btc|ethereum|eth|blockchain|transaction|transactions)\b/i,
    categories: ['crypto'],
    inputs: ['crypto_address', 'keyword'],
  },
  {
    id: 'transport',
    label: 'vehicles, aircraft and vessels',
    re: /\b(vehicle|vehicles|plate|plates|car|aircraft|flight|flights|tail number|vessel|vessels|ship|ships|boat|imo|mmsi|maritime|aviation)\b/i,
    categories: ['transport'],
    inputs: ['vehicle', 'aircraft', 'vessel'],
  },
  {
    id: 'hidden',
    label: 'hidden services and pastes',
    re: /\b(dark ?web|onion|tor\b|paste|pastes|pastebin|hidden service|criminal|marketplace|forum|forums)\b/i,
    categories: ['archives', 'breach', 'threat-intel'],
    inputs: ['keyword', 'email', 'username', 'domain'],
  },
  {
    id: 'threat',
    label: 'threat intelligence and exposure',
    re: /\b(threat|malware|exposure|exposed|attacker|ioc|iocs|ransomware|vulnerab\w*|exploit|c2|botnet)\b/i,
    categories: ['threat-intel', 'code-security'],
    inputs: ['domain', 'ip', 'url', 'hash', 'keyword'],
  },
  {
    id: 'opsec',
    label: 'protecting the investigation',
    re: /\b(opsec|hardening|protect|protection|anonymous|anonymity|burner|encrypt\w*|hygiene|sock puppet|sockpuppet)\b/i,
    categories: ['opsec', 'surveillance'],
    inputs: [],
  },
  {
    id: 'phone',
    label: 'telephone numbers',
    re: /\b(phone|phone number|mobile|carrier|sim|telephone|call|sms|whatsapp|telegram)\b/i,
    categories: ['phone'],
    inputs: ['phone'],
  },
  {
    id: 'everything',
    label: 'everything the playbook covers',
    // "every account" is not "everything", and "full name" is not a request for the full sweep: the catch-all wants
    // the words that only mean breadth.
    re: /\b(everything|all of it|all the things|full (?:check|run|sweep|pass|profile|work ?up)|complete|exhaustive|thorough|nothing in particular)\b/i,
    categories: [],
    inputs: [],
  },
];

/** Words that introduce a value rather than an intent, so "check the email for breaches" keeps the breach intent.
 *  Anchored, and deliberately without the global flag: a /g/ regex used with test() in a loop carries lastIndex
 *  between calls, which silently drops matches. */
const FILLER = /^(for|on|of|about|against|check|look|find|search|investigate|see|trace|scan|map|verify|please|this|that|the|a|an|and|or|with|it|its|them|their|is|are|was|were|be|been|has|have|had|do|does|did|who|what|really|actually|exactly|then|also|anything|something|all|any|every)$/i;

/** What an investigator might call an input type, when it is not the key itself. */
const TYPE_ALIASES = {
  username: /user ?names?|handles?|nicknames?/i,
  email: /e-?mails?/i,
  phone: /phones?|mobiles?|telephone|numbers?/i,
  name: /names?|full name/i,
  url: /urls?|links?|web ?pages?/i,
  domain: /domains?|websites?|sites?/i,
  ip: /ip( address(es)?)?/i,
  image: /images?|photos?|pictures?/i,
  video: /videos?|footage/i,
  document: /documents?|files?|pdfs?/i,
  company: /compan(y|ies)|businesses?|organisations?|organizations?/i,
  crypto_address: /crypto ?address(es)?|wallets?/i,
  social_post: /posts?|tweets?|comments?/i,
  location: /locations?|places?|addresses?/i,
  vehicle: /vehicles?|plates?|cars?/i,
  aircraft: /aircraft|planes?|flights?|tail numbers?/i,
  vessel: /vessels?|ships?|boats?/i,
  hash: /hashes?|checksums?/i,
  password: /passwords?/i,
  wifi: /wi-?fi|bssid|ssid|access points?/i,
  audio: /audio|recordings?|voice/i,
  keyword: /keywords?|topics?/i,
};

/** Does the sentence name this input type? Used to narrow a task to the identifier it is actually about. */
export function typeMentioned(text, type) {
  const sentence = String(text ?? '');
  const fromKey = new RegExp(`\\b${String(type).replace(/_/g, '[ _-]?')}s?\\b`, 'i');
  return fromKey.test(sentence) || Boolean(TYPE_ALIASES[type]?.test(sentence));
}

/**
 * Which families of work a sentence is asking about, in the order they appear in the text.
 *
 * @returns {Array<{id: string, label: string}>} empty when nothing matched, which the caller must report rather than
 *          substitute a default for.
 */
export function matchIntents(text) {
  const sentence = String(text ?? '');
  const hits = [];
  for (const intent of INTENTS) {
    const m = sentence.match(intent.re);
    if (!m) continue;
    hits.push({ id: intent.id, label: intent.label, at: m.index ?? 0 });
  }
  return hits.sort((a, b) => a.at - b.at).map(({ id, label }) => ({ id, label }));
}

/** The words in a task that are not intents, values or filler: what is left is what the agent could not place. */
export function unplacedWords(text, matched) {
  // Word by word: replacing whole phrases leaves the tail of a longer form behind ("accounts" minus "account" is "s").
  const words = matched.flatMap((m) => INTENTS.find((x) => x.id === m.id)?.re ?? []);
  return String(text ?? '')
    .split(/\s+/)
    .filter((word) => word && !FILLER.test(word) && !words.some((re) => new RegExp(`^${re.source}$`, re.flags.replace('g', '')).test(word)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Which of the case's identifiers a task is about.
 *
 * Naming a value wins; otherwise every value whose type the intents can use; otherwise every value in the case. The
 * result is never "no targets" for a case that has values, because a task with no target is a task about the case.
 */
export function taskTargets(text, values, intents) {
  const list = values ?? [];
  if (!list.length) return [];
  const sentence = String(text ?? '').toLowerCase();
  // A value counts as named when it stands on its own, not when it sits inside a longer one: asking about
  // ada@example.org is not also asking about example.org, and treating it as both drags in a second family of tools.
  const named = list.filter((v) => {
    const needle = String(v.value ?? '').toLowerCase();
    if (!needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\w.@-])${escaped}(?![\\w.@-])`, 'i').test(sentence);
  });
  if (named.length) return named;
  // Naming the kind of identifier is nearly as specific as naming the identifier: "check the email for breaches" is
  // about the email in the case, not about every value a breach tool could take.
  const mentioned = list.filter((v) => typeMentioned(sentence, v.type));
  if (mentioned.length) return mentioned;
  const wanted = new Set(intents.flatMap((i) => INTENTS.find((x) => x.id === i.id)?.inputs ?? []));
  const typed = wanted.size ? list.filter((v) => wanted.has(v.type)) : [];
  return typed.length ? typed : list;
}

/**
 * Turn a task into the work it implies.
 *
 * @returns {{text, intents, values, matched, perValue, counts, unplaced}} where `perValue` carries the tool rows the
 *          task should draw on, ready for the same plan/run/hands machinery everything else uses.
 */
export function resolveTask({ text, values, tools, taxonomy, shell = 'posix', safe = false, order = [] }) {
  const intents = matchIntents(text);
  const targets = taskTargets(text, values, intents);
  const categories = new Set();
  const inputs = new Set();
  for (const intent of intents) {
    const def = INTENTS.find((x) => x.id === intent.id);
    if (!def) continue;
    for (const c of def.categories) categories.add(c);
    for (const i of def.inputs) inputs.add(i);
  }
  // "Everything on this username" is about the username and about everything: asking for the whole playbook while
  // naming a value word, which the vocabulary would otherwise read as a request for one family.
  const broad = !categories.size || intents.some((i) => i.id === 'everything');
  const perValue = targets.map((v) => {
    // A task nobody could place proposes nothing. Falling back to "every tool that takes this value" would spend a
    // budget on a family of work the investigator never asked for, and hide the fact that it was not understood.
    if (!intents.length) return { value: v, rows: [] };
    const rows = capabilityRows(tools, v.type, v.value, { safe, shell, order }).filter((r) => {
      if (broad) return true;
      const tool = tools.find((t) => t.slug === r.slug) ?? {};
      return categories.has(tool.category);
    });
    return { value: v, rows };
  });
  const allRows = perValue.flatMap((p) => p.rows);
  // Words the task used to name its target are placed, not unplaced: "check the email" is understood, and reporting
  // "email" back as something the agent could not read would be misleading.
  const vocab = new RegExp(
    `^(${targets
      .flatMap((v) => [String(v.type).replace(/_/g, '[ _-]?'), TYPE_ALIASES[v.type]?.source].filter(Boolean))
      .join('|')})$`,
    'i',
  );
  const unplaced = unplacedWords(text, intents)
    .split(/\s+/)
    .filter((w) => w && !vocab.test(w))
    .join(' ');
  return {
    text: String(text ?? '').trim(),
    intents,
    values: targets.map((v) => v.value),
    matched: intents.length > 0,
    perValue,
    unplaced,
    counts: {
      tools: allRows.length,
      runnable: allRows.filter((r) => r.kind === 'command' && r.command && !r.manual).length,
      fetchable: allRows.filter((r) => r.kind === 'link' && r.link && !r.manual).length,
      byHand: allRows.filter((r) => r.manual).length,
    },
  };
}

/** How much of a task's work has already been tried, judged from the profile's run record. */
export function taskProgress(task, profile) {
  const runs = profile?.runs ?? {};
  let done = 0;
  for (const value of task.values ?? []) {
    const tried = new Set(Object.keys(runs[value] ?? {}));
    for (const slug of task.slugs ?? []) if (tried.has(slug)) done += 1;
  }
  const total = (task.values?.length ?? 0) * (task.slugs?.length ?? 0);
  return { done, total, left: Math.max(0, total - done) };
}
