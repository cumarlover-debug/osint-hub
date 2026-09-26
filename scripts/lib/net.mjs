// Network checks shared by the health check and the pipeline.

export const TIMEOUT_MS = 20_000;
export const UA = 'Mozilla/5.0 (compatible; osint-hub-healthcheck/1.0; +https://github.com/cumarlover-debug/osint-hub)';

/**
 * ok      the page answered (2xx/3xx, or 401 which still proves it exists)
 * fail    it is gone or broken (404/410, most 5xx, DNS failure, refused, timeout)
 * blocked we could not tell, usually bot protection (403/429, Cloudflare challenge)
 *
 * With { page: true } an "ok" result also carries the page <title> and meta description.
 */
export async function checkUrl(url, { page = false } = {}) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    const code = res.status;
    const finalHost = new URL(res.url).host.replace(/^www\./, '');
    const movedTo = finalHost !== new URL(url).host.replace(/^www\./, '') ? res.url : undefined;
    const challenged = res.headers.has('cf-mitigated') || /cloudflare|ddos-guard/i.test(res.headers.get('server') ?? '');

    if (code < 400 || code === 401) {
      const meta = page && code < 400 ? pageMeta(await res.text().catch(() => '')) : (res.body?.cancel().catch(() => {}), {});
      return { result: 'ok', code, movedTo, ...meta };
    }
    res.body?.cancel().catch(() => {});
    // Report a cross-domain redirect even when the final page is an error: "tool.io → vendor.com/transition-faq"
    // is often the only sign that a tool was shut down.
    if (code === 404 || code === 410) return { result: 'fail', code, movedTo, reason: `HTTP ${code}` };
    if (code >= 500 && !challenged) return { result: 'fail', code, movedTo, reason: `HTTP ${code}` };
    return { result: 'blocked', code, movedTo, reason: `HTTP ${code}${challenged ? ' (bot protection)' : ''}` };
  } catch (e) {
    const reason = e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code ?? e.message);
    return { result: 'fail', reason };
  }
}

function pageMeta(html) {
  const decode = (s) =>
    s
      ?.replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  const description =
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i)?.[1] ??
    html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1];
  return { title: decode(title)?.slice(0, 200), meta_description: decode(description)?.slice(0, 400) };
}

/** GitHub repo facts. { missing: true } on 404, { error } on rate limits and other failures. */
export async function checkRepo(repo) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': UA };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404) return { missing: true };
    if (!res.ok) return { error: `GitHub API HTTP ${res.status}` };
    const j = await res.json();
    return {
      stars: j.stargazers_count,
      archived: j.archived,
      pushed_at: j.pushed_at?.slice(0, 10),
      ...(j.full_name.toLowerCase() !== repo.toLowerCase() && { renamed_to: j.full_name }),
      // Extra facts the pipeline uses when drafting; the health check ignores them.
      description: j.description ?? undefined,
      language: j.language ?? undefined,
      license: j.license?.spdx_id && j.license.spdx_id !== 'NOASSERTION' ? j.license.spdx_id : undefined,
      homepage: j.homepage || undefined,
    };
  } catch (e) {
    return { error: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}

/** owner/repo for a github.com URL, otherwise undefined. */
export function githubRepo(url) {
  try {
    const u = new URL(url);
    if (u.hostname.replace(/^www\./, '') !== 'github.com') return undefined;
    const [owner, repo] = u.pathname.split('/').filter(Boolean);
    return owner && repo ? `${owner}/${repo.replace(/\.git$/, '')}` : undefined;
  } catch {
    return undefined;
  }
}

/** Runs fn over items with at most `size` in flight, keeping result order. */
export async function pool(items, size, fn) {
  const out = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}
