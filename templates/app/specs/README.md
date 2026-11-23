# Specs

One spec per feature: `NNN-<short-name>.md` (`001-auth-login.md`, `002-...`). `blindforge spec` drafts them from issues, and you review them as PRs.

A spec needs at least:

```markdown
# 001 Sign in with an email code

issue: #1

## Purpose
...

## Screens and UI contract
The exact labels, headings, roles and wording the hidden tests will rely on.

## Acceptance criteria

| ID | What to check |
|---|---|
| A1 | Entering a registered email and pressing "Send code" shows "We sent you a code" |
| A2 | ... |

### Code rules (checked by gates)

| ID | What to check |
|---|---|
| A20 | The login form has a unit test |
```

- Every ID becomes one hidden test, so IDs are unique across all specs. Don't reuse an ID; mark a removed one as retired instead (`A7: retired`).
- Rows under a `###` heading containing the word `gate` are checked by your lint / typecheck / test / e2e, not by the hidden tests.
