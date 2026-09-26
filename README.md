# osint-hub

A searchable directory of OSINT tools, organised by what you're investigating: start from a username, email,
domain, IP, image or other input and see every tool that takes it.

**Live site: https://osinthub.pages.dev** (Cloudflare Pages, redeploys on every push to `main`)

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

## Growing the list

A three-step pipeline finds new tools in public OSINT lists and turns them into drafts for review:

```bash
npm run pipeline:harvest                 # read the source lists into .cache/pipeline/candidates.json
npm run pipeline:draft -- --limit 50     # check links + GitHub, write the best 50 to data/drafts/
# review the drafts (see data/drafts/README.md), then:
npm run pipeline:promote                 # publish approved drafts, record rejected ones
```

- **harvest** maps each source section to a category and input types (`scripts/pipeline/mapping.mjs`) and
  skips tools that are already listed (by URL or name), rejected before, or marked dead by the source.
  Anything that may deal in leaked personal data gets a policy flag and is left out of drafts unless you pass `--flagged`.
- **draft** spreads each batch across categories, skips dead links and archived or abandoned repos
  (re-checked after 30 days), and pre-fills cost, type, passive and account fields from the source data.
- **promote** validates approved drafts, names the file after the tool, moves it to `data/tools/`, adds
  rejected URLs to `data/pipeline/rejected.txt`, and health-checks the new tools straight away.

Descriptions are always written fresh: the source lists' own wording stays in the drafts as notes and is never published.

### Sources

Candidate tools come from [awesome-osint](https://github.com/jivoi/awesome-osint) (CC BY-SA 4.0) and the
[OSINT Framework](https://github.com/lockfale/OSINT-Framework) (MIT, © Justin Nordine). Thanks to both
projects and their contributors. Only facts (names, URLs, categories, pricing and similar flags) are reused.

## What gets listed

Tools for research, journalism, security work and personal safety.

- **Listed with a responsible-use notice:** people-search engines, public and court records, and face-recognition
  search. Tool pages in the `people` category, or tagged `face-recognition`, show the notice automatically. Each one
  is reviewed individually (`npm run pipeline:draft -- --people`).
- **Not accepted:** stalkerware, doxxing services, and anything that sells leaked or breached personal data or
  credentials, including lookup bots built on leaked databases. The pipeline flags these as `policy-leak` and never
  drafts them unless asked to with `--leaked`.

## Privacy

The site is fully static. Filtering runs in the browser, "Search directly" boxes open the tool straight from the
visitor's browser, and pages send `no-referrer`.

## Roadmap

1. ~~MVP: schema, seed data, search by input, page per tool~~
2. ~~Weekly health check (GitHub Action): link status, GitHub stars / last commit / archived~~
3. Multi-tool query launcher, pivot chains, investigation playbooks
4. ~~Seed + enrich pipeline from awesome lists~~; community submissions
5. Favorites, CLI, browser extension
