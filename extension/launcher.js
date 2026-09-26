// The extension's launcher: same logic as https://osinthub.pages.dev/launch, but it opens tabs through the
// extension API, so opening many at once is not limited by pop-up blocking.
import { detect, launchable, MATCH_LABELS } from './lib/launcher.mjs';

const API = 'https://osinthub.pages.dev/api/tools.json';
const DAY = 86_400_000;
const $ = (id) => document.getElementById(id);
if (location.search.includes('popup')) document.body.classList.add('popup');

let data = null;
let type = '';
let chosenByHand = false;

/** Tool data: cached in extension storage for a day; the stale copy is used if the site is unreachable. */
async function loadData() {
  const { cache } = await chrome.storage.local.get('cache');
  if (cache && Date.now() - cache.fetchedAt < DAY) return cache.data;
  try {
    const res = await fetch(API);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fresh = await res.json();
    await chrome.storage.local.set({ cache: { data: fresh, fetchedAt: Date.now() } });
    return fresh;
  } catch (e) {
    if (cache) return cache.data;
    throw e;
  }
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function render() {
  const value = $('value').value.trim();
  const types = Object.keys(data.taxonomy.inputs).filter((t) => data.tools.some((tool) => launchable([tool], t, 'x', { includeActive: true }).length));
  if (!chosenByHand) type = detect(value).find((t) => types.includes(t)) ?? '';

  $('types').replaceChildren(
    ...types.map((t) => {
      const b = el('button', { type: 'button', className: 'chip', textContent: data.taxonomy.inputs[t] });
      b.setAttribute('aria-pressed', String(t === type));
      b.addEventListener('click', () => {
        type = t;
        chosenByHand = true;
        render();
      });
      return b;
    }),
  );
  $('detected').replaceChildren('Detected type: ', el('strong', { textContent: value ? (type ? data.taxonomy.inputs[type] : 'not recognised, pick one') : 'none yet' }));

  const rows = value && type ? launchable(data.tools, type, value, { includeActive: $('include-active').checked }) : [];
  $('results').replaceChildren(
    ...rows.map((r) => {
      const box = el('input', { type: 'checkbox', checked: r.usable && r.tool.passive, disabled: !r.usable });
      box.dataset.link = r.link ?? '';
      const name = el('a', { href: `${data.site}/tools/${r.tool.slug}`, target: '_blank', rel: 'noopener noreferrer', textContent: r.tool.name, className: 'name' });
      const tags = el('span', { className: 'tags' });
      if (!r.tool.passive) tags.append(el('span', { className: 'badge warn', textContent: 'Active' }));
      if (r.tool.account_required) tags.append(el('span', { className: 'badge', textContent: 'Account' }));
      const end = r.usable
        ? el('a', { href: r.link, target: '_blank', rel: 'noopener noreferrer', textContent: 'Open ↗', className: 'open' })
        : el('span', { className: 'hint', textContent: `only ${MATCH_LABELS[r.template.match]}` });
      return el('li', { className: r.usable ? '' : 'muted' }, el('label', {}, box, name), tags, end);
    }),
  );
  $('bar').hidden = rows.length === 0;
  $('message').textContent = !value ? '' : rows.length ? '' : 'No tool can search this type directly. Pick another type above.';
  updateCount();
}

function updateCount() {
  const n = $('results').querySelectorAll('input:checked').length;
  $('open-selected').textContent = `Open selected (${n})`;
  $('open-selected').disabled = n === 0;
}

$('value').addEventListener('input', () => {
  if (!$('value').value.trim()) chosenByHand = false;
  render();
});
$('include-active').addEventListener('change', render);
$('results').addEventListener('change', updateCount);
$('select-all').addEventListener('click', () => {
  for (const b of $('results').querySelectorAll('input:not(:disabled)')) b.checked = true;
  updateCount();
});
$('select-none').addEventListener('click', () => {
  for (const b of $('results').querySelectorAll('input')) b.checked = false;
  updateCount();
});
$('open-selected').addEventListener('click', async () => {
  const links = [...$('results').querySelectorAll('input:checked')].map((b) => b.dataset.link).filter(Boolean);
  // Open in the background, in order, so the launcher stays in front.
  for (const url of links) await chrome.tabs.create({ url, active: false });
  $('message').textContent = `Opened ${links.length} tabs.`;
});

try {
  data = await loadData();
  const { pending } = await chrome.storage.session.get('pending');
  if (pending) {
    await chrome.storage.session.remove('pending');
    $('value').value = pending.value;
    if (pending.type) {
      type = pending.type;
      chosenByHand = true;
    }
  }
  render();
  $('value').focus();
} catch (e) {
  $('message').textContent = `Could not load the tool list (${e.message}). Check your connection and try again.`;
}
