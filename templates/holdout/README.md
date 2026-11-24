# Hidden acceptance tests

The acceptance tests ("holdout") for the app built by [blindforge](https://github.com/junpayment/blindforge). **Keep this repository away from the implementing AI.**

- `tests/`: Playwright tests. Each title starts with an acceptance-criteria ID from the app's specs (`"A4 a wrong code shows an error"`).
- `scenarios/`: what each ID checks, in plain words.
- `scripts/summarize.mjs`: reduces a Playwright report to IDs and pass/fail. blindforge calls it, and that output is all the implementing AI ever sees. Don't change its output.
- Tests tagged `@prod` are skipped by blindforge. Tests tagged `@golden` (the core journeys, chosen by a human) run in every build, next to the current spec's tests.
- `npm run lint` runs ESLint rules against flaky patterns and `tsc --noEmit`. blindforge requires it to pass after the holdout agent writes tests.
- `@playwright/test` is pinned to the Playwright version of blindforge's container image (`agent.Dockerfile`). Upgrade both together.

blindforge's holdout agent writes `tests/` and `scenarios/` from the app's specs. It can't change anything else here.
