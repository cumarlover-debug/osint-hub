# osint-hub

A searchable directory of OSINT tools, organised by what you're investigating: start from a username, email,
domain, IP, image or other input and see every tool that takes it.

**Live site: https://osinthub.pages.dev** (Cloudflare Pages, redeploys on every push to `main`)

## Run it

```bash
npm install
npm run dev        # http://localhost:4321, with hot reload
npm run check      # everything CI runs: the tests, then validate + build (~10s)
npm run preview    # serve dist/ at http://localhost:4321, as Cloudflare Pages serves it
npm test           # just the unit tests
npm run validate   # just the schema check on every tool file
npm run build      # just validate + build into dist/
```

`npm test` uses Node's built-in test runner (`tests/`), so it needs no extra dependency. It covers value
detection and command quoting in `shared/launcher.mjs`, the schema and URL/name normalisation in
`scripts/lib/data.mjs`, and whole-project invariants the validator does not check: a health entry for every
tool, no tool listed twice by URL or name, a taxonomy key nothing uses, a playbook that starts from an input
with no tools, and a listed tool that the pipeline still has on its rejected list. CI runs `npm test` and
`npm run build` on every push and pull request (`.github/workflows/validate.yml`) — the same two steps as
`npm run check`, so a green `check` means CI will pass.

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

## Workbench

`/case` is where an investigation lives. Add every identifier you have — a phone number, a username, an email, a
domain, an image — one per line; the workbench derives what follows from each one (an email gives its username and
domain, a URL gives its host, a phone number gives its digits-only form and, only if you ask for them, a name gives
candidate usernames marked as candidates) and then lists **every** tool that can take each value: passive or active,
free or paid, account or no account, with a direct search link, a command to run on your own machine, or a link to
the tool's own page. Tools carrying a responsible-use notice are badged.

- **Safe mode** leaves out everything that contacts the target and everything that needs an account.
- **Findings** — to do, ran, found something, dead end — are recorded per tool with a note.
- **The dossier** exports as Markdown: the identifiers, which tools were capable, what you recorded and your notes.
  It never claims a tool was queried for you.
- Cases are kept only in this browser, like the toolkit, and back up to JSON that can be restored.

The workbench plans; it does not query. No value is sent anywhere, no tool is run on your behalf, and nothing is
fetched from the target. The logic lives in `shared/case.mjs` with the page as a thin layer, so it is covered by
`npm test` like the launcher is, and a test fails the suite if either shared module ever gains `fetch` or
`child_process`. When you want the command-line tools in a plan to actually run, export the case and use
`osint-hub case run` — that executes them on your machine, and the output comes back as an annex
(see [Command-line tool](#command-line-tool)).

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
  Anything that may deal in leaked data, or in covertly tracking a device or person, gets a `policy-leak` flag and is
  drafted only when you ask for it with `--leaked`, with the responsible-use notice on the page.
- **draft** spreads each batch across categories, skips dead links and archived or abandoned repos
  (re-checked after 30 days), and pre-fills cost, type, passive and account fields from the source data.
- **promote** validates approved drafts, names the file after the tool, moves it to `data/tools/`, adds
  rejected URLs to `data/pipeline/rejected.txt`, and health-checks the new tools straight away.

Descriptions are always written fresh: the source lists' own wording stays in the drafts as notes and is never published.

### Search templates

The launcher, the extension and `osint-hub commands` can only offer a tool directly if it has a
`query_template`, so tools without one are a standing gap. This finds them:

```bash
node scripts/query-templates.mjs                    # the highest-value candidates
node scripts/query-templates.mjs --offset 300       # carry on where the last run stopped
node scripts/query-templates.mjs --write --only a,b # write the verified ones into data/tools/
```

It reads the search form on the tool's own page (a GET form, so the value can go in the URL), builds the
template, and then fetches it with two different values. A candidate counts as **verified** only if the page came
back with both, with the search box itself stripped first — a value echoed into the box it came from proves only
that the page has a form. It changes nothing until `--write`, and it reverts a file that would not validate.
A report always lands in `.cache/query-templates/`.

Verified does not mean the right search box: a form on a vendor's marketing site is not the tool's own search.
Those are dropped by hand before writing, which is why the run above is a report to read, not an import. A tool
whose box could serve several of its inputs is reported as ambiguous and left alone unless `--mappings map.json`
says which inputs that one URL belongs to.

### Sources

Candidate tools come from [awesome-osint](https://github.com/jivoi/awesome-osint) (CC BY-SA 4.0) and the
[OSINT Framework](https://github.com/lockfale/OSINT-Framework) (MIT, © Justin Nordine). Thanks to both
projects and their contributors. Only facts (names, URLs, categories, pricing and similar flags) are reused.

## What gets listed

Tools for research, journalism, security work and personal safety.

- **Listed with a responsible-use notice:** people-search engines, public and court records, face-recognition search,
  and — since the policy decision of 30 September 2026 — breach and leaked-data lookup services, tools that index
  exposed files, open directories and pastes, IP-logging links, unsecured-camera feeds and last-seen trackers. A tool
  page shows the notice when it is in the `people` category or carries `face-recognition` or `personal-data`; the
  harder groups (`leak-data`, `covert-tracking`, `surveillance`) get a second paragraph saying plainly that handling
  breached records, other people's devices or a target's location is unlawful in most countries and that the data is
  often false or planted.
- **Reviewed one by one:** these are only drafted when asked for (`npm run pipeline:draft -- --people --leaked`), so
  each is a deliberate decision rather than a batch import. The tag list lives in `shared/case.mjs`, so the tool page
  and the workbench cannot disagree about what counts as sensitive.
- **Still not accepted:** stalkerware, doxxing-for-hire services, and tools whose only purpose is to track a named
  person without their knowledge.
- **Never automated:** listing a tool never means querying it. osint-hub holds no breach-database keys, makes no
  request on your behalf, and the workbench plans a run rather than performing one (`shared/case.mjs` has no network
  code, and `npm test` would fail the build if the notice wiring broke).

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
`shared/launcher.mjs`, the same code the website uses; `--data <tools.json>` reads a local copy instead of downloading.

### Running a case locally

The workbench plans; the CLI executes. Export a case from `/case` (Back up (JSON)) and:

```bash
osint-hub case plan ./my-case.json              # what would run, per identifier, with install hints
osint-hub case run  ./my-case.json              # ask before each command, capture what it prints
osint-hub case run  ./my-case.json --safe       # nothing that contacts the target, nothing needing an account
osint-hub case run  ./my-case.json --yes --only holehe,dnstwist --timeout 120
```

There is a harmless sample case in `examples/case.json` (example.com is reserved for documentation), so you can try
it before exporting anything: `npm run cli -- case plan examples/case.json --data dist/api/tools.json`.

- Commands come from each tool's `command_template`, with the value quoted by `quoteArg`, and a value that cannot
  be quoted safely never becomes a command.
- The plan marks each command **installed**, **needs its own files** (it runs an interpreter over the tool's own
  script, so Python being present proves nothing) or **not installed** with the install line. `run` refuses to start
  when nothing is installed unless you pass `--force`, instead of failing the same way N times.
- `run` prompts per command (yes / no / all / quit); `--yes` runs unattended, `--dry-run` only prints the plan.
- Each command runs in your shell — PowerShell is invoked directly when that is the chosen shell — with **no stdin**,
  so a tool that asks a question fails instead of hanging the run, and a `--timeout` (default 300s) kills it.
- Output lands in `osint-hub-<case>/runs/NN-<tool>.txt`, with `manifest.json` and an `annex.md` written to paste into
  the dossier. `--write-back` also saves a case file marking what ran cleanly, ready to restore into `/case`.
- Your keys, your VPN and your Tor are yours: osint-hub holds no credentials and makes no request on your behalf.

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
