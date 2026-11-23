---
name: blindforge-setup
description: Set up blindforge for an app. Checks the machine (Docker, Node, gh, a Claude credential), inspects the app repository to write apps/<app>.yaml, creates the hidden-test (holdout) repository from templates/holdout, prepares the app repository (specs/, health endpoint, port 8787, deploy workflow, bug form), and runs a first smoke check. Use when someone wants to start using blindforge, add another app to it, or asks "how do I set this up".
---

# Set up blindforge for an app

You are inside the blindforge repository. Walk the user through setup one step at a time. Check before you change anything, show what you're about to create, and ask before anything that creates or pushes to a GitHub repository.

Read `README.md` first. It defines the conventions below.

## 0. What you need from the user

Ask for these up front (one question, all together):

1. The app repository (`owner/name`). It must be on GitHub, and `gh` must be able to read it.
2. A short app name for blindforge commands (default: the repository name). This becomes `apps/<app>.yaml` and `blindforge build <app> <issue>`.
3. The name for the hidden-test repository (default: `<repo>-holdout`, private, same owner).
4. How they want to provide the Claude credential: an environment variable, or sops + age + direnv.

## 1. Check the machine

Run these and report one line each. Stop and explain how to fix anything that fails.

| Check | Command | Needed |
|---|---|---|
| Docker is running | `docker info --format '{{.ServerVersion}}'` | yes |
| Node.js 22+ | `node -v` | yes |
| gh is logged in | `gh auth status` | yes, with access to both repositories |
| git | `git --version` | yes |
| Claude credential | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is set (check presence only, never print it) | yes, before the first build |
| sops, age, direnv | `command -v sops age direnv` | only if they chose sops |

Then run `npm install` in this repository.

## 2. Inspect the app repository

Clone it shallowly into a temporary directory (`gh repo clone <owner/name> <tmp> -- --depth 1`) and read, without changing anything:

- **Package manager**: which lockfile is there (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`). The container image has Node, npm and pnpm 10. For yarn or anything else, tell the user that `agent.Dockerfile` needs it added.
- **Scripts** in `package.json` (and workspaces): lint, typecheck, unit tests, e2e, build, start/dev.
- **How the app starts and on which port.** blindforge starts it with `appCommand` and the hidden tests reach it at `http://localhost:8787`, so it must listen on `0.0.0.0:8787`. Find the flag or env var that sets host and port (e.g. `--host 0.0.0.0 --port 8787`, `PORT=8787`).
- **A health endpoint** that returns 2xx once the app is up (e.g. `/api/health`, `/healthz`). If none exists, `/` works for a plain web app. Otherwise suggest adding one.
- **Anything the app needs at runtime** besides Node: a database server, Redis, another language runtime. blindforge runs one app container. Anything more means changes to `compose.yaml` and `agent.Dockerfile`, so tell the user plainly before going on.
- Whether `specs/`, `CLAUDE.md`, `.github/workflows/`, and `.github/ISSUE_TEMPLATE/` exist.
- Paths a human should always review: auth, payments, security-sensitive code, the public API contract, the design system. These become `exceptions` and `contractDeletionPaths`.

Delete the temporary clone when done.

## 3. Write `apps/<app>.yaml`

Start from `apps/sample-app.yaml` and fill in what you found:

- `repo`, `holdoutRepo`, `baseBranch` (the repository's default branch)
- `installCommand`: the frozen-lockfile install (`pnpm install --frozen-lockfile`, `npm ci`)
- `gatesCommand`: lint, typecheck, tests and e2e chained with `&&`. Only include scripts that exist. If e2e uses Playwright, start with `pnpm exec playwright install chromium > /dev/null &&` (or the npm equivalent).
- `appCommand`: build, then start on `0.0.0.0:8787`. Add any test-mode flag the app has (a mode that exposes test-only endpoints, such as reading one-time codes, or that disables rate limits).
- `healthPath`
- `exceptions`: always `specs/`, `.github/`, `CLAUDE.md`, plus the sensitive paths you found
- `contractDeletionPaths`: the API contract and design-system paths, if any
- Keep `maxAttempts: 3`, `agent.maxTurns: 150` and the default timeouts unless the user says otherwise.

Show the file to the user and wait for their OK. `apps/*` is gitignored (except the sample), so this file stays on their machine.

## 4. Create the hidden-test repository

Show the user what you'll create, and ask before creating it.

1. `gh repo create <owner>/<holdout-name> --private`. It **must** be separate from the app repository and private if the app is, and the implementing AI must never get access to it.
2. Copy `templates/holdout/` into a fresh directory. Set `"name"` in its `package.json`. Make sure `@playwright/test` matches the Playwright version in `agent.Dockerfile` (`FROM mcr.microsoft.com/playwright:vX.Y.Z`). If you change it, regenerate the lockfile with `npm install --package-lock-only`.
3. In `playwright.config.ts`, add the app's `locale` / `timezoneId` under `use` if the app is not English or depends on a time zone.
4. Commit with the user's normal git identity and push the initial `main`. If their tooling blocks direct pushes to `main`, give them the exact push command to run themselves.

Check that it works: in that directory, `npm ci && BASE_URL=http://localhost:8787 npx playwright test --list` should finish with `Total: 0 tests` and no error.

## 5. Prepare the app repository

Do these on a branch in the app repository and open one PR for the user to review. Don't merge it yourself. List what you changed in the PR body.

- **`specs/`**: create it if missing, with `templates/app/specs/README.md`. Only `NNN-<name>.md` files are read as specs, so the README is safe.
- **Host and port**: if the app can't listen on `0.0.0.0:8787` yet, make that configurable (an env var or a flag). Keep its default behavior unchanged.
- **Health endpoint**: add a minimal one if there is none and `/` won't do.
- **Deploy**: if they deploy from GitHub Actions, add a workflow triggered by a `deploy-*` release, starting from `templates/app/.github/workflows/deploy.yml`, with their real deploy step. If they don't deploy that way, skip this. `blindforge deploy` only creates the release.
- **Bug form** (optional but recommended): `templates/app/.github/ISSUE_TEMPLATE/bug.yml`. It lets bug issues name their spec, so `blindforge build` can skip the spec step.
- **`CLAUDE.md`** (optional): if there is none, suggest a short one describing the stack, the commands from step 3, and code conventions. The implementing AI reads it first. Rules for the AI can also go in `blindforge/rules.md`.

## 6. Credential

- **Environment variable**: tell them to export `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY` in the shell they run blindforge from. Never ask them to paste it into the chat.
- **sops + age + direnv**: have them run `sops --age "$(age-keygen -y ~/.config/sops/age/keys.txt)" secrets.enc.env` themselves, add `CLAUDE_CODE_OAUTH_TOKEN=...`, then `direnv allow`. `secrets.enc.env` is gitignored.

## 7. Smoke check

1. `./bin/blindforge status --once` renders.
2. Suggest a first small issue for their app and walk them through it:
   - `blindforge spec <app> <issue>`, then review and merge the spec PR
   - `blindforge build <app> <issue>`
   - watch it with `blindforge status`

   The first build is slower, because it builds the container image and fills empty dependency caches.

Finish with a short summary: the files you created, the PR(s) waiting for their review, and the commands to run next.

## Don'ts

- Never print, log or commit the Claude credential or any other secret.
- Never put the hidden tests where the implementing AI can read them: not in the app repository, not in a public repository, not in a branch of the app repository.
- Never change `templates/holdout/scripts/summarize.mjs`'s output. It's the only thing the implementing AI learns from the tests.
- Don't push to the app's default branch. Open a PR.
