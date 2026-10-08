# dsh-osint-hub

The osint-hub agent as a **DeepSeek Harness tool**: `osint_agent`. A session can open a case, assign the work in the
user's own words, see what is possible, run the unattended tools, drive the form-only services in a browser, and read
the accumulating profile — without anyone typing CLI commands.

## Install

```
dsh plugin --profile web add "link:<abs path to this directory>"
```

That links the plugin into the profile and adds `dsh-osint-hub` to `dsh.profile.bundles`. Confirm the composition
without booting anything:

```
dsh --profile web --dump-config | findstr osint
```

The tool appears after the profile restarts — a running harness loads plugins at boot.

## Where the checkout is

The tool runs `cli/osint-hub.mjs` from the osint-hub checkout. It looks, in order, at `OSINT_HUB`, `OSINT_HUB_ROOT`,
then the path this was developed on. If none holds the CLI it returns a message naming the variable to set, rather
than an error the model could mistake for "no results".

## Actions

| Action | What it runs | Reaches the network |
|---|---|---|
| `case_new` | Opens a case from the identifiers the user holds. Needs `values` and `title`; `basis` is recorded when given. | no |
| `task_add` | Turns the user's words into a family of tools and reports how it read them. | no |
| `task_list` | The assigned tasks and how much of each has been tried. | no |
| `plan` | What is possible before anything runs: runnable, fetchable, form-only, not installed, pivots. | no |
| `profile` | Reads every result into a target profile with provenance, and writes the dossier. | no |
| `run` | Executes the unattended tools and fetches search links. **Needs `confirm: true`.** | **yes** |
| `hands` | Opens a browser, fills and submits the services that answer only a form. **Needs `confirm: true`.** | **yes** |

`--task <id>` narrows `plan`, `run` and `hands` to one assigned piece of work. Budgets default small (8 tools /
240 seconds to run, 4 to drive forms) and can be set with `max` and `seconds`.

## Rules the tool enforces, not the model

- **The basis is recorded, not demanded.** `case_new` takes `basis` when the user states who asked and on what
  authority, and `OSINT_BASIS` records it once for someone who is always the requester. Without one the case still
  opens and the report prints "not stated" — a gate that refuses to work invites an invented authority, and a fabricated
  basis in the record is worse than an absent one.
- **No unattended requests without confirmation.** `run` and `hands` refuse unless `confirm: true` is passed, because
  they spend the user's connection and their time.
- **A refused call is a result.** Rule violations come back as `ok: false` with the reason, so the model can tell the
  user what it needs rather than silently doing nothing.
- **Nothing is spawned through a shell.** Arguments are passed as data to `execFile`, so a value containing shell
  syntax is a value, not something to interpret.

## Layout

- `lib/plan.js` — the mapping from a call to a command, plus the confirmation and basis rules. No harness imports, so
  `tests/dsh-plugin.test.mjs` covers it wherever the project runs.
- `lib/index.js` — registers the tool with `defineTool` and spawns the CLI.
- `selftest.mjs` — registers the tool through the harness's own `defineTool` and calls it. It borrows the installed
  harness's module, so it proves the real schema conversion and argument validation, not a stub.

```
node dsh-plugin/selftest.mjs
```
