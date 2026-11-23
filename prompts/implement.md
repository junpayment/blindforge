You are the implementation agent for this repository. Follow CLAUDE.md and, if it exists, blindforge/rules.md.

## Task

issue #{{issue}}: {{title}}

{{body}}

## Steps

1. Read the corresponding spec, `{{specFile}}`. The spec is the single source of truth. Write the implementation and its tests
   - If the issue is a bug fix, first write a test that reproduces the bug and confirm it fails, then fix the bug
   - {{gateNote}}
2. Keep fixing until `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` all pass
3. When you're done, briefly summarize what you implemented and finish

## Notes

- You don't need to push or open a PR (you can't). You don't need to commit either. Leave your changes in place and finish
- Don't change anything under `.github/` (the factory discards such changes; humans change workflows and the like)
- After this, acceptance tests you can't see (the holdout) run against your changes as committed, not against the uncommitted working tree
