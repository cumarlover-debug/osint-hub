# Contributing to osint-hub

Thanks for helping. There are three ways to contribute.

## Suggest a tool (easiest)

Use the form at **https://osinthub.pages.dev/submit**. It opens a pre-filled GitHub issue. A bot checks the
submission within a minute and comments with anything to fix:

- the details are complete and use the allowed values
- it is not already listed, and was not reviewed and turned down before
- the link works (and does not redirect somewhere else)
- for open-source tools, the GitHub repo exists and is maintained
- the description is your own words, not copied from the tool's website

Edit the issue to fix anything marked ❌ and the check runs again. When it passes, a maintainer reviews it and adds the
`approved` label, which publishes the tool automatically.

## Report a problem

Every tool page has a **Report a problem** link for broken links, moved tools, wrong details or search links that
no longer work.

## Pull requests

Add or edit a file in `data/tools/` (one YAML file per tool; the format is in the README) or `data/playbooks/`, then
run:

```bash
npm install
npm run validate
npm run build
```

The `Validate` workflow runs the same checks on every pull request.

## What gets listed

Tools for research, journalism, security work and personal safety. People search and face search are listed with a
responsible-use notice. Not accepted: anything that sells or exposes leaked or breached personal data or credentials,
stalkerware, and doxxing services. See https://osinthub.pages.dev/about#responsible-use.
