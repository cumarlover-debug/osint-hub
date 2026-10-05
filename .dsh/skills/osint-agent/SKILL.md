---
name: osint-agent
description: 'Run an OSINT investigation against identifiers the user holds — email, username, domain, phone, name, image, crypto address, vehicle. Use when the user asks to investigate, look into, map, verify or enumerate something, or names a target and asks what can be found. Drives the osint-hub agent: case, assigned task, unattended runs, browser-driven forms, target profile and dossier.'
---

# The OSINT agent

`osint-hub` is a local, dependency-free CLI that turns a target's identifiers into investigations: it decides from a
directory of 1,050 tools and 22 playbooks what is worth running, runs the unattended tools, drives the form-only ones
in a real browser, reads every result into a target profile with provenance, and keeps a dossier up to date. It is the
executor; you are the investigator in the loop.

**Locate the checkout first.** The CLI is `cli/osint-hub.mjs` inside the osint-hub repo. Resolve it as:
`$env:OSINT_HUB` if set, else `C:\Users\User\OneDrive\Documents\M-in-CYS\Side_projects\osint-hub`, else ask the user.
Call it as `node <repo>/cli/osint-hub.mjs …` from anywhere. If the working directory is already the repo, plain
`node cli/osint-hub.mjs …` works. Add `--data <repo>/dist/api/tools.json` to work from the local copy instead of
re-downloading the tool data (faster, and correct offline).

## What to do, in order

1. **Ask for the basis before anything else.** One line: who asked, and what authority or consent they have. This is
   recorded in the case and printed in every report. If the user cannot give one, say so plainly and stop — an
   investigation of a private individual without a stated basis is the one thing this skill will not do for you. Then
   create the case:

   ```
   node cli/osint-hub.mjs case new "<short title>" --value "<identifier>[,<identifier>...]" --basis "<authority>" --out <repo>/osint-hub-<slug>.json
   ```

   Types are detected automatically; override with `--type email|username|domain|phone|name|...` if it guesses wrong.

2. **Assign the work in the user's own words** — this is how their intent becomes a family of tools, and it is worth
   running even when you think you know what they want, because it prints how it read the sentence:

   ```
   node cli/osint-hub.mjs agent task add "find every account this username has" <case.json>
   node cli/osint-hub.mjs agent task list <case.json>
   ```

   If it answers *nothing in that sentence maps to a family of work*, the sentence had no intent word: rewrite it
   ("check the email for breaches", "map the domain infrastructure", "who is this person", "everything on the
   username") rather than forcing it.

3. **See what is possible before running anything** — cheap, no requests, and it tells the user what the plan is:

   ```
   node cli/osint-hub.mjs agent next <case.json> --task <id>
   ```

   It reports per identifier: how many tools are runnable here, how many are search links the agent can fetch, how
   many need a form filled in by a browser, what is not installed, and which findings are worth pivoting on.

4. **Do the unattended work.** Real requests go out from the user's connection, so say so, keep the budget small, and
   prefer `--task` over "everything":

   ```
   node cli/osint-hub.mjs agent run <case.json> --task <id> --yes --max 8 --seconds 300          # commands + fetches
   node cli/osint-hub.mjs agent hands <case.json> --task <id> --yes --max 4 --seconds 300        # form-driven services
   ```

   Omit `--yes` and it asks before each job. `run` executes installed CLI tools and fetches search links; `hands`
   opens a browser, fills the box, submits and reads the answer. Both fold everything into the profile as they go and
   are resumable — a second run skips what the first already tried, so re-running is always safe and never wasted.

5. **Report the evidence.** `agent run`/`hands` rebuild the artefacts at the end; `agent profile` rebuilds them on
   demand:

   ```
   node cli/osint-hub.mjs agent profile <case.json>
   ```

   Writes `<out>/profile.json` (entities with sources), `<out>/dossier.md` (the readable account),
   `<out>/report.html` (the single-file evidence bundle, with search links and by-hand lists). Give the user the paths.

## Rules that are not negotiable

- **Everything is a candidate.** The agent records what a tool returned and the line it came from. Never upgrade a
  finding to a fact in your summary: say which tool, how many sources, and what a second independent source would be.
  Names repeat and aggregators merge people.
- **A non-result is a result.** The profile records every tool tried, including the ones that found nothing. Say when
  a check came back empty; do not silently drop it, and do not re-run what has already been tried.
- **Never handle credentials.** The tooling redacts passwords, combolist lines and hashes on the way in, and again
  when writing — do not paste a credential into a command line to "check" it, and do not ask the user for one.
- **Do not claim a wall was a check.** A captcha, a login or a bot block means the service was *not* read. Those are
  recorded as blocked and belong in your summary as still needing a person, never as "no results".
- **Safe mode stays on unless the user asks otherwise.** It excludes tools that touch the target's own infrastructure
  and tools needing an account. `--no-safe` and `--include-manual` exist; reach for them only on a clear request.
- **People are not "targets" to be enumerated on request alone.** Refuse dating-profile, intimate-image and
  credential-dump enumeration, and say why rather than just declining.

## Answering in the chat

Keep it short and evidence-shaped:

1. **What was run** — tools and identifiers, with the budget and whether anything was blocked.
2. **What was found** — grouped by kind (accounts, addresses, hosts, breach indications, documents), each line
   naming the tool that produced it. Link to a URL only when the finding *is* a URL.
3. **What is unverified** — one source, one tool, or an aggregator's guess.
4. **What needs a person** — the by-hand list, with its reasons (captcha, login, API key).
5. **Files** — `dossier.md` for reading, `report.html` for the evidence, `profile.json` for the raw entities.

Then offer the next step, not a wall of output: another task, a pivot on a finding, or the workbench at
`https://osinthub.pages.dev` for browsing the directory.
