// "Containers and traffic" in blindforge status: for each issue, draws the running containers and their traffic as arrows
//
// - Which pairs talk (who connects to whom) is fixed by compose.yaml, so it's kept here as a table
// - Whether data is actually flowing comes from the growth of NetIO (bytes received / sent) in `docker stats`
//   - holdout shares app's network (network_mode: service:app), so the tests run over localhost.
//     That traffic doesn't show up in the byte counts, so it counts as flowing while holdout is up and app is healthy
// - Arrows point from the side that connects to the side that answers. While data flows, » moves along the arrow

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
  gray: "\x1b[90m", brightCyan: "\x1b[96m", brightYellow: "\x1b[93m",
};

// Color per service, by role: AI in magenta, tests in yellow, the app in green, gates in blue, outside hosts in gray
const SERVICE_COLOR = {
  agent: c.magenta,
  "holdout-writer": c.magenta,
  gates: c.blue,
  app: c.green,
  preview: c.green,
  holdout: c.yellow,
};
const EXTERNAL = {
  net: { name: "internet", color: c.gray },
  mac: { name: "browser", color: c.cyan },
};

// Who talks to whom (keep in sync with compose.yaml). Omitting from means the service itself; same for to
const EDGES = {
  agent: [{ to: "net", label: "Claude API/npm" }],
  "holdout-writer": [{ to: "net", label: "Claude API/npm" }],
  gates: [{ to: "net", label: "npm" }],
  app: [{ to: "net", label: "npm" }],
  holdout: [{ to: "app", label: "test", loopback: true }, { to: "net", label: "npm" }],
  preview: [{ from: "mac", label: "http" }, { to: "net", label: "npm" }],
};

const KIND = { spec: "spec", holdout: "holdout", preview: "preview" };

// Split blindforge-<app>-[spec-|holdout-|preview-]<target> into its parts
export function parseProject(project, apps) {
  const rest0 = project.replace(/^blindforge-/, "");
  const app = apps.filter((a) => rest0.startsWith(`${a}-`)).sort((a, b) => b.length - a.length)[0];
  if (!app) return { app: rest0, kind: "", target: "" };
  const rest = rest0.slice(app.length + 1);
  const m = rest.match(/^(spec|holdout|preview)-(.+)$/);
  return m ? { app, kind: KIND[m[1]], target: m[2] } : { app, kind: "build", target: rest };
}

export function listApps(root) {
  const dir = join(root, "apps");
  return existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => f.replace(/\.ya?ml$/, "")) : [];
}

// "7.36MB" → bytes (docker stats NetIO uses decimal units)
export function parseBytes(s) {
  const m = String(s).trim().match(/^([\d.]+)\s*([kKMGT]?i?B)$/);
  if (!m) return 0;
  const unit = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 }[m[2]] ?? 1;
  return Number(m[1]) * unit;
}

export function formatRate(bps) {
  if (bps < 1e3) return `${Math.round(bps)}B/s`;
  if (bps < 1e6) return `${(bps / 1e3).toFixed(bps < 1e4 ? 1 : 0)}kB/s`;
  return `${(bps / 1e6).toFixed(bps < 1e7 ? 1 : 0)}MB/s`;
}

// Keep docker stats streaming and track the receive / send rate for each container name
export class NetMonitor {
  constructor() {
    this.samples = new Map(); // name -> { rx, tx, at, rxRate, txRate }
    this.buf = "";
    this.proc = null;
  }

  start() {
    this.proc = spawn("docker", ["stats", "--format", "{{json .}}"], { stdio: ["ignore", "pipe", "ignore"] });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d) => {
      this.buf += d;
      let last = 0;
      for (const m of this.buf.matchAll(/\{[^{}]*\}/g)) {
        last = m.index + m[0].length;
        try { this.add(JSON.parse(m[0])); } catch { /* skip partial lines */ }
      }
      this.buf = this.buf.slice(last);
    });
    this.proc.on("error", () => { this.proc = null; });
    return this;
  }

  // Read once (for --once). Rates aren't available, so only totals
  snapshot() {
    const res = spawnSync("docker", ["stats", "--no-stream", "--format", "{{json .}}"], { encoding: "utf8", timeout: 15_000 });
    for (const line of (res.stdout ?? "").split("\n")) {
      try { this.add(JSON.parse(line)); } catch { /* empty line */ }
    }
    return this;
  }

  add(e) {
    if (!e.Name?.startsWith("blindforge-")) return;
    const [rxS, txS] = String(e.NetIO).split("/");
    const rx = parseBytes(rxS), tx = parseBytes(txS), at = Date.now();
    const prev = this.samples.get(e.Name);
    if (!prev) {
      this.samples.set(e.Name, { rx, tx, at, rxRate: null, txRate: null });
      return;
    }
    // docker stats emits roughly every second. If less than 0.5 s has passed since the last baseline, keep the previous rate
    const dt = (at - prev.at) / 1000;
    if (dt < 0.5) return;
    this.samples.set(e.Name, {
      rx, tx, at,
      rxRate: Math.max(0, (rx - prev.rx) / dt),
      txRate: Math.max(0, (tx - prev.tx) / dt),
    });
  }

  get(name) {
    return this.samples.get(name);
  }

  stop() {
    this.proc?.kill();
  }
}

const ACTIVE_BPS = 512; // faster than this counts as flowing

// Arrow: -----label---->. While data flows, » moves from `from` toward `to`
// When animate is false (--once), no », just color the arrow if data is flowing
function arrow(label, active, { frame, speed, color, animate }) {
  const D = 4; // number of - before and after the label
  if (!active) return `${c.gray}${"-".repeat(D)}${label}${"-".repeat(D + 1)}>${c.reset}`;
  // » moves only over the - (the label stays readable): through the D before it, then the D after it
  const pos = animate ? Math.floor(frame * speed) % (D * 2) : -1;
  const dash = (i) => (i === pos ? `${c.bold}${c.brightCyan}»${c.reset}${color}` : "-");
  const before = Array.from({ length: D }, (_, i) => dash(i)).join("");
  const after = Array.from({ length: D }, (_, i) => dash(D + i)).join("");
  return `${color}${before}${c.bold}${label}${c.reset}${color}${after}->${c.reset}`;
}

const health = (status) =>
  /\(healthy\)/.test(status) ? { mark: "", ok: true }
  : /health: starting/.test(status) ? { mark: " starting", ok: false }
  : /unhealthy/.test(status) ? { mark: " unhealthy", ok: false }
  : { mark: "", ok: true };

function node(label, color, status) {
  const h = status ? health(status) : { mark: "" };
  const markColor = h.mark === " unhealthy" ? c.red : c.brightYellow;
  return `${color}<${c.bold}${label}${c.reset}${color}${h.mark ? `${markColor}${h.mark}${c.reset}${color}` : ""}>${c.reset}`;
}

// containers: [{ project, service, status, name }]. Returns the lines to display
export function renderNetwork(containers, { apps, monitor, frame = 0, animate = true, width, pad }) {
  const out = [];
  const groups = new Map();
  for (const x of containers) {
    if (!groups.has(x.project)) groups.set(x.project, []);
    groups.get(x.project).push(x);
  }
  for (const [project, xs] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const p = parseProject(project, apps);
    const tag = /^\d+$/.test(p.target) ? `#${p.target}` : p.target;
    out.push(`  ${c.bold}[${p.app} ${tag}]${c.reset} ${c.dim}${p.kind}${c.reset}`);
    const byService = new Map(xs.map((x) => [x.service, x]));
    const rows = [];
    for (const x of xs.sort((a, b) => a.service.localeCompare(b.service))) {
      const edges = EDGES[x.service] ?? [];
      const color = SERVICE_COLOR[x.service] ?? c.cyan;
      const self = node(`${tag} ${x.service}`, color, x.status);
      const s = monitor?.get(x.name);
      const bps = s && s.rxRate !== null ? s.rxRate + s.txRate : null;
      if (edges.length === 0) rows.push({ left: self, mid: "", right: "", note: "" });
      for (const e of edges) {
        const other = e.to ?? e.from;
        const peer = byService.get(other);
        const otherNode = EXTERNAL[other]
          ? node(EXTERNAL[other].name, EXTERNAL[other].color)
          : node(`${tag} ${other}`, SERVICE_COLOR[other] ?? c.cyan, peer?.status);
        let active, note;
        if (e.loopback) {
          active = !!peer && health(peer.status).ok && /^Up/.test(x.status);
          note = active ? `${c.dim}localhost:8787${c.reset}` : `${c.dim}idle${c.reset}`;
        } else if (bps === null) {
          // No rate yet (--once, or just started). Show totals only
          active = !animate;
          note = s ? `${c.dim}total ↑${formatRate(s.tx).replace("/s", "")} ↓${formatRate(s.rx).replace("/s", "")}${c.reset}` : "";
        } else {
          active = bps >= ACTIVE_BPS;
          note = active ? `${c.dim}↑${formatRate(s.txRate)} ↓${formatRate(s.rxRate)}${c.reset}` : `${c.dim}idle${c.reset}`;
        }
        // the more traffic, the faster » moves
        const speed = !animate ? 0 : bps === null || e.loopback ? 1 : bps > 1e6 ? 3 : bps > 1e5 ? 2 : 1;
        const line = arrow(e.label, active, { frame, speed, color, animate });
        rows.push(e.to ? { left: self, mid: line, right: otherNode, note } : { left: otherNode, mid: line, right: self, note });
      }
    }
    const lw = Math.max(...rows.map((r) => width(r.left)));
    const mw = Math.max(...rows.map((r) => width(r.mid)));
    const rw = Math.max(...rows.map((r) => width(r.right)));
    for (const r of rows) {
      out.push(r.mid ? `    ${pad(r.left, lw)} ${pad(r.mid, mw)} ${pad(r.right, rw)}  ${r.note}` : `    ${r.left}`);
    }
  }
  return out;
}
