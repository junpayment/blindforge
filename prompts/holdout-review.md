blindforge ran your tests against the app as it is on `main`, **before this spec is implemented** (no retries, 10-second timeout). Below are the results for this spec's acceptance-criteria IDs: where each failing test stopped (file:line) and its error.

Most of these tests should fail right now. What matters is **why** each one fails. Review every test and sort it into one of these:

- **Expected**: it fails only because the behavior this spec adds doesn't exist yet. Examples: a new button, label, heading or field isn't there; a new endpoint returns 404; the old behavior that this spec changes is still in place. Leave it as is.
- **Test bug**: it fails before it gets to anything this spec adds, or for a reason unrelated to this spec. Fix it. Signs:
  - It stops in login, setup, or a shared helper (`tests/helpers/…`), or on a screen or API that already exists and this spec doesn't change.
  - A URL or body contains `undefined` or `null` (a wrong field name, or a value read from the wrong place).
  - It calls an endpoint, or reads a field, that no spec in `/app/specs/` defines. Check the spec that owns it. Behavior from other specs (e.g. which endpoint a button calls) is defined there, not here.
  - It logs in again while already logged in, reads state before the screen has loaded, measures while the mouse is hovering, counts errors from before the scenario starts, and similar mistakes in the test's own steps.
  - It depends on a feature from **another spec that isn't implemented yet** (that spec's endpoint returns 404, or its screen doesn't exist). Remove that part from this test, and note in `scenarios/` that it's checked when that spec is implemented.
- **Passes already**: fine only if the criterion is about something that must stay unchanged, or that already holds today. Otherwise the test doesn't check what the criterion says. Tighten it so it checks the new behavior.

Rules:

- Don't loosen a test to make it pass, and don't weaken what a criterion checks. Fix only the test's own mistakes.
- The rules from the first round still apply (only `tests/` and `scenarios/`, the spec's contract only, one test per ID, `<ID> description` names).
- You can't run the tests against the app. Reason from the error, the test code and the specs.
- Run `npx playwright test --list` again before you finish.

Finish with one line per ID: `<ID>: expected`, `<ID>: fixed — <what was wrong>`, or `<ID>: tightened — <how>`.

## Results against `main` (before implementation)

{{results}}
