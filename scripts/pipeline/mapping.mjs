// Maps a source list's section to our category and input types.
// Each rule: [pattern matched against the section path, { category, inputs, confidence, flags? }] or null to skip.
// First match wins, so put specific patterns before general ones.

const skip = null;

/** awesome-osint: "H2 > H3" section headings. */
export const awesomeRules = [
  [/Username Check/i, { category: 'social-media', inputs: ['username'], confidence: 'high' }],
  [/Email Search/i, { category: 'email', inputs: ['email'], confidence: 'high' }],
  [/Phone Number/i, { category: 'phone', inputs: ['phone'], confidence: 'high' }],
  [/Vehicle|Automobile/i, { category: 'transport', inputs: ['vehicle'], confidence: 'high' }],
  [/Maritime/i, { category: 'transport', inputs: ['vessel'], confidence: 'high' }],
  [/Company Research/i, { category: 'business', inputs: ['company'], confidence: 'high' }],
  [/^DNS/i, { category: 'domain', inputs: ['domain'], confidence: 'high' }],
  [/Domain and IP/i, { category: 'domain', inputs: ['domain', 'ip'], confidence: 'medium' }],
  [/Similar Sites/i, { category: 'domain', inputs: ['domain'], confidence: 'medium' }],
  [/Web History|Website Capture/i, { category: 'archives', inputs: ['url'], confidence: 'high' }],
  [/Image Search/i, { category: 'image-video', inputs: ['image'], confidence: 'high' }],
  [/Image Analysis/i, { category: 'image-video', inputs: ['image'], confidence: 'high' }],
  [/Video Search|Video Tools/i, { category: 'image-video', inputs: ['video'], confidence: 'medium' }],
  [/Geospatial|Mapping/i, { category: 'geolocation', inputs: ['location'], confidence: 'medium' }],
  [/Threat Intelligence/i, { category: 'threat-intel', inputs: ['ip', 'domain'], confidence: 'low' }],
  [/Data Breach/i, { category: 'email', inputs: ['email'], confidence: 'medium', flags: ['policy-leak: breach data, listed with a responsible-use notice'] }],
  [/People Investigations/i, { category: 'people', inputs: ['name'], confidence: 'medium', flags: ['policy-people: people search, check it is not a doxxing service'] }],
  [/Social Media Tools > /i, { category: 'social-media', inputs: ['username', 'social_post'], confidence: 'low' }],
  [/Social Media Search/i, { category: 'social-media', inputs: ['username', 'social_post'], confidence: 'low' }],
  // Keyword search: search engines and topic search. Pastebins and dark-web search stay out (leaked data).
  [/Pastebin|Dark Web/i, skip],
  [/Code Search/i, { category: 'search', inputs: ['keyword'], confidence: 'high' }],
  [/General Search|Meta Search|Privacy Focused Search|Main National Search|Speciality Search|Visual Search|Document and Slides Search|File Search|Forums and Discussion|Blog Search|Keywords Discovery/i, { category: 'search', inputs: ['keyword'], confidence: 'medium' }],
  [/Academic|News Digest|^News$|Fact Checking/i, { category: 'research', inputs: ['keyword'], confidence: 'medium' }],
  [/Threat Actor Search/i, { category: 'threat-intel', inputs: ['keyword'], confidence: 'medium' }],
  // Courses, blogs, browsers, VPNs, datasets and the like take no input: out of scope.
  [/./, skip],
];

/** OSINT Framework: the tree path below the root, e.g. "Username > Username Search Engines". */
export const frameworkRules = [
  [/^Dating/i, skip], // too easily used for stalking
  [/^Username/i, { category: 'social-media', inputs: ['username'], confidence: 'high' }],
  [/^Email Address/i, { category: 'email', inputs: ['email'], confidence: 'high' }],
  [/^Domain Name/i, { category: 'domain', inputs: ['domain'], confidence: 'high' }],
  [/^IP & MAC/i, { category: 'network', inputs: ['ip'], confidence: 'high' }],
  [/^Cloud Infrastructure/i, { category: 'network', inputs: ['domain', 'ip'], confidence: 'low' }],
  [/^Images .* > .*Video/i, { category: 'image-video', inputs: ['video'], confidence: 'medium' }],
  [/^Images .* > .*Doc/i, { category: 'metadata', inputs: ['document'], confidence: 'medium' }],
  [/^Images/i, { category: 'image-video', inputs: ['image'], confidence: 'medium' }],
  [/^Social Networks/i, { category: 'social-media', inputs: ['username', 'social_post'], confidence: 'low' }],
  [/^Instant Messaging/i, { category: 'social-media', inputs: ['username'], confidence: 'low' }],
  [/^People Search/i, { category: 'people', inputs: ['name'], confidence: 'medium', flags: ['policy-people: people search, check it is not a doxxing service'] }],
  [/^Public Records/i, { category: 'people', inputs: ['name'], confidence: 'low', flags: ['policy-people: public records, check what personal data it exposes'] }],
  [/^Telephone/i, { category: 'phone', inputs: ['phone'], confidence: 'high' }],
  [/^Business Records|^Compliance/i, { category: 'business', inputs: ['company'], confidence: 'high' }],
  [/^Transportation > .*(Vehicle|Car|License)/i, { category: 'transport', inputs: ['vehicle'], confidence: 'high' }],
  [/^Transportation > .*(Air|Flight|Plane)/i, { category: 'transport', inputs: ['aircraft'], confidence: 'high' }],
  [/^Transportation > .*(Marine|Ship|Vessel|Maritime)/i, { category: 'transport', inputs: ['vessel'], confidence: 'high' }],
  [/^Geolocation/i, { category: 'geolocation', inputs: ['location'], confidence: 'medium' }],
  [/^Archives/i, { category: 'archives', inputs: ['url'], confidence: 'high' }],
  [/^Disinformation|Verification/i, { category: 'image-video', inputs: ['image', 'video', 'social_post'], confidence: 'low' }],
  [/^Blockchain|Cryptocurrency/i, { category: 'crypto', inputs: ['crypto_address'], confidence: 'high' }],
  [/^Malicious File/i, { category: 'threat-intel', inputs: ['hash', 'document'], confidence: 'medium' }],
  [/^Cyber Threat/i, { category: 'threat-intel', inputs: ['ip', 'domain'], confidence: 'low' }],
  [/^Dark Web|FTP Search/i, skip],
  [/^Search Engines > Code/i, { category: 'search', inputs: ['keyword'], confidence: 'high' }],
  [/^Search Engines > (Academic|News)/i, { category: 'research', inputs: ['keyword'], confidence: 'medium' }],
  [/^Search Engines > (General|Meta|Other|Search Tools)/i, { category: 'search', inputs: ['keyword'], confidence: 'medium' }],
  [/^Online Communities > (Forum|Blog|IRC) Search/i, { category: 'search', inputs: ['keyword'], confidence: 'medium' }],
  [/./, skip],
];

export function matchRule(rules, sectionPath) {
  for (const [pattern, rule] of rules) if (pattern.test(sectionPath)) return rule;
  return null;
}

// OSINT Framework entries describe their input in words ("Username or email"); pull out our input keys.
const inputWords = [
  [/user\s*name|handle|alias/i, 'username'],
  [/e-?mail/i, 'email'],
  [/phone|telephone|mobile number/i, 'phone'],
  // Only wording about a person: "place name", "vessel name", "domain name" etc. are not the name input.
  [/\b(person'?s?|people|full name|real name|individual'?s?|first and last name)\b/i, 'name'],
  [/domain|hostname|subdomain/i, 'domain'],
  [/\bip\b|ip address|ipv[46]|\bcidr\b|\basn?\b/i, 'ip'],
  [/\burl\b|web ?page|website address|link/i, 'url'],
  [/image|photo|picture/i, 'image'],
  [/video/i, 'video'],
  [/document|\bfile\b|pdf/i, 'document'],
  [/company|business|organi[sz]ation/i, 'company'],
  [/wallet|crypto|bitcoin|ethereum|blockchain address/i, 'crypto_address'],
  [/coordinates|location|address on a map|latitude/i, 'location'],
  [/licen[cs]e plate|\bvin\b|vehicle/i, 'vehicle'],
  [/aircraft|flight|tail number|icao/i, 'aircraft'],
  [/vessel|ship|\bimo\b|\bmmsi\b/i, 'vessel'],
  [/file hash|malware hash|\bmd5\b|\bsha-?\d/i, 'hash'],
  [/bssid|wi-?fi|ssid/i, 'wifi'],
];

export function inputsFromText(text) {
  if (!text) return [];
  const keys = new Set(inputWords.filter(([re]) => re.test(text)).map(([, key]) => key));
  // "Image URL" or "video link" means the input is the media itself, handed over by its address.
  if (keys.has('url') && (keys.has('image') || keys.has('video'))) keys.delete('url');
  return [...keys];
}

/**
 * Services that deal in leaked or breached personal data, and tools for covertly tracking a device or person.
 * Listed since the policy decision of 2026-09-30 with a hard responsible-use notice and the `leak-data`,
 * `covert-tracking` or `surveillance` tag, and reviewed one by one: the notice has to be on the page, and the
 * site still never queries them for the visitor.
 */
export const leakPattern = /breach|leak|stealer|combo ?list|credential|dump|dox|ip ?logger|ip ?grabber|last ?seen|stalker/i;

/**
 * People search and face recognition. Listed (since the policy decision of 2026-09-26) with a responsible-use
 * notice, but each one is reviewed individually so data brokers of leaked data still stay out.
 */
export const peoplePattern =
  /face (search|recognition)|facial|search (for )?people|people (search|finder|lookup)|by photo|reverse (phone|address)|phone ?book|background check|whitepages|owner of a phone|who (called|lives)/i;
