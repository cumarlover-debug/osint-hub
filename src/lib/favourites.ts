// "My toolkit": favourite tool slugs, kept only in this browser. Storage can be unavailable (private mode,
// blocked site data), so every access is guarded and the site works without it.
const KEY = 'osint-hub:favourites';
export const CHANGED = 'osint-hub:favourites-changed';

export function getFavourites(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function setFavourites(slugs: string[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify([...new Set(slugs)]));
    window.dispatchEvent(new CustomEvent(CHANGED));
    return true;
  } catch {
    return false;
  }
}

export function toggleFavourite(slug: string): boolean {
  const list = getFavourites();
  const on = !list.includes(slug);
  setFavourites(on ? [...list, slug] : list.filter((s) => s !== slug));
  return on;
}

/** Wires every star button on the page and keeps them in sync with each other and with other tabs. */
export function wireStars() {
  const render = () => {
    const favs = new Set(getFavourites());
    for (const b of document.querySelectorAll<HTMLButtonElement>('.fav[data-slug]')) {
      const on = favs.has(b.dataset.slug!);
      b.setAttribute('aria-pressed', String(on));
      b.title = on ? 'Remove from my toolkit' : 'Add to my toolkit';
      const label = b.querySelector('.fav-label');
      if (label) label.textContent = on ? 'In my toolkit' : 'Add to my toolkit';
    }
  };
  document.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.fav[data-slug]');
    if (!b) return;
    e.preventDefault();
    toggleFavourite(b.dataset.slug!);
  });
  window.addEventListener(CHANGED, render);
  window.addEventListener('storage', (e) => e.key === KEY && render());
  render();
}
