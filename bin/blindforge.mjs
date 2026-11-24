#!/usr/bin/env node
// Orchestrator for the software factory.
//
//   blindforge spec <app> <issue>       Draft a spec from the issue and open a PR (a human merges it).
//                                    If the spec PR is already open, revise it per the PR's unaddressed comments
//   blindforge holdout <app> <issue>    Write the holdout from the spec's acceptance criteria; merge it if the checks pass
//   blindforge run <app> <issue>        Implement the issue and take it through to merge
//   blindforge build <app> <issue>      Run holdout, then run (after the spec is merged, this is all you need)
//   blindforge resume <app> <issue>     Continue from the issue's open draft PR (e.g. after the judge's spec fix is merged)
//   blindforge regress <app>            Run every hidden test against the base branch (builds only run their spec's tests + @golden)
//   blindforge deploy <app>             Tag main and create a Release (also runs automatically after an auto-merge).
//                                    The production deploy is done by the app's GitHub Actions, triggered by the Release
//   blindforge preview <app> <pr|branch> Start it in a container and expose it on localhost so a human can try it
//   blindforge status                   Show running and past factory runs in a TUI (--once to print once)
//
// 1. Clone the app repo into a throwaway workspace
// 2. Have the AI implement it in the agent container (it can only see the workspace)
// 3. Commit on the host and run the gates in the gates container
// 4. Run the acceptance tests in the app / holdout containers (the AI only gets IDs and pass/fail)
// 5. On failure, go back to 2 (up to maxAttempts)
// 6. On success, push and open a PR; merge it unless it touches exception paths
//
// Only this script (on the host) pushes, opens PRs, merges, and creates Releases. The agent container gets no GitHub credentials.
// The factory holds no production credentials (only the app's GitHub Actions touch production).

import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { baseRunReview } from "./holdout-review.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---- Run status (read by blindforge status) ----
// Each run writes state/<app>-<command>-<target>-<runId>.json
const STATE_DIR = join(ROOT, "state");
let current = null;

function startStatus(command, app, target) {
  mkdirSync(STATE_DIR, { recursive: true });
  const startedAt = new Date().toISOString();
  current = {
    file: join(STATE_DIR, `${app.name}-${command}-${target}-${startedAt.replace(/[:.]/g, "-")}.json`),
    command, app: app.name, target: String(target), pid: process.pid,
    startedAt, stage: "preparing", attempt: 0, maxAttempts: app.maxAttempts, events: [],
  };
  saveStatus();
}
function saveStatus() {
  if (!current) return;
  current.updatedAt = new Date().toISOString();
  writeFileSync(current.file, JSON.stringify(current, null, 2));
}
function setStatus(patch) {
  if (!current) return;
  Object.assign(current, patch);
  saveStatus();
}

const log = (msg) => {
  console.log(`\x1b[36m[blindforge]\x1b[0m ${msg}`);
  if (current) {
    current.events.push({ at: new Date().toISOString(), msg: String(msg) });
    saveStatus();
  }
};
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts }).trim();

// App config lives in apps/<name>.yaml (.yml also works)
function loadApp(name) {
  const file = [".yaml", ".yml"].map((ext) => join(ROOT, "apps", `${name}${ext}`)).find((f) => existsSync(f));
  if (!file) throw new Error(`unknown app: ${name} (apps/${name}.yaml not found)`);
  const cfg = parseYaml(readFileSync(file, "utf8"));
  cfg.name = name;
  return cfg;
}

const runIdNow = () => new Date().toISOString().replace(/[:.]/g, "-");

// Make a throwaway clone. Without a branch, it stays on the default branch
function cloneFresh(repo, dir, { branch } = {}) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  sh("gh", ["repo", "clone", repo, dir, "--", "-q"]);
  sh("git", ["-C", dir, "config", "user.name", "blindforge"]);
  sh("git", ["-C", dir, "config", "user.email", "blindforge@localhost"]);
  if (branch) sh("git", ["-C", dir, "checkout", "-q", "-b", branch]);
  return dir;
}

// Find the spec for an issue and pull the IDs out of its acceptance criteria table.
//   1. The spec the issue references (bug fixes and other issues within an existing spec's scope)
//      - a `spec: specs/<file>.md` line in the body
//      - the "### Related spec" (or "### 関連する spec") field of the bug form
//   2. Otherwise, the spec containing `issue: #<n>` (a spec made by blindforge spec)
class SpecNotFound extends Error {}

function specReference(issueBody) {
  const line = issueBody.match(/^spec:\s*`?(specs\/[\w.-]+\.md)`?\s*$/m)?.[1];
  const form = issueBody.match(/^###\s*(?:関連する spec|[Rr]elated [Ss]pec)\s*\n+\s*`?(specs\/[\w.-]+\.md)`?\s*$/m)?.[1];
  return line ?? form;
}

function findSpec(appDir, issue, issueBody = "") {
  const specsDir = join(appDir, "specs");
  const ref = specReference(issueBody);
  let file;
  if (ref) {
    if (!existsSync(join(appDir, ref))) throw new SpecNotFound(`${ref}, referenced by issue #${issue}, is not on main`);
    file = ref.slice("specs/".length);
  } else {
    file = readdirSync(specsDir)
      .filter(isSpecFile)
      .find((f) => new RegExp(`^issue:\\s*#${issue}\\b`, "m").test(readFileSync(join(specsDir, f), "utf8")));
  }
  if (!file) {
    throw new SpecNotFound(
      `No spec found for issue #${issue}. For a new feature, run blindforge spec and merge the spec. ` +
        `If it falls within an existing spec (e.g. a bug fix), add a \`spec: specs/<file>.md\` line to the issue body`,
    );
  }
  const { holdoutIds, gateIds } = acceptanceIds(readFileSync(join(specsDir, file), "utf8"));
  if (holdoutIds.length + gateIds.length === 0) throw new SpecNotFound(`specs/${file} has no acceptance criteria table`);
  return { file: `specs/${file}`, ids: holdoutIds, gateIds, referenced: Boolean(ref) };
}

// Pull the IDs out of the acceptance criteria table.
// IDs in a section whose ### heading says "gates" (or ゲート) are checked by the gates (lint / tests), not by the acceptance tests (holdout).
// The holdout only checks from the outside via a browser and HTTP, so it can't check things like code conventions
function acceptanceIds(specText) {
  const section = specText.split(/^## /m).find((sec) => sec.startsWith("受け入れ条件") || /^acceptance criteria/i.test(sec)) ?? "";
  const holdoutIds = [];
  const gateIds = [];
  for (const part of section.split(/^### /m)) {
    const isGate = /ゲート|\bgates?\b/i.test(part.split("\n")[0]);
    for (const m of part.matchAll(/^\|\s*([A-Z]+\d+)\s*\|/gm)) (isGate ? gateIds : holdoutIds).push(m[1]);
  }
  return { holdoutIds, gateIds };
}

// IDs that already have tests in the holdout (the start of the test name). Only reads files on the host; never runs the test code
function usedHoldoutIds(app, dir) {
  cloneFresh(app.holdoutRepo, dir);
  const ids = new Set();
  const walk = (d) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      if (name.name === "node_modules" || name.name.startsWith(".")) continue;
      const p = join(d, name.name);
      if (name.isDirectory()) walk(p);
      else if (/\.(ts|js|mjs)$/.test(name.name)) {
        for (const m of readFileSync(p, "utf8").matchAll(/\btest(?:\.\w+)?\(\s*["'`]([A-Z]+\d+)\s/g)) ids.add(m[1]);
      }
    }
  };
  if (existsSync(join(dir, "tests"))) walk(join(dir, "tests"));
  rmSync(dir, { recursive: true, force: true });
  return [...ids].sort();
}

// IDs used by existing specs (acceptance criteria tables, gates sections included), plus IDs on lines marked as retired (or 欠番).
// Even if the holdout has no test for them yet, reusing another spec's ID makes the factory think "the test already exists"
// Only NNN-<name>.md files under specs/ are specs. Others (a README with example tables, notes) are ignored
const isSpecFile = (name) => /^\d+-.+\.md$/.test(name);

function usedSpecIds(workspace, exceptFile) {
  const dir = join(workspace, "specs");
  const ids = new Set();
  if (!existsSync(dir)) return [];
  for (const name of readdirSync(dir)) {
    if (!isSpecFile(name) || join("specs", name) === exceptFile) continue;
    const text = readFileSync(join(dir, name), "utf8");
    const { holdoutIds, gateIds } = acceptanceIds(text);
    for (const id of [...holdoutIds, ...gateIds]) ids.add(id);
    for (const line of text.split("\n").filter((l) => l.includes("欠番") || /retired/i.test(l))) {
      for (const m of line.matchAll(/\b([A-Z]\d+)\b/g)) ids.add(m[1]);
    }
  }
  return [...ids];
}
const usedIdsFor = (app, issue, workspace, exceptFile) =>
  [...new Set([...usedHoldoutIds(app, join(ROOT, "work", app.name, `spec-issue-${issue}-holdout`)), ...usedSpecIds(workspace, exceptFile)])]
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

// Acceptance criteria IDs in the spec that are already in use (they would collide with another test's ID)
function idCollisions(specPath, usedIds) {
  const { holdoutIds, gateIds } = acceptanceIds(readFileSync(specPath, "utf8"));
  return [...holdoutIds, ...gateIds].filter((id) => usedIds.includes(id));
}
const collisionWarning = (ids) =>
  ids.length
    ? `⚠️ **Acceptance criteria IDs collide with existing specs, holdout tests, or retired IDs: ${ids.join(", ")}**. As is, blindforge will assume the tests already exist and won't write new ones. Change the IDs (or point this out in a PR comment and blindforge will fix it).\n\n`
    : "";

// Failure in the factory's infrastructure (network, Docker, etc.). Stop without using up the AI's attempts
class InfraError extends Error {}
const timedOut = (res) => res?.error?.code === "ETIMEDOUT";
const minutes = (ctx, key) => ctx.app.timeoutsMinutes?.[key];

const render = (template, vars) =>
  readFileSync(join(ROOT, "prompts", template), "utf8").replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");

// Named cache volumes can end up owned by root, depending on how they were first created.
// Containers run as pwuser, so fix the owner before use (once per factory process)
const CACHE_VOLUMES = ["blindforge-pnpm-store", "blindforge-pnpm-store-agent", "blindforge-npm-holdout", "blindforge-npm-holdout-writer"];
let cachesReady = false;
function prepareCaches() {
  if (cachesReady) return;
  // Rebuild the image from this checkout's Dockerfile (a few seconds from cache if nothing changed).
  // Prevents running on a stale image whose volume or tool assumptions have drifted
  const build = spawnSync("docker", ["build", "-q", "-f", join(ROOT, "agent.Dockerfile"), "-t", "blindforge-agent", ROOT], { encoding: "utf8" });
  if (build.status !== 0) throw new InfraError(`Could not build the factory image: ${build.stderr}`);
  for (const v of CACHE_VOLUMES) {
    const res = spawnSync("docker", ["run", "--rm", "-u", "root", "-v", `${v}:/v`, "blindforge-agent", "chown", "pwuser:pwuser", "/v"], { encoding: "utf8" });
    if (res.status !== 0) throw new InfraError(`Could not prepare cache volume ${v}: ${res.stderr}`);
  }
  cachesReady = true;
}

function compose(ctx, args, { capture = false, stdio, timeoutMin } = {}) {
  prepareCaches();
  const env = {
    ...process.env,
    WORKSPACE: ctx.workspace,
    // Every variable in compose.yaml must be set even for commands that don't use it, so fall back to the report dir
    HOLDOUT: ctx.holdout ?? ctx.reportDir,
    APP_SRC: ctx.appSrc ?? ctx.reportDir,
    REPORT_DIR: ctx.reportDir,
    INSTALL_COMMAND: ctx.app.installCommand,
    GATES_COMMAND: ctx.app.gatesCommand,
    APP_COMMAND: ctx.app.appCommand,
    HEALTH_PATH: ctx.app.healthPath ?? "/",
    ...ctx.extraEnv,
  };
  const base = ["compose", "-f", join(ROOT, "compose.yaml"), "-p", ctx.project];
  const res = spawnSync("docker", [...base, ...args], {
    env,
    encoding: "utf8",
    stdio: stdio ?? (capture ? ["ignore", "pipe", "pipe"] : "inherit"),
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMin ? timeoutMin * 60_000 : undefined,
  });
  // `run --rm` removes the container but leaves the project network behind. Left to pile up, they exhaust Docker's address pool
  // and new networks fail with "non-overlapping IPv4 address pool", so clean up every time.
  // down sometimes keeps the network in projects whose services all have profiles, so remove it directly by name.
  // If it's in use this just fails (networks of other commands running in parallel are not removed)
  if (args.includes("run") || args.includes("down")) {
    if (args.includes("run")) spawnSync("docker", [...base, "down", "--remove-orphans"], { env, stdio: "ignore", timeout: 120_000 });
    spawnSync("docker", ["network", "rm", `${ctx.project}_default`], { stdio: "ignore", timeout: 60_000 });
  }
  return res;
}

// The AI's output is streamed as stream-json into agent.jsonl, one line at a time (blindforge status reads progress from it).
// When done, the final result is written to agent.log
function runAgent(ctx, prompt, attempt, service = "agent") {
  setStatus({ stage: service === "agent" ? "AI working" : service, attempt, reportDir: ctx.reportDir });
  log(`attempt ${attempt}: ${service} is working…`);
  const out = openSync(join(ctx.reportDir, "agent.jsonl"), "w");
  const err = openSync(join(ctx.reportDir, "agent.stderr"), "w");
  let res;
  try {
    res = compose(
      ctx,
      [
        "--profile", service, "run", "--rm", "-T", service,
        "claude", "-p", prompt,
        "--dangerously-skip-permissions",
        "--max-turns", String(ctx.app.agent.maxTurns),
        "--output-format", "stream-json", "--verbose",
      ],
      { stdio: ["ignore", out, err], timeoutMin: minutes(ctx, "agent") },
    );
    if (timedOut(res)) {
      log(`${service} did not finish within ${minutes(ctx, "agent")} minutes, so it was stopped`);
      compose(ctx, ["--profile", service, "down"], { capture: true });
    }
  } finally {
    closeSync(out);
    closeSync(err);
  }
  const lines = readFileSync(join(ctx.reportDir, "agent.jsonl"), "utf8").split("\n").filter(Boolean);
  const result = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e?.type === "result").pop();
  writeFileSync(
    join(ctx.reportDir, "agent.log"),
    `${result?.result ?? "(no result)"}\n--- stderr ---\n${readFileSync(join(ctx.reportDir, "agent.stderr"), "utf8")}`,
  );
  if (result) setStatus({ turns: (current?.turns ?? 0) + (result.num_turns ?? 0) });
  if (res.status !== 0) log(`${service} exited abnormally (exit ${res.status}). Log: ${ctx.reportDir}/agent.log`);
}

// Paths the AI may not change. Changes there are discarded instead of committed.
// .github/: the app's GitHub Actions hold the deploy secrets. Workflows also run on PRs from branches the factory pushes,
// so to keep AI-written workflows from reading secrets, they are never pushed at all
const DISCARDED_PATHS = [".github"];

// Compare against the commit right after cloning (ctx.baseSha), not HEAD, and restore that commit's state,
// so changes are discarded even if the AI ran git commit inside the container
function discardForbidden(ctx) {
  const git = (...a) => sh("git", ["-C", ctx.workspace, ...a]);
  const touched = [
    git("diff", "--name-only", ctx.baseSha, "--", ...DISCARDED_PATHS),
    git("ls-files", "--others", "--exclude-standard", "--", ...DISCARDED_PATHS),
  ].filter(Boolean).join("\n");
  if (!touched) return;
  for (const p of DISCARDED_PATHS) {
    git("rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", p);
    rmSync(join(ctx.workspace, p), { recursive: true, force: true });
    if (git("ls-tree", "--name-only", ctx.baseSha, "--", p)) git("checkout", "-q", ctx.baseSha, "--", p);
  }
  log(`Discarded the AI's changes under ${DISCARDED_PATHS.join(", ")}:\n${touched}`);
}

function commitWorkspace(ctx, attempt) {
  const git = (...a) => sh("git", ["-C", ctx.workspace, ...a]);
  discardForbidden(ctx);
  git("add", "-A");
  const staged = spawnSync("git", ["-C", ctx.workspace, "diff", "--cached", "--quiet"]).status !== 0;
  if (staged) git("commit", "-q", "-m", `blindforge: issue #${ctx.issue} attempt ${attempt}`);
  return staged;
}

function runGates(ctx) {
  for (let i = 1; i <= 2; i++) {
    setStatus({ stage: "gates" });
    log("gates: lint / types / unit / E2E");
    const res = compose(ctx, ["--profile", "gates", "run", "--rm", "-T", "gates"], {
      capture: true, timeoutMin: minutes(ctx, "gates"),
    });
    writeFileSync(join(ctx.reportDir, "gates.log"), `${res.stdout}\n--- stderr ---\n${res.stderr}`);
    if (timedOut(res)) {
      compose(ctx, ["--profile", "gates", "down"], { capture: true });
      log(`gates did not finish within ${minutes(ctx, "gates")} minutes (a test may be hanging)`);
      return false;
    }
    if (res.status !== 97) return res.status === 0;
    log(`gates: dependency install failed (infrastructure).${i === 1 ? " Retrying" : ""}`);
  }
  throw new InfraError(`gates dependency install failed twice (network or similar). Log: ${ctx.reportDir}/gates.log`);
}

function runHoldout(ctx, { grep, args, label } = {}) {
  ctx = { ...ctx, extraEnv: { ...ctx.extraEnv, ...(grep ? { HOLDOUT_GREP: grep } : {}), ...(args ? { HOLDOUT_ARGS: args } : {}) } };
  const report = join(ctx.reportDir, "report.json");
  const progress = join(ctx.reportDir, "progress.jsonl"); // written by reporter/progress-reporter.cjs
  for (let i = 1; i <= 2; i++) {
    setStatus({ stage: "holdout", reportDir: ctx.reportDir });
    log(`holdout: acceptance tests${label ? ` (${label})` : ""}`);
    rmSync(report, { force: true });
    rmSync(progress, { force: true });
    let res;
    try {
      res = compose(ctx, ["--profile", "holdout", "up", "--build", "--abort-on-container-exit", "--exit-code-from", "holdout"], {
        capture: true, timeoutMin: minutes(ctx, "holdout"),
      });
    } finally {
      const logs = compose(ctx, ["--profile", "holdout", "logs", "--no-color", "--no-log-prefix", "app"], { capture: true });
      writeFileSync(join(ctx.reportDir, "app.log"), logs.stdout ?? "");
      compose(ctx, ["--profile", "holdout", "down"], { capture: true });
    }
    // When a run is cut off by the timeout, the redirect target report.json is left empty.
    // Don't hand an empty report to the AI as a test failure (HARNESS); treat it as a run that couldn't happen
    if (existsSync(report) && statSync(report).size > 0) {
      const summary = JSON.parse(sh("node", [join(ctx.holdout, "scripts", "summarize.mjs"), report]));
      noteFlaky(ctx, reportTests(report).filter((t) => t.status === "flaky"), "passed only on retry");
      // Zero scenarios is not a "failure" (the AI can't fix it), but it's no evidence of passing either.
      // Stop the loop, but don't auto-merge; send it to a human instead (holdoutEmpty in finish)
      return { passed: summary.every((x) => x.status === "passed"), empty: summary.length === 0, summary };
    }
    const why = timedOut(res) ? `did not finish within ${minutes(ctx, "holdout")} minutes`
      : res.status === 97 ? "holdout dependency install failed"
      : "the app did not start (e.g. dependency install failed)";
    log(`Could not run the holdout: ${why} (infrastructure).${i === 1 ? " Retrying" : ""}`);
  }
  throw new InfraError(`Could not run the holdout twice. App log: ${ctx.reportDir}/app.log`);
}

function exceptionHits(ctx) {
  const base = `origin/${ctx.app.baseBranch}`;
  const numstat = sh("git", ["-C", ctx.workspace, "diff", "--numstat", `${base}...HEAD`])
    .split("\n").filter(Boolean)
    .map((l) => { const [add, del, file] = l.split("\t"); return { file, deletions: Number(del) || 0 }; });
  const match = (f, pat) => (pat.endsWith("/") ? f.startsWith(pat) : f === pat);
  return numstat
    .filter(({ file, deletions }) =>
      ctx.app.exceptions.some((p) => match(file, p)) ||
      (deletions > 0 && (ctx.app.contractDeletionPaths ?? []).some((p) => match(file, p))))
    .map((x) => x.file);
}

// List the tests in the holdout clone inside a container and return their IDs (never run AI-written code on the host)
function listHoldoutIds(ctx) {
  const res = compose(
    { ...ctx, workspace: ctx.holdout },
    ["--profile", "holdout-writer", "run", "--rm", "holdout-writer", "sh", "-c",
      "npm ci --silent && BASE_URL=http://localhost:8787 npx playwright test --list"],
    { capture: true },
  );
  if (res.status !== 0) throw new Error(`Could not list the holdout tests:\n${res.stdout}\n${res.stderr}`);
  return new Set([...res.stdout.matchAll(/› ([A-Z]+\d+) /g)].map((m) => m[1]));
}

function openPr(ctx, { draft, body, title = `blindforge: ${ctx.title}`, repo = ctx.app.repo, force = false }) {
  sh("git", ["-C", ctx.workspace, "push", "-q", "-u", ...(force ? ["--force"] : []), "origin", ctx.branch]);
  // Reuse the open PR for this branch (e.g. the draft that `resume` picked up) instead of failing on "already exists"
  const existing = JSON.parse(sh("gh", ["pr", "list", "-R", repo, "--head", ctx.branch, "--state", "open", "--json", "url,isDraft"]))[0];
  let url;
  if (existing) {
    url = existing.url;
    sh("gh", ["pr", "edit", url, "--title", title, "--body", body]);
    if (existing.isDraft && !draft) sh("gh", ["pr", "ready", url]);
    if (!existing.isDraft && draft) sh("gh", ["pr", "ready", url, "--undo"]);
  } else {
    const args = ["pr", "create", "-R", repo, "--base", ctx.app.baseBranch, "--head", ctx.branch,
      "--title", title, "--body", body];
    if (draft) args.push("--draft");
    url = sh("gh", args);
  }
  setStatus({ stage: "PR", pr: url });
  return url;
}

async function run(appName, issue) {
  const app = loadApp(appName);
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) throw new Error("CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY is not set");

  const issueJson = JSON.parse(sh("gh", ["issue", "view", String(issue), "-R", app.repo, "--json", "title,body"]));
  const runId = runIdNow();
  const ctx = {
    app, issue, title: issueJson.title,
    project: `blindforge-${app.name}-${issue}`,
    branch: `blindforge/issue-${issue}`,
    workspace: join(ROOT, "work", app.name, `issue-${issue}`),
    reportRoot: join(ROOT, "reports", app.name, `issue-${issue}`, runId),
  };

  log(`issue #${issue}: ${ctx.title}`);
  // Close PRs left over from a previous run (failed drafts, etc.) and recreate the branch from scratch
  const previous = JSON.parse(sh("gh", ["pr", "list", "-R", app.repo, "--head", ctx.branch, "--state", "open", "--json", "number,url"]));
  for (const pr of previous) {
    sh("gh", ["pr", "close", String(pr.number), "-R", app.repo, "--delete-branch", "--comment",
      `${FACTORY_MARK}\n🏭 blindforge: implementing issue #${issue} again, so closing this PR.`]);
    log(`Closed the previous PR: ${pr.url}`);
  }
  cloneFresh(app.repo, ctx.workspace, { branch: ctx.branch });
  ctx.baseSha = sh("git", ["-C", ctx.workspace, "rev-parse", "HEAD"]);
  ctx.holdout = cloneFresh(app.holdoutRepo, join(ROOT, "work", app.name, `issue-${issue}-holdout`));

  // Don't start implementing without tests
  const target = withSpec(app, issue, ctx.workspace, issueJson.body);
  ctx.target = target;
  ctx.reportDir = ctx.reportRoot;
  mkdirSync(ctx.reportDir, { recursive: true });
  const listed = listHoldoutIds(ctx);
  const missing = target.ids.filter((id) => !listed.has(id));
  if (missing.length > 0) {
    throw new Error(`Acceptance criteria in ${target.file} with no holdout test: ${missing.join(", ")}. Run blindforge holdout first`);
  }
  log(`${target.file}: found tests for all ${target.ids.length} acceptance criteria`);

  const gateNote = target.gateIds.length
    ? `Of the spec's acceptance criteria, ${target.gateIds.join(", ")} are checked by the gates (pnpm lint / typecheck / test / e2e), not by the acceptance tests. Read that section of the spec and also implement the lint rules or tests that satisfy it.`
    : "";
  const prompt = render("implement.md", { issue, title: issueJson.title, body: issueJson.body, specFile: target.file, gateNote });

  try {
    return await implementLoop(ctx, prompt);
  } catch (e) {
    if (e instanceof InfraError) {
      sh("gh", ["issue", "comment", String(issue), "-R", app.repo, "--body", [
        FACTORY_MARK,
        "🏭 blindforge: stopped on an infrastructure failure (network, Docker, etc.). This is not a problem with the AI's implementation; once things settle, run `blindforge build` again.",
        "",
        `> ${e.message}`,
      ].join("\n")]);
    }
    throw e;
  }
}

// ---- What the holdout runs, flaky tests, and the full regression run ----

// A Playwright --grep pattern for these acceptance-criteria IDs (test titles start with "<ID> "), optionally plus @golden.
// Playwright matches it against "<project> <file> <describe> <title> <tags>", so the ID is preceded by a space
const idGrep = (ids, { golden = false } = {}) =>
  [`(^| )(${[...new Set(ids)].join("|")}) `, ...(golden ? ["@golden"] : [])].join("|");

// What a build scores: this spec's tests plus the golden path (default), or every test (holdoutScope: all).
// The full suite runs separately with `blindforge regress`
function buildScope(ctx) {
  if (ctx.app.holdoutScope === "all") return { label: "all tests" };
  return {
    grep: idGrep(ctx.target.ids, { golden: true }),
    label: `${ctx.target.ids.length} IDs of ${ctx.target.file} + @golden`,
  };
}

// Tests in a Playwright JSON report, with their status ("expected", "unexpected", "flaky", "skipped")
function reportTests(reportFile) {
  let report;
  try { report = JSON.parse(readFileSync(reportFile, "utf8")); } catch { return []; }
  const out = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) out.push({ id: spec.title.split(/\s+/)[0], title: spec.title, file: spec.file, status: t.status, ok: spec.ok });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return out;
}

// The flaky ledger: state/flaky.jsonl, one line per test that passed only on retry or failed when repeated.
// `blindforge status` shows it. A test that's been flaky twice gets an issue in the holdout repo (once)
const FLAKY_LEDGER = join(STATE_DIR, "flaky.jsonl");
function noteFlaky(ctx, items, how) {
  const seen = new Map(items.map((x) => [x.id, x]));
  if (seen.size === 0) return;
  mkdirSync(STATE_DIR, { recursive: true });
  const at = new Date().toISOString();
  const source = `${current?.command ?? "run"} ${ctx.app.name} ${ctx.issue === "regress" ? "main" : `#${ctx.issue}`}`;
  appendFileSync(FLAKY_LEDGER, [...seen.values()]
    .map((x) => `${JSON.stringify({ at, app: ctx.app.name, id: x.id, title: x.title, file: x.file, how, source })}\n`).join(""));
  log(`flaky: ${[...seen.keys()].join(", ")} (${how})`);

  const ledger = readFileSync(FLAKY_LEDGER, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e?.app === ctx.app.name);
  for (const x of seen.values()) {
    const count = ledger.filter((e) => e.id === x.id).length;
    if (count < 2) continue;
    const title = `flaky: ${x.title}`;
    try {
      const open = JSON.parse(sh("gh", ["issue", "list", "-R", ctx.app.holdoutRepo, "--state", "open", "--search", `flaky ${x.id} in:title`, "--json", "title"]));
      if (open.some((i) => i.title.startsWith(`flaky: ${x.id} `))) continue;
      sh("gh", ["issue", "create", "-R", ctx.app.holdoutRepo, "--title", title, "--body", [
        `blindforge has seen this test pass only on retry, or fail when repeated, ${count} times.`,
        "",
        `- File: \`${x.file ?? "?"}\``,
        `- Latest: ${how}, during \`${source}\``,
        "",
        "Fix the test so it waits for the state it checks: no fixed sleeps, no reads that don't wait, nothing measured mid-animation. If the app itself is racy, say so here, so it can be fixed in the app.",
      ].join("\n")]);
      log(`flaky: opened an issue in ${ctx.app.holdoutRepo} for ${x.id}`);
    } catch (e) {
      log(`flaky: could not open an issue for ${x.id}: ${e.message.split("\n")[0]}`);
    }
  }
}

// After a pass: run this spec's tests a few more times without retries. Returns the IDs that failed at least once
function confirmStable(ctx) {
  const times = ctx.app.repeatCheck ?? 3;
  if (!times) return [];
  const rctx = { ...ctx, reportDir: `${ctx.reportDir}-repeat` };
  mkdirSync(rctx.reportDir, { recursive: true });
  runHoldout(rctx, { grep: idGrep(ctx.target.ids), args: `--retries=0 --repeat-each=${times}`, label: `this spec's tests ${times} more times, no retries` });
  const failing = reportTests(join(rctx.reportDir, "report.json")).filter((t) => t.status === "unexpected");
  noteFlaky(ctx, failing, `failed when repeated ${times} times`);
  return [...new Set(failing.map((t) => t.id))];
}

// What the test writer gets when its tests fail lint
const lintPrompt = (output) =>
  `The tests fail \`npm run lint\`. Its rules catch patterns that make tests flaky, and its type-check catches mistakes such as using a helper outside the test that defines it. Fix every problem below (wait for the state instead of sleeping, use web-first assertions such as \`expect(locator).toHaveText\` / \`toHaveAttribute\`). Don't disable rules. Then run \`npm run lint\` and \`npx playwright test --list\`.\n\n\`\`\`\n${output.slice(-6000)}\n\`\`\``;

// Every path where the writer changes tests outside the main holdout step (judge fixes, repairs, spec updates)
// must leave lint passing too, or the next spec's writer would inherit problems it didn't write. One extra round
function lintWriterChange(ctx, wctx, label) {
  const lint = lintHoldout(ctx);
  if (lint.ok) return true;
  log(`${label}: the test writer's change fails lint. Asking it to fix that`);
  writeFileSync(join(wctx.reportDir, "lint.log"), lint.output);
  runAgent(wctx, lintPrompt(lint.output), label, "holdout-writer");
  commitHoldout(ctx.holdout, `holdout: fix lint (issue #${ctx.issue})`);
  const again = lintHoldout(ctx);
  if (!again.ok) log(`${label}: lint still fails after one round. Merging anyway; the next holdout step will flag it`);
  return again.ok;
}

// The holdout repo's lint (if it has one): catches flaky patterns such as fixed sleeps when the tests are written
function lintHoldout(ctx) {
  const res = compose(
    { ...ctx, workspace: ctx.holdout },
    ["--profile", "holdout-writer", "run", "--rm", "holdout-writer", "sh", "-c", "npm ci --silent && npm run --if-present lint"],
    { capture: true },
  );
  return { ok: res.status === 0, output: `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim() };
}

// `blindforge regress <app>`: every hidden test against the base branch, outside of any build.
// Failures go into one issue on the app repo, listing only IDs and spec numbers (no test content)
async function regress(appName) {
  const app = loadApp(appName);
  const ctx = {
    app, issue: "regress", title: "regression run",
    project: `blindforge-${app.name}-regress`,
    workspace: join(ROOT, "work", app.name, "regress"),
    reportRoot: join(ROOT, "reports", app.name, "regress", runIdNow()),
  };
  cloneFresh(app.repo, ctx.workspace);
  const sha = sh("git", ["-C", ctx.workspace, "rev-parse", "--short", "HEAD"]);
  ctx.holdout = cloneFresh(app.holdoutRepo, join(ROOT, "work", app.name, "regress-holdout"));
  ctx.reportDir = ctx.reportRoot;
  mkdirSync(ctx.reportDir, { recursive: true });
  log(`regress: every hidden test against ${app.repo}@${sha}`);
  try {
    const { summary } = runHoldout(ctx, { label: "all tests" });
    const failing = summary.filter((x) => x.status !== "passed").map((x) => x.id);
    const tests = reportTests(join(ctx.reportDir, "report.json"));
    const specOf = (id) => tests.find((t) => t.id === id)?.file?.match(/(\d{3})-/)?.[1];

    const title = "regress: acceptance tests failing on main";
    const open = JSON.parse(sh("gh", ["issue", "list", "-R", app.repo, "--state", "open", "--search", `"${title}" in:title`, "--json", "number,title"]))
      .find((i) => i.title === title);
    if (failing.length === 0) {
      log(`regress: all ${summary.length} passed`);
      if (open) sh("gh", ["issue", "close", String(open.number), "-R", app.repo, "--comment", `${FACTORY_MARK}\n✅ All acceptance tests pass on ${sha}.`]);
      return 0;
    }
    const body = [
      FACTORY_MARK,
      `❌ ${failing.length} of ${summary.length} acceptance tests fail on \`${sha}\` (\`blindforge regress\`).`,
      "",
      ...failing.map((id) => `- ${id}${specOf(id) ? ` (spec ${specOf(id)})` : ""}`),
      "",
      "Either a change broke these, or the tests are wrong. Check them against their specs.",
    ].join("\n");
    if (open) sh("gh", ["issue", "comment", String(open.number), "-R", app.repo, "--body", body]);
    else sh("gh", ["issue", "create", "-R", app.repo, "--title", title, "--body", body]);
    log(`regress: ${failing.length} failing: ${failing.join(", ")}`);
    return 1;
  } finally {
    rmSync(ctx.workspace, { recursive: true, force: true });
    rmSync(ctx.holdout, { recursive: true, force: true });
  }
}

// Gates, then the holdout. skipGates re-scores the same commit after only the tests changed
function score(ctx, { skipGates = false } = {}) {
  if (!skipGates && !runGates(ctx)) {
    return { gates: false, passed: false, empty: false, ids: [], failures: "Failed: gates (one of lint / typecheck / test / e2e)" };
  }
  const { passed, empty, summary } = runHoldout(ctx, buildScope(ctx));
  writeFileSync(join(ctx.reportDir, "holdout-result.json"), JSON.stringify(summary));
  const ids = summary.filter((x) => x.status !== "passed").map((x) => x.id);
  if (passed && !empty) {
    // Passing once isn't enough: repeat this spec's tests without retries to catch flaky tests and racy code
    const unstable = confirmStable(ctx);
    if (unstable.length > 0) {
      return { gates: true, passed: false, empty, ids: unstable, failures: `Failed holdout scenarios when repeated (intermittent): ${unstable.join(", ")}` };
    }
  }
  return { gates: true, passed, empty, ids, failures: `Failed holdout scenarios: ${ids.join(", ") || "(no result)"}` };
}

async function implementLoop(ctx, firstPrompt, { scoreFirst = false } = {}) {
  const { app } = ctx;
  let prompt = firstPrompt;
  let failures = "";
  const history = []; // { attempt, gates, ids } per attempt, for the judge
  for (let attempt = 1; attempt <= app.maxAttempts; attempt++) {
    ctx.reportDir = join(ctx.reportRoot, `attempt-${attempt}`);
    mkdirSync(ctx.reportDir, { recursive: true });

    if (scoreFirst && attempt === 1) {
      log(`attempt ${attempt}: scoring the existing implementation`);
    } else {
      runAgent(ctx, prompt, attempt);
      commitWorkspace(ctx, attempt);
    }

    let result = score(ctx);
    if (result.passed) {
      log(result.empty ? `attempt ${attempt}: gates passed. The holdout has 0 scenarios` : `attempt ${attempt}: passed`);
      return finish(ctx, true, "", { holdoutEmpty: result.empty });
    }
    failures = result.failures;
    log(`attempt ${attempt}: failed — ${failures}`);
    history.push({ attempt, gates: result.gates, ids: result.ids });

    // The same acceptance tests failing in two attempts in a row: ask the judge, once per run
    let hints = "";
    const prev = history.at(-2);
    // A resumed draft already failed repeatedly before, so its first re-score counts as a repeat
    const resumedRepeat = scoreFirst && attempt === 1 && result.gates;
    const repeated = (prev?.gates || resumedRepeat) && result.gates
      ? result.ids.filter((id) => id !== "HARNESS" && (resumedRepeat || prev.ids.includes(id)))
      : [];
    if (repeated.length > 0 && !ctx.judged) {
      ctx.judged = true;
      const outcome = adjudicate(ctx, repeated, history);
      if (outcome.stop) return outcome.code;
      if (outcome.rescore) {
        ctx.reportDir = join(ctx.reportRoot, `attempt-${attempt}-rescore`);
        mkdirSync(ctx.reportDir, { recursive: true });
        log(`attempt ${attempt}: re-scoring the same implementation with the corrected tests`);
        const before = new Set(result.ids);
        result = score(ctx, { skipGates: true });
        // Only the tests changed, so a test that passed before and fails now was broken by the test fix.
        // That goes back to the test writer, never to the implementer (who could never fix it)
        const broken = result.ids.filter((id) => id !== "HARNESS" && !before.has(id));
        if (broken.length > 0 && repairTestRegression(ctx, broken)) {
          ctx.reportDir = join(ctx.reportRoot, `attempt-${attempt}-rescore-2`);
          mkdirSync(ctx.reportDir, { recursive: true });
          log(`attempt ${attempt}: re-scoring again after repairing the tests`);
          result = score(ctx, { skipGates: true });
        }
        if (result.passed) {
          log(`attempt ${attempt}: passed with the corrected tests`);
          return finish(ctx, true, "", { holdoutEmpty: result.empty });
        }
        failures = result.failures;
        log(`attempt ${attempt}: still failing — ${failures}`);
        history[history.length - 1] = { attempt, gates: true, ids: result.ids };
      }
      hints = outcome.hints;
    }
    prompt = render("fix.md", { failures, hints, specFile: ctx.target.file });
  }
  return finish(ctx, false, failures);
}

// Stage only tests/ and scenarios/ in the holdout clone and commit. Anything else the writer touched is discarded
function commitHoldout(dir, message) {
  const git = (...a) => sh("git", ["-C", dir, ...a]);
  git("reset", "-q", "--", ".");
  git("add", "-A", "--", "tests", "scenarios");
  git("checkout", "-q", "--", ".");
  const staged = spawnSync("git", ["-C", dir, "diff", "--cached", "--quiet"]).status !== 0;
  if (staged) git("commit", "-q", "-m", message);
  return staged;
}

// Push the holdout clone's current branch as a PR to the holdout repo and merge it
function mergeHoldoutBranch(ctx, wctx, title, body) {
  const url = openPr(wctx, { draft: false, force: true, repo: ctx.app.holdoutRepo, title, body });
  sh("gh", ["pr", "merge", url, "--squash", "--delete-branch"]);
  log(`Merged the holdout: ${url}`);
  setStatus({ pr: undefined });
  return url;
}

// The judge: the only role that sees both the implementation and the hidden tests.
// It decides test / implementation / spec / unsure per ID. blindforge passes on only spec-grounded messages:
// test findings to the test writer, implementation findings to the implementer, spec problems to a human (spec PR).
function adjudicate(ctx, ids, history) {
  const dir = join(ctx.reportRoot, "judge");
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(ctx.reportDir, "report.json"), join(dir, "report.json"));
  writeFileSync(join(dir, "history.md"), history
    .map((h) => `- attempt ${h.attempt}: ${h.gates ? `failed ${h.ids.join(", ") || "(none)"}` : "gates failed"}`).join("\n"));
  log(`judge: ${ids.join(", ")} failed in two attempts in a row. Asking the judge whether the test, the implementation or the spec is wrong`);
  const jctx = { ...ctx, reportDir: dir };
  runAgent(jctx, render("judge.md", { specFile: ctx.target.file, ids: ids.map((id) => `- ${id}`).join("\n") }), "judge", "judge");

  let verdict;
  try {
    verdict = JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8"));
  } catch {
    log("judge: no readable verdict.json. Continuing without it");
    return { hints: "" };
  }
  const pick = (v) => (verdict.ids ?? []).filter((x) => x.verdict === v && ids.includes(x.id));
  const tests = pick("test"), impls = pick("implementation"), specs = pick("spec"), unsure = pick("unsure");
  const names = (xs) => xs.map((x) => x.id).join(", ") || "-";
  log(`judge: test ${names(tests)} / implementation ${names(impls)} / spec ${names(specs)} / unsure ${names(unsure)}`);

  // Test findings are spec-grounded on their own, so apply them even when the run stops for a spec problem
  if (specs.length > 0) {
    if (tests.length > 0) fixTestsFromJudge(ctx, tests, dir);
    return { stop: true, code: proposeSpecChange(ctx, specs, dir) };
  }
  if (unsure.length > 0) {
    const url = openPr(ctx, {
      force: true, draft: true,
      body: [
        "⚖️ The judge couldn't decide whether the test, the implementation or the spec is wrong. Needs a human.",
        "",
        ...unsure.map((x) => `- **${x.id}**: ${x.question}`),
        "",
        `Once it's settled, run \`blindforge resume ${ctx.app.name} ${ctx.issue}\` to continue from this PR.`,
        "",
        `Closes #${ctx.issue}`,
      ].join("\n"),
    });
    log(`judge: waiting for a human: ${url}`);
    return { stop: true, code: 1 };
  }
  const rescore = tests.length > 0 && fixTestsFromJudge(ctx, tests, dir);
  const hints = impls.length > 0
    ? ["", "A review against the spec found these requirements still unmet:", ...impls.map((x) => `- ${x.toImplementer}`), ""].join("\n")
    : "";
  return { rescore, hints };
}

// Test findings go to the test writer, who still can't see the implementation. It fixes the tests against the spec
function fixTestsFromJudge(ctx, items, dir) {
  const branch = `holdout/judge-issue-${ctx.issue}`;
  sh("git", ["-C", ctx.holdout, "checkout", "-q", "-B", branch]);
  const wctx = { ...ctx, workspace: ctx.holdout, appSrc: ctx.workspace, reportDir: join(dir, "writer"), branch };
  mkdirSync(wctx.reportDir, { recursive: true });
  const findings = items.map((x) => `- **${x.id}**: ${x.toWriter}`).join("\n");
  runAgent(wctx, render("holdout-fix.md", { findings }), "judge", "holdout-writer");
  if (!commitHoldout(ctx.holdout, `holdout: fix tests flagged by the judge (issue #${ctx.issue})`)) {
    log("judge: the test writer changed nothing");
    return false;
  }
  const listed = listHoldoutIds(ctx);
  const missing = ctx.target.ids.filter((id) => !listed.has(id));
  if (missing.length > 0) {
    log(`judge: after the test fix, these IDs have no test: ${missing.join(", ")}. Dropping the fix`);
    sh("git", ["-C", ctx.holdout, "reset", "-q", "--hard", "HEAD~1"]);
    return false;
  }
  lintWriterChange(ctx, wctx, "judge");
  mergeHoldoutBranch(ctx, wctx, `holdout: fix tests flagged by the judge (${ctx.app.repo}#${ctx.issue})`, [
    `🤖 The judge found that these tests didn't check what ${ctx.target.file} says. The test writer fixed them against the spec (it never saw the implementation).`,
    "",
    findings,
  ].join("\n"));
  return true;
}

// A test fix broke tests that used to pass. Show the writer their errors (its own tests, so it may see them) and let it repair them
function repairTestRegression(ctx, ids) {
  log(`judge: the test fix broke ${ids.join(", ")}, which passed before. Sending them back to the test writer`);
  const review = baseRunReview(join(ctx.reportDir, "report.json"), ids);
  const branch = `holdout/judge-issue-${ctx.issue}-repair`;
  sh("git", ["-C", ctx.holdout, "checkout", "-q", "-B", branch]);
  const wctx = { ...ctx, workspace: ctx.holdout, appSrc: ctx.workspace, reportDir: join(ctx.reportRoot, "judge", "repair"), branch };
  mkdirSync(wctx.reportDir, { recursive: true });
  const findings = [
    "Your last change made these tests fail. They passed before it, and the app didn't change in between, so the change itself broke them",
    "(e.g. a helper or variable used outside the test that defines it, or a shared helper whose behavior changed). Their results now:",
    "",
    review.text,
  ].join("\n");
  runAgent(wctx, render("holdout-fix.md", { findings }), "judge", "holdout-writer");
  if (!commitHoldout(ctx.holdout, `holdout: repair tests broken by the judge fix (issue #${ctx.issue})`)) {
    log("judge: the test writer changed nothing in the repair");
    return false;
  }
  lintWriterChange(ctx, wctx, "judge");
  mergeHoldoutBranch(ctx, wctx, `holdout: repair tests broken by the judge fix (${ctx.app.repo}#${ctx.issue})`,
    `🤖 The previous test fix broke ${ids.join(", ")}, which passed before it. The test writer repaired them.`);
  return true;
}

// Spec findings: open a PR with the judge's corrected spec (a human merges it), and stop with the implementation as a draft
function proposeSpecChange(ctx, items, dir) {
  const problems = items.map((x) => `- **${x.id}**: ${x.specProblem}`).join("\n");
  let specUrl = "";
  const proposed = join(dir, "spec.md");
  if (existsSync(proposed)) {
    const branch = `spec/judge-issue-${ctx.issue}`;
    const sdir = join(ROOT, "work", ctx.app.name, `spec-judge-${ctx.issue}`);
    const sctx = { ...ctx, workspace: cloneFresh(ctx.app.repo, sdir, { branch }), branch };
    copyFileSync(proposed, join(sdir, ctx.target.file));
    sh("git", ["-C", sdir, "add", "--", ctx.target.file]);
    if (spawnSync("git", ["-C", sdir, "diff", "--cached", "--quiet"]).status !== 0) {
      sh("git", ["-C", sdir, "commit", "-q", "-m", `spec: correct ${ctx.target.file} (judge, issue #${ctx.issue})`]);
      specUrl = openPr(sctx, {
        force: true, draft: false,
        title: `spec: correct ${ctx.target.file} (#${ctx.issue})`,
        body: [
          `⚖️ While implementing #${ctx.issue}, the same acceptance tests kept failing, and the judge traced it to the spec:`,
          "",
          problems,
          "",
          `Review and merge this, then run \`blindforge resume ${ctx.app.name} ${ctx.issue}\`. It continues from the draft implementation, updates the tests for the changed rows, and re-scores.`,
        ].join("\n"),
      });
    }
    rmSync(sdir, { recursive: true, force: true });
  }
  const url = openPr(ctx, {
    force: true, draft: true,
    body: [
      "⚖️ Stopped: the judge found a problem in the spec, not in the code or the tests.",
      "",
      problems,
      "",
      specUrl ? `Spec fix: ${specUrl}` : "The judge didn't propose a spec file. Fix the spec by hand.",
      `After the spec is merged, run \`blindforge resume ${ctx.app.name} ${ctx.issue}\` to continue from this PR.`,
      "",
      `Closes #${ctx.issue}`,
    ].join("\n"),
  });
  log(`judge: spec problem. ${specUrl ? `Spec PR: ${specUrl}. ` : ""}Draft: ${url}`);
  return 1;
}

// After a spec fix: update the tests for what changed in the spec (the writer gets the diff only)
function updateTestsForSpecChange(ctx, diff) {
  const branch = `holdout/spec-update-issue-${ctx.issue}`;
  sh("git", ["-C", ctx.holdout, "checkout", "-q", "-B", branch]);
  const wctx = { ...ctx, workspace: ctx.holdout, appSrc: ctx.workspace, reportDir: join(ctx.reportRoot, "spec-update"), branch };
  mkdirSync(wctx.reportDir, { recursive: true });
  log(`${ctx.target.file} changed since the implementation started. Updating its tests`);
  runAgent(wctx, render("holdout-spec-update.md", { specFile: ctx.target.file, diff }), 0, "holdout-writer");
  if (!commitHoldout(ctx.holdout, `holdout: follow the corrected ${ctx.target.file} (issue #${ctx.issue})`)) {
    log("The test writer changed nothing for the spec update");
    return;
  }
  lintWriterChange(ctx, wctx, "spec update");
  mergeHoldoutBranch(ctx, wctx, `holdout: follow the corrected ${ctx.target.file} (${ctx.app.repo}#${ctx.issue})`,
    `🤖 ${ctx.target.file} was corrected after its tests were written. The test writer updated the tests for the changed rows.\n\n\`\`\`diff\n${diff}\n\`\`\``);
}

// Continue from the open draft PR of an issue: bring in the base branch (e.g. a corrected spec),
// update the tests if the spec changed, score the existing implementation, and keep fixing if needed
async function resume(appName, issue) {
  const app = loadApp(appName);
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) throw new Error("CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY is not set");
  const issueJson = JSON.parse(sh("gh", ["issue", "view", String(issue), "-R", app.repo, "--json", "title,body"]));
  const ctx = {
    app, issue, title: issueJson.title,
    project: `blindforge-${app.name}-${issue}`,
    branch: `blindforge/issue-${issue}`,
    workspace: join(ROOT, "work", app.name, `issue-${issue}`),
    reportRoot: join(ROOT, "reports", app.name, `issue-${issue}`, runIdNow()),
  };
  const pr = JSON.parse(sh("gh", ["pr", "list", "-R", app.repo, "--head", ctx.branch, "--state", "open", "--json", "url"]))[0];
  if (!pr) throw new Error(`No open PR for ${ctx.branch}. Run blindforge build to start from scratch`);
  log(`issue #${issue}: resuming from ${pr.url}`);

  cloneFresh(app.repo, ctx.workspace);
  const git = (...a) => sh("git", ["-C", ctx.workspace, ...a]);
  git("checkout", "-q", "-b", ctx.branch, `origin/${ctx.branch}`);
  const base = `origin/${app.baseBranch}`;
  const oldBase = git("merge-base", "HEAD", base);
  if (spawnSync("git", ["-C", ctx.workspace, "merge", "-q", "--no-edit", base]).status !== 0) {
    throw new Error(`Merging ${app.baseBranch} into ${ctx.branch} conflicts. Resolve it by hand, or run blindforge build to start over`);
  }
  ctx.baseSha = git("rev-parse", base);
  ctx.holdout = cloneFresh(app.holdoutRepo, join(ROOT, "work", app.name, `issue-${issue}-holdout`));

  const target = withSpec(app, issue, ctx.workspace, issueJson.body);
  ctx.target = target;
  ctx.reportDir = ctx.reportRoot;
  mkdirSync(ctx.reportDir, { recursive: true });

  const diff = git("diff", oldBase, base, "--", target.file);
  if (diff) updateTestsForSpecChange(ctx, diff);

  const listed = listHoldoutIds(ctx);
  const missing = target.ids.filter((id) => !listed.has(id));
  if (missing.length > 0) throw new Error(`Acceptance criteria in ${target.file} with no holdout test: ${missing.join(", ")}`);

  try {
    return await implementLoop(ctx, "", { scoreFirst: true });
  } catch (e) {
    if (e instanceof InfraError) log("Stopped on an infrastructure failure. Run blindforge resume again once things settle");
    throw e;
  }
}

function finish(ctx, passed, failures, { holdoutEmpty = false } = {}) {
  if (!passed) {
    const url = openPr(ctx, {
      force: true,
      draft: true,
      body: `🧯 Still failing after ${ctx.app.maxAttempts} attempts. Needs a human.\n\n${failures}\n\nCloses #${ctx.issue}`,
    });
    log(`Finished without passing. Draft PR: ${url}`);
    return 1;
  }

  const hits = exceptionHits(ctx);
  if (hits.length > 0) {
    const url = openPr(ctx, {
      force: true,
      draft: false,
      body: `🛑 Contains changes to exception paths, so no auto-merge. Needs human review and a manual merge.\n\n${hits.map((f) => `- \`${f}\``).join("\n")}\n\nCloses #${ctx.issue}`,
    });
    log(`Hit exception paths; waiting for approval: ${url}`);
    return 0;
  }

  if (holdoutEmpty) {
    const url = openPr(ctx, {
      force: true,
      draft: false,
      body: `⚠️ The gates passed, but the holdout had 0 scenarios (no acceptance tests ran). No auto-merge. A human should check the behavior and merge (\`blindforge preview ${ctx.app.name} <this PR number>\`).\n\nCloses #${ctx.issue}`,
    });
    log(`The holdout had 0 scenarios; waiting for a human to check: ${url}`);
    return 0;
  }

  const url = openPr(ctx, {
      force: true, draft: false, body: `✅ Passed the gates and the holdout.\n\nCloses #${ctx.issue}` });
  sh("gh", ["pr", "merge", url, "--squash", "--delete-branch"]);
  log(`Merged: ${url}`);
  return deploy(ctx.app.name);
}

// Have the AI draft a spec from an issue and open a PR. No implementation.
// A spec is a decision about what to build, so its PR is never auto-merged.
// Marker on the comments the factory writes on PRs. Human comments after the latest one count as "unaddressed"
const FACTORY_MARK = "<!-- blindforge -->";

// blindforge spec: switch between drafting and revising based on the state of the issue's spec PR
async function spec(appName, issue) {
  const app = loadApp(appName);
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) throw new Error("CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY is not set");
  const branch = `spec/issue-${issue}`;
  const prs = JSON.parse(sh("gh", ["pr", "list", "-R", app.repo, "--head", branch, "--state", "all",
    "--json", "number,url,state"]));
  const open = prs.find((p) => p.state === "OPEN");
  if (open) return specRevise(app, issue, open);
  const merged = prs.find((p) => p.state === "MERGED");
  if (merged) {
    throw new Error(`The spec for issue #${issue} was already merged in ${merged.url}. To change it, open a PR that edits the spec, or file a new issue`);
  }
  return specDraft(app, issue);
}

// Collect the PR's unaddressed comments (human comments after the factory's latest comment)
function unaddressedComments(app, pr) {
  const api = (path) => JSON.parse(sh("gh", ["api", "--paginate", `repos/${app.repo}/${path}`]));
  const conversation = api(`issues/${pr}/comments`).map((c) => ({ at: c.created_at, body: c.body, where: "comment", url: c.html_url }));
  const reviews = api(`pulls/${pr}/reviews`).filter((r) => r.body?.trim())
    .map((r) => ({ at: r.submitted_at, body: r.body, where: "review", url: r.html_url }));
  const inline = api(`pulls/${pr}/comments`)
    .map((c) => ({ at: c.created_at, body: c.body, where: `${c.path}:${c.line ?? c.original_line ?? "?"}`, url: c.html_url }));
  const all = [...conversation, ...reviews, ...inline].sort((a, b) => a.at.localeCompare(b.at));
  const lastFactory = all.filter((c) => c.body.includes(FACTORY_MARK)).map((c) => c.at).pop() ?? "";
  return all.filter((c) => !c.body.includes(FACTORY_MARK) && c.at > lastFactory);
}

// Revise the open spec PR per its unaddressed comments. Does nothing if there are none
async function specRevise(app, issue, pr) {
  const comments = unaddressedComments(app, pr.number);
  if (comments.length === 0) {
    log(`Spec PR ${pr.url} has no unaddressed comments, so doing nothing. To revise it, leave review comments on the PR and run again`);
    return 0;
  }
  const issueJson = JSON.parse(sh("gh", ["issue", "view", String(issue), "-R", app.repo, "--json", "title"]));
  const files = JSON.parse(sh("gh", ["pr", "view", String(pr.number), "-R", app.repo, "--json", "files"]))
    .files.map((f) => f.path).filter((f) => f.startsWith("specs/"));
  if (files.length !== 1) throw new Error(`Spec PR ${pr.url} does not have exactly one file under specs/: ${files.join(", ")}`);
  const specFile = files[0];

  const ctx = {
    app, issue, title: issueJson.title,
    project: `blindforge-${app.name}-spec-${issue}`,
    branch: `spec/issue-${issue}`,
    workspace: join(ROOT, "work", app.name, `spec-issue-${issue}`),
    reportDir: join(ROOT, "reports", app.name, `issue-${issue}`, `spec-revise-${runIdNow()}`),
  };
  mkdirSync(ctx.reportDir, { recursive: true });
  cloneFresh(app.repo, ctx.workspace);
  sh("git", ["-C", ctx.workspace, "checkout", "-q", ctx.branch]);
  log(`Revising ${specFile} per ${comments.length} unaddressed comment(s) on spec PR ${pr.url}`);

  const text = comments.map((c, i) => `${i + 1}. (${c.where})\n${c.body.trim().replace(/^/gm, "   ")}`).join("\n\n");
  const usedIds = usedIdsFor(app, issue, ctx.workspace, specFile);
  runAgent(ctx, render("spec-revise.md", { issue, title: issueJson.title, specFile, comments: text, usedIds: usedIds.join(", ") || "(none)" }), 1);

  // Commit only that spec file. Discard any other changes
  const git = (...a) => sh("git", ["-C", ctx.workspace, ...a]);
  git("reset", "-q", "--", ".");
  git("add", "--", specFile);
  git("checkout", "-q", "--", ".");
  const changed = spawnSync("git", ["-C", ctx.workspace, "diff", "--cached", "--quiet"]).status !== 0;
  const summary = readFileSync(join(ctx.reportDir, "agent.log"), "utf8").split("\n--- stderr ---")[0].trim();
  if (changed) {
    git("commit", "-q", "-m", `spec: issue #${issue} address review comments`);
    git("push", "-q", "origin", ctx.branch);
  }
  const collisions = idCollisions(join(ctx.workspace, specFile), usedIds);
  sh("gh", ["pr", "comment", String(pr.number), "-R", app.repo, "--body", [
    FACTORY_MARK,
    collisionWarning(collisions).trim(),
    changed ? `🏭 blindforge: addressed ${comments.length} review comment(s).` : `🏭 blindforge: reviewed ${comments.length} review comment(s) but did not change the spec.`,
    "",
    summary,
    "",
    "If anything else needs changing, leave review comments and run `blindforge spec` again. Otherwise, merge.",
  ].join("\n")]);
  rmSync(ctx.workspace, { recursive: true, force: true });
  log(changed ? `Revised and pushed the spec: ${pr.url}` : `Did not change the spec (commented on the PR): ${pr.url}`);
  return 0;
}

// Have the AI draft a spec from an issue and open a PR
async function specDraft(app, issue) {
  const issueJson = JSON.parse(sh("gh", ["issue", "view", String(issue), "-R", app.repo, "--json", "title,body"]));
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const ctx = {
    app, issue, title: issueJson.title,
    project: `blindforge-${app.name}-spec-${issue}`,
    branch: `spec/issue-${issue}`,
    workspace: join(ROOT, "work", app.name, `spec-issue-${issue}`),
    reportDir: join(ROOT, "reports", app.name, `issue-${issue}`, `spec-${runId}`),
  };

  log(`issue #${issue}: drafting the spec for ${ctx.title}`);
  rmSync(ctx.workspace, { recursive: true, force: true });
  mkdirSync(dirname(ctx.workspace), { recursive: true });
  mkdirSync(ctx.reportDir, { recursive: true });
  sh("gh", ["repo", "clone", app.repo, ctx.workspace, "--", "-q"]);
  sh("git", ["-C", ctx.workspace, "checkout", "-q", "-b", ctx.branch]);
  sh("git", ["-C", ctx.workspace, "config", "user.name", "blindforge"]);
  sh("git", ["-C", ctx.workspace, "config", "user.email", "blindforge@localhost"]);

  const usedIds = usedIdsFor(app, issue, ctx.workspace);
  runAgent(ctx, render("spec.md", { issue, title: issueJson.title, body: issueJson.body, usedIds: usedIds.join(", ") || "(none)" }), 1);

  // Commit only new files under specs/. Discard any other changes
  const git = (...a) => sh("git", ["-C", ctx.workspace, ...a]);
  const changed = git("status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean);
  const added = changed.filter((l) => l.startsWith("?? specs/")).map((l) => l.slice(3));
  const ignored = changed.filter((l) => !l.startsWith("?? specs/"));
  if (ignored.length > 0) log(`Discarded changes other than new files under specs/:\n${ignored.join("\n")}`);
  if (added.length === 0) {
    log(`No spec was written. Log: ${ctx.reportDir}/agent.log`);
    return 1;
  }
  git("add", "--", ...added);
  git("commit", "-q", "-m", `spec: issue #${issue} ${ctx.title}`);
  const collisions = added.flatMap((f) => idCollisions(join(ctx.workspace, f), usedIds));
  if (collisions.length) log(`Acceptance criteria IDs collide with existing holdout tests: ${collisions.join(", ")}`);

  const summary = readFileSync(join(ctx.reportDir, "agent.log"), "utf8").split("\n--- stderr ---")[0].trim();
  const url = openPr(ctx, {
    draft: false,
    force: true, // Overwrite the branch even if a previous spec PR that was closed (not merged) left it behind
    title: `spec: ${ctx.title}`,
    body: [
      collisionWarning(collisions) + "📝 Spec draft written by the AI from the issue. **Not auto-merged.**",
      "",
      "1. Review the content, the **acceptance criteria** (what counts as done), and the open questions. Leave comments on the PR for anything to change, then run `blindforge spec` again and blindforge will revise it",
      `2. Once merged, run \`blindforge build ${app.name} ${issue}\` (writes the holdout from the acceptance criteria, then implements)`,
      "",
      `Refs #${issue}`,
      "",
      "<details><summary>Agent summary</summary>",
      "",
      summary,
      "",
      "</details>",
    ].join("\n"),
  });
  rmSync(ctx.workspace, { recursive: true, force: true });
  log(`Opened the spec PR: ${url}`);
  return 0;
}

// Have the AI write the holdout from the spec's acceptance criteria. No human review; instead, mechanical checks:
//   1. Every acceptance criteria ID has a test
//   2. Running against the unimplemented app (main), the test harness itself works (a report comes out, no HARNESS error)
// If they pass, merge into the holdout repo.
async function holdout(appName, issue) {
  const app = loadApp(appName);
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) throw new Error("CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY is not set");

  const issueJson = JSON.parse(sh("gh", ["issue", "view", String(issue), "-R", app.repo, "--json", "title,body"]));
  const base = join(ROOT, "work", app.name, `holdout-issue-${issue}`);
  const ctx = {
    app, issue, title: issueJson.title,
    project: `blindforge-${app.name}-holdout-${issue}`,
    branch: `holdout/issue-${issue}`,
    reportRoot: join(ROOT, "reports", app.name, `issue-${issue}`, `holdout-${runIdNow()}`),
  };
  ctx.appSrc = cloneFresh(app.repo, join(base, "app"));
  ctx.holdout = cloneFresh(app.holdoutRepo, join(base, "holdout"), { branch: ctx.branch });
  ctx.workspace = ctx.holdout;

  const target = withSpec(app, issue, ctx.appSrc, issueJson.body);
  ctx.reportDir = ctx.reportRoot;
  mkdirSync(ctx.reportDir, { recursive: true });
  const already = listHoldoutIds(ctx);
  if (target.ids.every((id) => already.has(id))) {
    log(`${target.file}: tests for all acceptance criteria already exist (${target.ids.length}). Nothing to do`);
    rmSync(base, { recursive: true, force: true });
    return 0;
  }
  log(`${target.file}: writing tests for acceptance criteria ${target.ids.join(", ")}`);

  let prompt = render("holdout.md", { specFile: target.file, ids: target.ids.join(", ") });
  let reviewed = false;
  for (let attempt = 1; attempt <= app.maxAttempts; attempt++) {
    ctx.reportDir = join(ctx.reportRoot, `attempt-${attempt}`);
    mkdirSync(ctx.reportDir, { recursive: true });
    runAgent(ctx, prompt, attempt, "holdout-writer");

    // Discard changes outside tests/ and scenarios/ (don't let it rewrite summarize.mjs or the config)
    const git = (...a) => sh("git", ["-C", ctx.holdout, ...a]);
    git("reset", "-q", "--", ".");                     // unstage whatever the AI put in the index
    git("add", "-A", "--", "tests", "scenarios");      // stage only tests/ and scenarios/
    git("checkout", "-q", "--", ".");                  // revert changes to any other tracked files
    const staged = spawnSync("git", ["-C", ctx.holdout, "diff", "--cached", "--quiet"]).status !== 0;
    if (staged) git("commit", "-q", "-m", `holdout: issue #${issue} attempt ${attempt}`);

    // 1. Does every ID have a test?
    const listed = listHoldoutIds(ctx);
    const missing = target.ids.filter((id) => !listed.has(id));
    if (missing.length > 0) {
      log(`attempt ${attempt}: IDs without tests: ${missing.join(", ")}`);
      prompt = `These acceptance criteria IDs still have no tests (the test names may not follow the "<ID> description" form): ${missing.join(", ")}\nAdd them, and check with \`npx playwright test --list\` before finishing.`;
      continue;
    }

    // Lint (if the holdout repo has it): rules that catch flaky patterns, such as fixed sleeps and reads that don't wait
    const lint = lintHoldout(ctx);
    if (!lint.ok) {
      log(`attempt ${attempt}: the tests fail lint`);
      writeFileSync(join(ctx.reportDir, "lint.log"), lint.output);
      prompt = lintPrompt(lint.output);
      continue;
    }

    // 2. Run against the unimplemented app: does the test harness work?
    // Against the unimplemented app, every new test fails. With production's timeout (30 s) and retries,
    // that takes (number of tests) × 60 s and blows the holdout time limit. We only want to see that the harness works, so keep it short
    const withApp = {
      ...ctx, workspace: ctx.appSrc,
      extraEnv: { ...ctx.extraEnv, HOLDOUT_ARGS: "--retries=0 --timeout=10000" },
    };
    const { summary } = runHoldout(withApp, { grep: idGrep(target.ids), label: `${target.ids.length} new tests against the unimplemented app` });
    writeFileSync(join(ctx.reportDir, "base-run.json"), JSON.stringify(summary));
    const harness = summary.find((x) => x.id === "HARNESS");
    if (harness) {
      log(`attempt ${attempt}: the test run itself failed (HARNESS). Report: ${ctx.reportDir}`);
      prompt = "Running the tests failed at the harness level, before any individual scenario passed or failed (syntax error, bad import, bad config, etc.). Check `npx playwright test --list`, review the types and imports, and fix it.";
      continue;
    }

    // 3. One review round: show the writer how each test behaved against the unimplemented app,
    // so it can tell "fails because the feature is missing" from "fails because the test is wrong".
    // (The writer never reaches the app itself; that stays the holdout's job.)
    if (!reviewed && attempt < app.maxAttempts) {
      reviewed = true;
      const review = baseRunReview(join(ctx.reportDir, "report.json"), target.ids);
      writeFileSync(join(ctx.reportDir, "review.md"), review.text);
      log(`attempt ${attempt}: reviewing results against the unimplemented app (${review.failed} failing, ${review.passed} passing already)`);
      prompt = render("holdout-review.md", { results: review.text });
      continue;
    }

    const rows = target.ids.map((id) => {
      const r = summary.find((x) => x.id === id);
      return `| ${id} | ${r ? r.status : "(@prod: runs only in production)"} |`;
    });
    const url = openPr(ctx, {
      draft: false,
      force: true,
      repo: app.holdoutRepo,
      title: `holdout: ${issueJson.title}`,
      body: [
        `🤖 Tests written by blindforge from the acceptance criteria in ${target.file} (${app.repo}#${issue}). Not reviewed by a human.`,
        "",
        "## Mechanical checks",
        `- ✅ Every acceptance criteria ID has a test (${target.ids.length})`,
        "- ✅ The test harness works when run against the unimplemented app (main)",
        reviewed ? "- ✅ The writer reviewed why each test fails (or passes) against the unimplemented app" : "- ⚠️ No review round (out of attempts)",
        "",
        "## Results against the unimplemented app (for reference; failing is correct for now)",
        "",
        "| ID | Result |",
        "|---|---|",
        ...rows,
      ].join("\n"),
    });
    sh("gh", ["pr", "merge", url, "--squash", "--delete-branch"]);
    rmSync(base, { recursive: true, force: true });
    log(`Merged the holdout: ${url}`);
    return 0;
  }
  log(`The holdout checks did not pass in ${app.maxAttempts} attempts. Not pushing the branch. Reports: ${ctx.reportRoot}`);
  return 1;
}

// When stopping because no spec was found, explain on the issue what's missing (keeps the rules visible on GitHub)
function withSpec(app, issue, appDir, issueBody) {
  try {
    return findSpec(appDir, issue, issueBody);
  } catch (e) {
    if (e instanceof SpecNotFound) {
      sh("gh", ["issue", "comment", String(issue), "-R", app.repo, "--body", [
        "🏭 blindforge: stopped because no spec was found for this issue.",
        "",
        `> ${e.message}`,
        "",
        "- For a **new feature**, draft a spec with `blindforge spec`, merge the spec PR, then run `blindforge build`",
        "- For a **bug fix or other change within an existing spec**, add a `spec: specs/<file>.md` line to the body (or fill in the \"Related spec\" field of the bug form). The fix is then accepted by that spec's acceptance tests",
        "- If the spec has no acceptance criteria table, add one in a spec PR",
      ].join("\n")]);
      log(`Commented on issue #${issue} that no spec was found`);
    }
    throw e;
  }
}

// ---- Deploy ----
// The factory only tags the head of main and creates a Release. The production deploy is done by the app's
// GitHub Actions, triggered by the Release, following a fixed procedure (only they hold production credentials).
// The Release is created with gh (a human's token), so it triggers the Actions workflows.
const TAG_PREFIX = "deploy-";

async function deploy(appName) {
  const app = loadApp(appName);
  const base = app.baseBranch ?? "main";
  setStatus({ stage: "Release" });
  const sha = sh("gh", ["api", `repos/${app.repo}/commits/${base}`, "-q", ".sha"]);

  // If this commit already has a Release, don't create another (no double deploys)
  const tags = sh("gh", ["api", "--paginate", `repos/${app.repo}/git/matching-refs/tags/${TAG_PREFIX}`,
    "--jq", '.[] | [(.ref | sub("^refs/tags/"; "")), .object.sha] | @tsv'])
    .split("\n").filter(Boolean).map((l) => { const [name, tagSha] = l.split("\t"); return { name, sha: tagSha }; });
  const existing = tags.find((t) => t.sha === sha);
  if (existing) {
    log(`${app.repo}@${sha.slice(0, 7)} is already released (${existing.name}). Nothing to do`);
    return 0;
  }

  // Tags are deploy-YYYYMMDD-N (a per-day sequence number)
  const d = new Date();
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const n = tags.filter((t) => t.name.startsWith(`${TAG_PREFIX}${day}-`)).length + 1;
  const tag = `${TAG_PREFIX}${day}-${n}`;

  const url = sh("gh", ["release", "create", tag, "-R", app.repo, "--target", sha, "--title", tag, "--generate-notes"]);
  log(`Created Release: ${url} (${app.repo}@${sha.slice(0, 7)}). The app's GitHub Actions handle the deploy`);
  return 0;
}

async function build(appName, issue) {
  try {
    const code = await holdout(appName, issue);
    if (code !== 0) return code;
    return await run(appName, issue);
  } finally {
    // The working clones (about 700 MB each including node_modules) are recreated on the next run, so remove them when done.
    // Leaving them fills the Mac's disk, Docker goes read-only, and builds stop
    const app = loadApp(appName);
    for (const name of [`issue-${issue}`, `issue-${issue}-holdout`, `holdout-issue-${issue}`]) {
      rmSync(join(ROOT, "work", app.name, name), { recursive: true, force: true });
    }
  }
}

// Start a PR (by number) or branch in the same container as app and expose it at http://localhost:<port>.
// This avoids running AI-written code directly on the Mac. The DB goes away with the container.
async function preview(appName, ref) {
  const app = loadApp(appName);
  const isPr = /^\d+$/.test(ref);
  const id = isPr ? `pr-${ref}` : ref.replace(/[^A-Za-z0-9_.-]/g, "-");
  const port = process.env.PREVIEW_PORT ?? "8787";
  const ctx = {
    app,
    project: `blindforge-${app.name}-preview-${id}`.toLowerCase(),
    workspace: join(ROOT, "work", app.name, `preview-${id}`),
    reportDir: join(ROOT, "reports", app.name, `preview-${id}`),
  };

  rmSync(ctx.workspace, { recursive: true, force: true });
  mkdirSync(dirname(ctx.workspace), { recursive: true });
  mkdirSync(ctx.reportDir, { recursive: true });
  sh("gh", ["repo", "clone", app.repo, ctx.workspace, "--", "-q"]);
  if (isPr) {
    sh("git", ["-C", ctx.workspace, "fetch", "-q", "origin", `pull/${ref}/head:preview`]);
    sh("git", ["-C", ctx.workspace, "checkout", "-q", "preview"]);
  } else {
    sh("git", ["-C", ctx.workspace, "checkout", "-q", ref]);
  }
  const head = sh("git", ["-C", ctx.workspace, "log", "-1", "--format=%h %s"]);

  log(`Starting ${isPr ? `PR #${ref}` : ref} (${head})… (the first run takes a few minutes)`);
  // Ctrl+C only stops following the container logs, then proceeds to cleanup
  process.on("SIGINT", () => {});
  try {
    const up = compose(ctx, ["--profile", "preview", "up", "-d", "--build", "--wait", "preview"]);
    if (up.status !== 0) throw new Error("Failed to start. Check `docker compose logs`");
    log(`Started: http://localhost:${port}  (Ctrl+C to stop)`);
    log("Get login codes from the TEST_MODE test endpoint (no email is sent)");
    compose(ctx, ["--profile", "preview", "logs", "-f", "--no-log-prefix", "preview"]);
  } finally {
    log("Stopping and cleaning up…");
    compose(ctx, ["--profile", "preview", "down"], { capture: true });
    rmSync(ctx.workspace, { recursive: true, force: true });
  }
  return 0;
}

const usage = `usage:
  blindforge status [--once]
  blindforge spec <app> <issue>
  blindforge holdout <app> <issue>
  blindforge run <app> <issue>
  blindforge build <app> <issue>
  blindforge resume <app> <issue>        continue from the issue's open draft PR (e.g. after a spec fix)
  blindforge deploy <app>
  blindforge regress <app>                run every hidden test against the base branch; failures go into one issue
  blindforge preview <app> <pr-number|branch>   (set the port with PREVIEW_PORT, default 8787)`;

const [cmd, ...rest] = process.argv.slice(2);
const commands = {
  spec: (a, issue) => spec(a, Number(issue)),
  holdout: (a, issue) => holdout(a, Number(issue)),
  run: (a, issue) => run(a, Number(issue)),
  build: (a, issue) => build(a, Number(issue)),
  resume: (a, issue) => resume(a, Number(issue)),
  deploy: (a) => deploy(a),
  regress: (a) => regress(a),
  preview: (a, ref) => preview(a, ref),
};
if (cmd === "status") {
  const { statusTui } = await import("./status.mjs");
  await statusTui(ROOT, { once: rest.includes("--once") });
} else if (commands[cmd] && rest.length === (cmd === "deploy" || cmd === "regress" ? 1 : 2)) {
  if (cmd !== "preview") startStatus(cmd, loadApp(rest[0]), rest[1] ?? "main");
  commands[cmd](...rest).then(
    (code) => {
      setStatus({ stage: "done", result: code === 0 ? "ok" : "failed", finishedAt: new Date().toISOString() });
      process.exit(code);
    },
    (e) => {
      console.error(e.message);
      log(`Error: ${e.message}`);
      setStatus({ stage: "done", result: "error", finishedAt: new Date().toISOString() });
      process.exit(1);
    },
  );
} else {
  console.error(usage);
  process.exit(2);
}
