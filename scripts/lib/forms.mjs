// Deciding whether a page has a search box, and whether it is safe to use.
//
// This is the rule that turns an unreachable directory entry into one the agent can attempt, so it has to be right in
// both directions. Marking a newsletter or a signup form as a search box would have the browser driver type a
// target's address into a live registration for someone who never asked; missing a real search box leaves a tool
// unreachable. Both failures are tested.

/** Field names a search box tends to use. Deliberately generous: a site-wide search box is still a box. */
export const SEARCHY = /(^|[-_ ])(q|query|s|search|searchterm|search_term|keyword|keywords|username|user|email|address|domain|ip|phone|name|url|target|handle|term|text)($|[-_ ])/i;
/** Anything that says "this is not the box you are looking for". */
export const NOT_SEARCH = /newsletter|subscribe|mailing|login|log ?in|password|signin|sign-in|coupon|promo|search-icon|toggle/i;
/** Bot walls and dead pages: nothing to learn from them, and marking one would be wrong. */
export const WALL = /just a moment|checking your browser|attention required|automated traffic is not allowed|access blocked|unusual traffic|404 not found|domain (is )?for sale|hugedomains|parked/i;

/** A form that wants an account rather than an answer. */
const AUTH_ACTION = /(sign[-_]?up|register|log[-_]?in|sign[-_]?in|subscribe|newsletter|checkout|cart)/i;
const AUTH_TEXT = /sign ?up|get started|create (an )?account|log ?in|sign ?in|subscribe|newsletter|try (it )?free|start (your )?free/i;

const INPUT_TYPES_SKIPPED = ['password', 'hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset'];

const metaOf = (tag) =>
  [
    tag.match(/name=["']([^"']*)/i)?.[1],
    tag.match(/id=["']([^"']*)/i)?.[1],
    tag.match(/placeholder=["']([^"']*)/i)?.[1],
    tag.match(/aria-label=["']([^"']*)/i)?.[1],
    tag.match(/class=["']([^"']*)/i)?.[1],
  ]
    .filter(Boolean)
    .join(' ');

/**
 * Does this page have a search box?
 *
 * @param {string} html
 * @returns {{reason: string} | {wall: true} | null} the reason it counts, or null when there is nothing to fill in.
 */
export function searchFormIn(html) {
  const text = String(html ?? '');
  if (WALL.test(text.slice(0, 3000))) return { wall: true };
  if (/<form[^>]+role=["']?search/i.test(text)) return { reason: 'a form with role=search' };

  // Forms are read one at a time, because a signup box and a search box look identical as markup: both are an
  // <input name="email">. A block that asks for a password, or offers to sign up, log in, register or subscribe, is
  // skipped whatever its inputs are called.
  const blocks = [];
  const withoutForms = text.replace(/<form\b[\s\S]{0,6000}?<\/form>/gi, (m) => {
    blocks.push(m);
    return ' ';
  });

  const searchyIn = (block, strict) => {
    for (const m of block.matchAll(/<input\b[^>]*>/gi)) {
      const tag = m[0];
      const type = (tag.match(/type=["']?([a-z]+)/i)?.[1] ?? 'text').toLowerCase();
      if (INPUT_TYPES_SKIPPED.includes(type)) continue;
      // Outside a form element the page is the context, so the check is the text around this input rather than the
      // whole document: otherwise any page carrying a "Log in" link in its header reads as an auth form.
      if (!strict && m.index != null) {
        const around = block.slice(Math.max(0, m.index - 300), m.index + 300);
        if (AUTH_ACTION.test(around) || AUTH_TEXT.test(around.replace(/<[^>]*>/g, ' ')) || /type=["']password/i.test(around)) continue;
      }
      const meta = metaOf(tag);
      if (NOT_SEARCH.test(meta)) continue;
      if (type === 'search') return `an input of type search (${meta.slice(0, 40) || 'unlabelled'})`;
      const hit = meta.match(SEARCHY);
      if (hit) return `an input named "${hit[0].trim()}"`;
    }
    return null;
  };

  for (const block of blocks) {
    const action = block.match(/<form[^>]*action=["']([^"']*)/i)?.[1] ?? '';
    const looksAuth = /\btype=["']password/i.test(block) || AUTH_ACTION.test(action) || AUTH_TEXT.test(block.replace(/<[^>]*>/g, ' '));
    if (looksAuth) continue;
    const reason = searchyIn(block, true);
    if (reason) return { reason };
  }
  const loose = searchyIn(withoutForms, false);
  return loose ? { reason: loose } : null;
}
