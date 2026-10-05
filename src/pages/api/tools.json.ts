// Public, static JSON of the whole directory, used by the CLI and the browser extension.
import { tools, taxonomy } from '../../lib/tools';

export function GET() {
  const body = {
    version: 1,
    generated: new Date().toISOString(),
    site: 'https://osinthub.pages.dev',
    taxonomy,
    tools: tools.map((t) => ({
      slug: t.slug,
      name: t.name,
      url: t.url,
      description: t.description,
      category: t.category,
      inputs: t.inputs,
      outputs: t.outputs ?? [],
      type: t.type,
      cost: t.cost,
      passive: t.passive,
      account_required: t.account_required,
      ...(t.manual && { manual: t.manual }),
      ...(t.query_template && { query_template: t.query_template }),
      ...(t.command_template && { command_template: t.command_template }),
      ...(t.docker_template && { docker_template: t.docker_template }),
      ...(t.repo && { repo: t.repo }),
      ...(t.install && { install: t.install }),
      ...(t.notes && { notes: t.notes }),
      // Facets, derived the same way the site derives them, so filtering here matches filtering there. A tool is
      // open source when it names both a repository and a licence, and its platforms are only ever what the entry
      // states rather than what the language implies.
      open_source: Boolean(t.repo && t.license),
      ...(t.platforms && { platforms: t.platforms }),
      ...(t.language && { language: t.language }),
      ...(t.license && { license: t.license }),
      // From the weekly health check rather than the entry, so absent for a tool with no repository to read.
      ...(t.health?.repo?.stars != null && { stars: t.health.repo.stars }),
      ...(t.health?.repo?.archived && { archived: true }),
      status: t.health?.status ?? 'unverified',
    })),
  };
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8' } });
}
