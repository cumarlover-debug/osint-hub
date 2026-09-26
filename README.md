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
query_template: https://example.com/search?q={query}   # optional: powers "Search directly" and the launcher
# or one URL per input type, optionally limited to a value format (eth, btc, ipv4, vin):
# query_template: {ip: https://…/host/{query}, crypto_address: {url: https://…/address/{query}, match: eth}}
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

## Launcher

`/launch` takes one value (email, domain, IP, hash, wallet, username…), detects its type, and lists every tool with a
`query_template` for that type. Passive tools are ticked by default, active ones are hidden unless asked for, and
"Open selected" opens them all in new tabs. Everything runs in the browser: the value is never sent to the site or put
in its URL. Only add a template after checking it with a real value: a template that 404s is worse than none.

## Playbooks and pivots

`data/playbooks/*.yaml` are step-by-step guides (suspicious domain, email, username, IP, photo, video, crypto payment,
company). Each step has `why`, `do`, `look_for`, optional `opsec`, an `input` type and the `tools` to use (by slug).
On the page, a value typed into one step fills every step of the same type and turns on direct search links. Only
which steps are ticked is saved (in the browser); the values never are. `npm run validate` fails if a playbook refers
to a tool that does not exist, so removing or renaming a tool cannot silently break a guide.

Each input page (`/inputs/domain` and so on) also shows a pivot map: what the tools for that input can turn up, as
other input types, and which tools lead there. It is built from each tool's `outputs`.

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
  search. Tool pages in the `people` category, or tagged `face-recognition` or `personal-data`, show the notice automatically. Each one
  is reviewed individually (`npm run pipeline:draft -- --people`).
- **Not accepted:** stalkerware, doxxing services, and anything that sells leaked or breached personal data or
  credentials, including lookup bots built on leaked databases; also search engines for exposed files, open
  directories and pastes, since much of what they surface is leaked personal data. The pipeline flags these as `policy-leak` and never
  drafts them unless asked to with `--leaked`.

## Privacy

The site is fully static. Filtering runs in the browser, "Search directly" boxes open the tool straight from the
visitor's browser, and pages send `no-referrer`.

## Community submissions

`/submit` builds a pre-filled "Suggest a tool" issue (`.github/ISSUE_TEMPLATE/submit-tool.yml`). The `Tool submissions`
workflow then runs `scripts/submissions/check.mjs` on every opened or edited submission: schema, duplicates (listed,
rejected, aliases), a link check that refuses private and internal addresses, GitHub repo status, copied descriptions
and the listing policy. It keeps one results comment up to date and labels the issue `ready-for-review` or
`needs-changes`. A maintainer adding the `approved` label runs `scripts/submissions/approve.mjs`, which re-checks,
confirms the labeller has write access, writes and health-checks the tool, and commits it (closing the issue).
Issue text is untrusted: it is only parsed by the scripts, never put into a shell command. See CONTRIBUTING.md.

## Command-line tool

```bash
npm install -g github:cumarlover-debug/osint-hub
osint-hub launch example.com          # search links for every tool that can take it
osint-hub launch 8.8.8.8 --open       # ...and open them in your browser
osint-hub tools --input email --passive
osint-hub playbook suspicious-domain --value example.com
```

No dependencies; it reads `https://osinthub.pages.dev/api/tools.json` and `playbooks.json`, caches them for a day, and
falls back to the cache when offline. Run `osint-hub --help` for everything. Detection and links come from
`shared/launcher.mjs`, the same code the website uses.

## Browser extension

`extension/` is a Manifest V3 extension for Chrome and Firefox: right-click selected text, a link, an image or the
page to search it with the tools that can take it, then open them all in background tabs. Install and privacy
details are in `extension/README.md`.

## Favourites

Star tools with ★ to build **My toolkit** (`/toolkit`): filter the home page by it, export it as a browser
bookmarks file, or back it up as JSON. It is stored only in the browser.

## Run on your machine

Command-line tools have no web page to search, so the launcher, the extension and `osint-hub commands <value>` build
ready-to-run commands instead, from each tool's `command_template` (and `docker_template`). The value is quoted by
`quoteArg` in `shared/launcher.mjs` for bash/zsh or PowerShell, and refused if it contains control characters or starts
with `-`, so a pasted value can never become a second command or an option. The schema also rejects templates with
quotes or shell operators. Every template was taken from the tool's own README.

## Roadmap

1. ~~MVP: schema, seed data, search by input, page per tool~~
2. ~~Weekly health check (GitHub Action): link status, GitHub stars / last commit / archived~~
3. ~~Multi-tool query launcher, pivot chains, investigation playbooks~~
4. ~~Seed + enrich pipeline from awesome lists; community submissions~~
5. ~~Favourites, CLI, browser extension~~
