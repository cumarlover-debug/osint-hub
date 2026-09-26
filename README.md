# osint-hub

A searchable directory of OSINT tools, organised by what you're investigating: start from a username, email,
domain, IP, image or other input and see every tool that takes it.

## Run it

```bash
npm install
npm run dev        # http://localhost:4321
npm run validate   # check every tool file against the schema
npm run build      # validate + build the static site into dist/
```

## Adding a tool

Add one file per tool in `data/tools/`. The filename is the URL slug (`data/tools/sherlock.yaml` → `/tools/sherlock`).

```yaml
name: Sherlock
url: https://github.com/sherlock-project/sherlock
description: Checks whether a username exists on 400+ social networks and websites.   # 20–240 chars
category: social-media            # see data/taxonomy.json
inputs: [username]                # what the tool takes (taxonomy "inputs")
outputs: [social_profile, url]    # outputs matching an input key become "Where to go next" links
type: cli                         # web | cli | desktop | extension | api
cost: free                        # free | freemium | paid
passive: true                     # false if it can scan, crawl or visit the target
account_required: false
query_template: https://example.com/search?q={query}   # optional, powers "Search directly"
repo: owner/name                  # CLI tools: repo and/or install
install: pipx install sherlock-project
notes: Anything a user should know before using it (OPSEC, limits).
```

`npm run validate` rejects unknown fields and categories, missing required fields and duplicate URLs.
Input types, categories, types and costs all live in `data/taxonomy.json`, which both the site and the validator read.

## Health check

`npm run healthcheck` (or `node scripts/healthcheck.mjs <slug> ...` for specific tools) checks every tool and
writes the results to `data/health.json`. Never edit that file by hand. It runs every Monday in GitHub Actions
(`.github/workflows/healthcheck.yml`), commits any changes, and posts a report to the job summary.

- **Link:** a tool is marked *down* only after **two failed checks in a row** (404/410, 5xx, DNS failure,
  timeout). 403/429 and Cloudflare challenges count as *could not verify*: they neither add a failure nor reset
  the streak.
- **GitHub repo:** stars, last push, archived, renamed or deleted. No push in 2+ years shows as *stale*.
- **Redirects** to another domain are listed in the report so the `url` can be updated.

On the site, down, archived and missing tools are badged, sorted last, and hidden by *Working tools only*.

## What gets listed

Tools for research, journalism, security work and personal safety. Stalkerware, doxxing services and sites that sell
leaked personal data or credentials are not accepted.

## Privacy

The site is fully static. Filtering runs in the browser, "Search directly" boxes open the tool straight from the
visitor's browser, and pages send `no-referrer`.

## Roadmap

1. ~~MVP: schema, seed data, search by input, page per tool~~
2. ~~Weekly health check (GitHub Action): link status, GitHub stars / last commit / archived~~
3. Multi-tool query launcher, pivot chains, investigation playbooks
4. Seed + enrich pipeline from awesome lists; community submissions
5. Favorites, CLI, browser extension
