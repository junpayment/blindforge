Your previous implementation failed the factory's checks.

{{failures}}

You cannot see the holdout scenarios. Infer the cause from the scenario IDs' leading letters (they name the feature area, as defined in the spec's acceptance criteria) and from the spec, then fix it.
After fixing, make `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` pass before you finish.
