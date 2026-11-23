// Holdout progress for `blindforge status`: reads <reportDir>/progress.jsonl
// (written by compose.yaml's holdout command and reporter/progress-reporter.cjs) and renders it.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};

const FAILED = new Set(["failed", "timedOut", "interrupted"]);
const idOf = (title) => title.split(/\s+/)[0];

const cache = new Map(); // file -> { mtimeMs, size, summary }

// Returns null when the file doesn't exist yet (the app is still installing / building / starting)
export function readProgress(reportDir) {
  const file = reportDir && join(reportDir, "progress.jsonl");
  if (!file || !existsSync(file)) return null;
  const st = statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.summary;
  const summary = summarize(readFileSync(file, "utf8"));
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, summary });
  return summary;
}

export function summarize(text) {
  const s = {
    phase: "install", total: 0, workers: 0, startedAt: null, endedAt: null,
    passed: 0, flaky: 0, failed: 0, skipped: 0, retrying: 0,
    running: new Map(), failures: [], durations: [],
  };
  for (const line of text.split("\n")) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.e === "install" || e.e === "run") s.phase = e.e;
    else if (e.e === "begin") Object.assign(s, { phase: "tests", total: e.total, workers: e.workers, startedAt: e.at });
    else if (e.e === "testBegin") s.running.set(`${e.title}#${e.retry}`, { title: e.title, retry: e.retry, at: e.at });
    else if (e.e === "testEnd") {
      s.running.delete(`${e.title}#${e.retry}`);
      if (!e.settled) { s.retrying += 1; continue; }
      s.durations.push(e.duration);
      if (e.status === "skipped") s.skipped += 1;
      else if (e.status === "passed") e.retry > 0 ? (s.flaky += 1) : (s.passed += 1);
      else if (FAILED.has(e.status)) { s.failed += 1; s.failures.push(e.title); }
    } else if (e.e === "end") Object.assign(s, { phase: "end", endedAt: e.at });
  }
  return s;
}

const fmt = (ms) => {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s` : `${sec}s`;
};

function bar(s, width) {
  // Round the cumulative boundaries, not each segment, so the bar is always exactly `width` cells
  const at = (n) => (s.total ? Math.round((Math.min(n, s.total) / s.total) * width) : 0);
  const a = at(s.passed + s.skipped), b = at(s.passed + s.skipped + s.flaky), d = at(s.passed + s.skipped + s.flaky + s.failed);
  const g = a, y = b - a, r = d - b, rest = width - d;
  return `${c.green}${"#".repeat(g)}${c.yellow}${"#".repeat(y)}${c.red}${"#".repeat(r)}${c.dim}${"-".repeat(rest)}${c.reset}`;
}

// Lines for the details pane. appStatus is the app container's `docker ps` status, if it's up
export function renderProgress(s, { appStatus, now = Date.now(), maxLines = 8 } = {}) {
  const out = [`  ${c.bold}Holdout progress${c.reset}`];
  if (!s) {
    const why = !appStatus ? "starting containers"
      : /health: starting/.test(appStatus) ? "waiting for the app (install, build, start)"
      : /unhealthy/.test(appStatus) ? `${c.red}the app is unhealthy${c.reset}` : "waiting for the app";
    out.push(`    ${c.dim}1/3${c.reset} ${why}`);
    return out;
  }
  if (s.phase === "install") return [...out, `    ${c.dim}2/3${c.reset} installing test dependencies`];
  if (s.phase === "run") return [...out, `    ${c.dim}3/3${c.reset} starting Playwright`];

  const settled = s.passed + s.flaky + s.failed + s.skipped;
  const elapsed = (s.endedAt ?? now) - s.startedAt;
  const pct = s.total ? Math.floor((settled / s.total) * 100) : 100;
  const eta = s.phase === "end" ? "finished" : settled ? `~${fmt((elapsed / settled) * (s.total - settled))} left` : "estimating…";
  out.push(`    ${bar(s, 30)} ${c.bold}${settled}/${s.total}${c.reset} ${pct}%  ${c.dim}${fmt(elapsed)} elapsed, ${eta}${c.reset}`);
  out.push(`    ${c.green}✓ ${s.passed}${c.reset}  ${c.yellow}~ ${s.flaky} flaky${c.reset}  ${c.red}✗ ${s.failed}${c.reset}` +
    `  ${c.dim}- ${s.skipped} skipped  ↻ ${s.retrying} retried  ${s.workers} workers${c.reset}`);
  const budget = Math.max(0, maxLines - 3);
  const running = [...s.running.values()].sort((a, b) => a.at - b.at);
  if (running.length && budget) {
    out.push(`    ${c.cyan}running${c.reset}  ` + running.slice(0, 6)
      .map((t) => `${idOf(t.title)}${t.retry ? `${c.yellow}(retry ${t.retry})${c.reset}` : ""} ${c.dim}${fmt(now - t.at)}${c.reset}`)
      .join("  "));
  }
  for (const title of s.failures.slice(-(budget - (running.length ? 1 : 0)))) {
    out.push(`    ${c.red}✗${c.reset} ${title}`);
  }
  return out;
}

// A compact label for the runs list, e.g. "holdout 34/120"
export function progressLabel(s) {
  if (!s) return "holdout (app)";
  if (s.phase !== "tests" && s.phase !== "end") return "holdout (setup)";
  const settled = s.passed + s.flaky + s.failed + s.skipped;
  return `holdout ${settled}/${s.total}${s.failed ? ` ✗${s.failed}` : ""}`;
}
