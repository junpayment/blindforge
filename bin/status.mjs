// blindforge status: a TUI showing what the factory is doing (no dependencies)
//
// Every second it reads
// - state/*.json (the status of each run, written by blindforge.mjs)
// - docker's blindforge-* projects (the containers running now) and docker stats traffic (bin/network.mjs)
// - the tail of the running AI's stream-json log (agent.jsonl)
// and redraws every 0.125 seconds to animate the traffic arrows.
//
//   ↑↓ / j k : select   enter : show / hide details   q / Ctrl+C : quit

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { listApps, NetMonitor, renderNetwork } from "./network.mjs";
import { progressLabel, readProgress, renderProgress } from "./holdout-progress.mjs";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", inverse: "\x1b[7m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m", cyan: "\x1b[36m",
};
// Count wide (non-Latin-1) characters as 2 columns
const width = (s) => [...s.replace(/\x1b\[[0-9;]*m/g, "")].reduce((n, ch) => n + (/[^\x00-\xff]/.test(ch) ? 2 : 1), 0);
const pad = (s, n) => s + " ".repeat(Math.max(0, n - width(s)));
const truncate = (s, n) => {
  let out = "";
  for (const ch of s) {
    if (width(out + ch) > n - 1) return `${out}…`;
    out += ch;
  }
  return out;
};

const duration = (from, to = Date.now()) => {
  const sec = Math.max(0, Math.floor((to - new Date(from).getTime()) / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(s).padStart(2, "0")}s`;
};
const clock = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour12: false });

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function readRuns(root) {
  const dir = join(root, "state");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
        s.running = !s.result && alive(s.pid);
        if (!s.result && !s.running) s.result = "interrupted";
        return s;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.running === b.running ? b.startedAt.localeCompare(a.startedAt) : a.running ? -1 : 1));
}

function readContainers() {
  const res = spawnSync(
    "docker",
    ["ps", "--filter", "label=com.docker.compose.project", "--format",
      '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.Status}}\t{{.Names}}'],
    { encoding: "utf8" },
  );
  if (res.status !== 0) return null;
  return res.stdout.split("\n").filter(Boolean)
    .map((l) => { const [project, service, status, name] = l.split("\t"); return { project, service, status, name }; })
    .filter((x) => x.project.startsWith("blindforge-"));
}

// Pull what the AI did recently from the tail of agent.jsonl
function agentActivity(reportDir, limit) {
  const file = reportDir && join(reportDir, "agent.jsonl");
  if (!file || !existsSync(file)) return [];
  const size = statSync(file).size;
  const text = readFileSync(file, "utf8").slice(Math.max(0, size - 200_000));
  const items = [];
  for (const line of text.split("\n")) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "assistant") continue;
    for (const part of e.message?.content ?? []) {
      if (part.type === "tool_use") {
        const i = part.input ?? {};
        const arg = i.file_path ?? i.command ?? i.pattern ?? i.path ?? i.url ?? "";
        items.push(`${c.cyan}${part.name}${c.reset} ${String(arg).replace(/\s+/g, " ")}`);
      } else if (part.type === "text" && part.text.trim()) {
        items.push(`${c.dim}${part.text.trim().replace(/\s+/g, " ")}${c.reset}`);
      }
    }
  }
  return items.slice(-limit);
}

const resultLabel = (r) =>
  r.running ? `${c.yellow}● running${c.reset}`
  : r.result === "ok" ? `${c.green}✓ done${c.reset}`
  : r.result === "failed" ? `${c.red}✗ failed${c.reset}`
  : r.result === "error" ? `${c.red}✗ error${c.reset}`
  : `${c.dim}– interrupted${c.reset}`;

// Load the state (files and docker ps). Called less often than the redraw (animation)
function collect(root) {
  return { runs: readRuns(root), containers: readContainers(), apps: listApps(root) };
}

function render(root, state, data, { monitor, frame = 0, animate = true } = {}) {
  const cols = process.stdout.columns || 100;
  const rows = process.stdout.rows || 30;
  const { runs, containers, apps } = data;
  state.selected = Math.min(state.selected, Math.max(0, runs.length - 1));
  const out = [];
  const line = (s = "") => out.push(truncate(s, cols + 20));

  line(`${c.bold}blindforge${c.reset}  ${c.dim}${new Date().toLocaleString("en-US", { hour12: false })}${c.reset}` +
    `${" ".repeat(Math.max(1, cols - 68))}${c.dim}↑↓ select  enter details  q quit${c.reset}`);
  line();

  // The list of runs
  line(`${c.bold}Runs${c.reset}`);
  if (runs.length === 0) line(`  ${c.dim}(no runs yet)${c.reset}`);
  const listRows = Math.max(3, Math.min(runs.length, state.detail ? 8 : rows - 12));
  const start = Math.max(0, Math.min(state.selected - Math.floor(listRows / 2), runs.length - listRows));
  for (const [i, r] of runs.slice(start, start + listRows).entries()) {
    const idx = start + i;
    const attempt = r.attempt ? `${r.attempt}/${r.maxAttempts}` : "";
    const row = [
      pad(resultLabel(r), 14),
      pad(`${r.app} #${r.target}`, 14),
      pad(r.command, 8),
      pad(r.running ? (r.stage === "holdout" ? progressLabel(readProgress(r.reportDir)) : r.stage) : (r.pr ? r.pr.replace(/.*\/pull\//, "PR #") : r.stage), 18),
      pad(attempt, 4),
      pad(duration(r.startedAt, r.finishedAt ? new Date(r.finishedAt).getTime() : r.running ? Date.now() : new Date(r.updatedAt).getTime()), 8),
      `${c.dim}${clock(r.startedAt)}${c.reset}`,
    ].join(" ");
    line(idx === state.selected ? `${c.inverse}▶ ${row}${c.reset}` : `  ${row}`);
  }
  line();

  // Containers and traffic (per issue; arrows point from the side that connects to the side that answers, » moves while data flows)
  line(`${c.bold}Containers and traffic${c.reset}`);
  if (containers === null) line(`  ${c.red}can't connect to docker${c.reset}`);
  else if (containers.length === 0) line(`  ${c.dim}(nothing running)${c.reset}`);
  else for (const l of renderNetwork(containers, { apps, monitor, frame, animate, width, pad })) line(l);

  // Details
  const r = runs[state.selected];
  if (state.detail && r) {
    line();
    line(`${c.bold}Details${c.reset}  ${r.app} #${r.target} ${r.command}  ${c.dim}${r.file ?? ""}${c.reset}`);
    if (r.pr) line(`  PR: ${c.blue}${r.pr}${c.reset}`);
    if (r.reportDir) line(`  Report: ${c.dim}${r.reportDir}${c.reset}`);
    if (r.running && r.stage === "holdout") {
      // The app container of this run (project blindforge-<app>-[holdout-]<target>)
      const app = (containers ?? []).find((x) => x.service === "app" &&
        x.project.startsWith(`blindforge-${r.app}-`) && x.project.endsWith(`-${r.target}`));
      for (const l of renderProgress(readProgress(r.reportDir), { appStatus: app?.status, maxLines: Math.max(4, Math.floor((rows - out.length) / 2)) })) line(l);
    }
    const remaining = rows - out.length - 2;
    const activity = r.running && r.stage === "AI working" ? agentActivity(r.reportDir, Math.floor(remaining / 2)) : [];
    const events = r.events.slice(-Math.max(1, remaining - activity.length - (activity.length ? 2 : 1)));
    line(`  ${c.bold}Events${c.reset}`);
    for (const e of events) line(`  ${c.dim}${clock(e.at)}${c.reset} ${e.msg.replace(/\x1b\[[0-9;]*m/g, "").split("\n")[0]}`);
    if (activity.length) {
      line(`  ${c.bold}Recent AI activity${c.reset}`);
      for (const a of activity) line(`    ${a}`);
    }
  }
  return out;
}

export async function statusTui(root, { once = false } = {}) {
  const state = { selected: 0, detail: true };

  if (once || !process.stdout.isTTY) {
    const monitor = new NetMonitor().snapshot();
    console.log(render(root, state, collect(root), { monitor, animate: false }).join("\n"));
    return;
  }

  const monitor = new NetMonitor().start();
  let data = collect(root);
  let frame = 0;
  const draw = () => {
    const lines = render(root, state, data, { monitor, frame });
    // Clearing the whole screen flickers, so move the cursor to the top left, overwrite, and clear the rest of each line and below
    process.stdout.write(`\x1b[H${lines.map((l) => `${l}${c.reset}\x1b[K`).join("\n")}\x1b[J`);
  };
  const quit = () => {
    clearInterval(timer);
    clearInterval(refresh);
    monitor.stop();
    process.stdin.setRawMode(false);
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    process.exit(0);
  };

  process.stdout.write("\x1b[?1049h\x1b[?25l"); // alternate screen, hide cursor
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (key) => {
    if (key === "q" || key === "\x03") return quit();
    if (key === "\x1b[A" || key === "k") state.selected = Math.max(0, state.selected - 1);
    if (key === "\x1b[B" || key === "j") state.selected += 1;
    if (key === "\r") state.detail = !state.detail;
    draw();
  });
  process.stdout.on("resize", draw);
  const refresh = setInterval(() => { data = collect(root); }, 1000);
  const timer = setInterval(() => { frame += 1; draw(); }, 125);
  draw();
  await new Promise(() => {});
}
