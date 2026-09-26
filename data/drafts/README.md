# Drafts

Tool drafts from `npm run pipeline:draft`, waiting for review. Nothing here is published.

For each `.yaml` file:

1. Write a `description`: one or two plain sentences, at most 240 characters, in your own words.
   `review.notes` shows what the source lists and the tool's own site say, **for reference only**: the
   source descriptions are licensed (awesome-osint is CC BY-SA) and must not be copied.
2. Work through `review.flags`, for example checking the cost, the type, or a redirecting URL.
3. Check `inputs`, `category` and `passive` against what the tool actually does.
   *Passive* means it never touches the target's own infrastructure.
4. Set `review.approve: true`, or `review.reject: true` with a short `reject_reason`.
   Rejected URLs go to `data/pipeline/rejected.txt` and are never suggested again.
5. Run `npm run pipeline:promote`. Approved drafts are validated, moved to `data/tools/` and health-checked.

Leave a draft untouched to decide later.

To park a draft until a decision is made (for example a policy question), set `review.hold: true` and
`review.hold_reason`. Promote leaves held drafts alone.
