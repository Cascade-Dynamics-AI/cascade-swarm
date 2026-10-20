#!/usr/bin/env node
// cascade-file-lock.mjs: stop parallel AI coding agents from editing the same
// file at the same time. Node 18+, no packages.
//
// As a Claude Code hook (reads the hook JSON on stdin):
//   PreToolUse (Edit|Write|MultiEdit|NotebookEdit): claim file/<repo-relative path>
//     for this session. Granted: allow (no output, normal permissions apply).
//     Held by another session: deny, naming the holder. Each edit renews the TTL.
//   Stop / SessionEnd: release every file this session holds.
//
// From any other tool or shell (exit 0 = go ahead, 3 = held by someone else):
//   node cascade-file-lock.mjs claim <file> --agent <id>
//   node cascade-file-lock.mjs release <file> --agent <id>
//   node cascade-file-lock.mjs release-all --agent <id>
//
// Env:
//   CASCADE_API_KEY      your key (missing => fail open: edits are allowed, with a warning)
//   CASCADE_API          default https://api.cascadedynamics.ai/v1
//   CASCADE_LOCK_TTL_MS  how long a lock lives without another edit (default 600000 = 10 min)
//   CASCADE_LOCK_SCOPE   optional prefix, e.g. the repo name, when one key covers several repos
//   CASCADE_AGENT        agent id for the CLI commands (instead of --agent)
//   CASCADE_LOCK_LOG     optional file path: one JSON line per claim/release/warning
//
// FAIL OPEN: if the key is missing or the API can't be reached, edits are
// ALLOWED and a warning goes to stderr. A lock service must never be the reason
// someone's editor stops working. The cost: during an outage, files are unguarded.

import { existsSync, appendFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";

const API = (process.env.CASCADE_API || "https://api.cascadedynamics.ai/v1").replace(/\/+$/, "");
const KEY = process.env.CASCADE_API_KEY || "";
const TTL_MS = Number(process.env.CASCADE_LOCK_TTL_MS) || 600_000;
const SCOPE = (process.env.CASCADE_LOCK_SCOPE || "").replace(/^\/+|\/+$/g, "");
const TIMEOUT_MS = Number(process.env.CASCADE_LOCK_TIMEOUT_MS) || 3000;
const STATE_DIR = join(tmpdir(), "cascade-file-lock");
const TAG = "[cascade-file-lock]";

const LOG = process.env.CASCADE_LOCK_LOG || "";   // optional: append one JSON line per decision

const warn = (msg) => { process.stderr.write(`${TAG} ${msg}\n`); note({ warn: msg }); };
function note(o) { if (LOG) try { appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n"); } catch {} }

// ---- the API ---------------------------------------------------------------

class Unavailable extends Error {}

async function post(path, body) {
  if (!KEY) throw new Unavailable("CASCADE_API_KEY is not set");
  let res;
  try {
    res = await fetch(API + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "User-Agent": "cascade-file-lock/1.0" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Unavailable(`could not reach ${API} (${e.name === "TimeoutError" ? "timed out" : e.message})`);
  }
  let json = null;
  try { json = await res.json(); } catch {}
  if (!res.ok || !json) throw new Unavailable(`${API}${path} answered HTTP ${res.status}${json?.error ? ` (${json.error})` : ""}`);
  return json;
}

// ---- cells -----------------------------------------------------------------

function repoRoot(start) {
  for (let d = resolve(start); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;       // .git is a dir, or a file in worktrees
    if (dirname(d) === d) return resolve(start);     // no repo: the working directory is the root
  }
}

function cellFor(file, cwd) {
  const abs = resolve(cwd, file);
  const root = repoRoot(cwd);
  let rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) rel = abs;   // outside the repo: use the full path
  rel = rel.replace(/\\/g, "/");
  if (process.platform === "win32" || process.platform === "darwin") rel = rel.toLowerCase(); // case-insensitive filesystems
  return "file/" + (SCOPE ? SCOPE + "/" : "") + rel;
}

// ---- per-session state: one line per granted cell, append-only -------------
// Append-only so two hooks of the same session running at once can't clobber
// each other. Release reads the unique set.

const stateFile = (agent) => join(STATE_DIR, agent.replace(/[^A-Za-z0-9_.-]/g, "_") + ".cells");

function remember(agent, cell) {
  try { mkdirSync(STATE_DIR, { recursive: true }); appendFileSync(stateFile(agent), cell + "\n"); } catch (e) { warn(`could not write state: ${e.message}`); }
}

function remembered(agent) {
  try { return [...new Set(readFileSync(stateFile(agent), "utf8").split("\n").filter(Boolean))]; } catch { return []; }
}

// ---- actions ---------------------------------------------------------------

// -> { ok: true } | { ok: false, holder } | { ok: true, failedOpen: reason }
async function claim(cell, agent) {
  try {
    const r = await post("/claim", { cell, agent, ttl_ms: TTL_MS });
    note({ claim: cell, agent, ok: !!r.ok, holder: r.behind });
    if (r.ok) { remember(agent, cell); return { ok: true }; }
    if (r.hold) return { ok: false, holder: r.behind };
    warn(`unexpected answer for ${cell}: ${JSON.stringify(r).slice(0, 200)}; allowing the edit`);
    return { ok: true, failedOpen: "unexpected answer" };
  } catch (e) {
    if (!(e instanceof Unavailable)) throw e;
    warn(`${e.message}. Allowing the edit WITHOUT a lock (fail open).`);
    return { ok: true, failedOpen: e.message };
  }
}

async function release(cell, agent) {
  try { return (await post("/release", { cell, agent })).released === true; }
  catch (e) { if (!(e instanceof Unavailable)) throw e; warn(`${e.message}; ${cell} will free itself when its TTL runs out`); return false; }
}

async function releaseAll(agent) {
  const cells = remembered(agent);
  note({ release_all: agent, cells });
  await Promise.all(cells.map((c) => release(c, agent)));
  try { rmSync(stateFile(agent), { force: true }); } catch {}
  return cells.length;
}

const short = (id) => (String(id).length > 12 ? String(id).slice(0, 8) + "…" : String(id));

function holdReason(file, holder) {
  const mins = Math.round(TTL_MS / 60000);
  return `${file} is being edited by another agent right now (held by session ${short(holder)}). ` +
    `Don't edit it; pick another file or wait and retry. The lock frees when that session finishes its turn, ` +
    `or after ${mins >= 1 ? mins + " min" : Math.round(TTL_MS / 1000) + " s"} with no edits from it.`;
}

// ---- entry points ----------------------------------------------------------

async function readStdin() {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

// Files a tool call is about to change. Claude Code: Edit/Write/MultiEdit use
// tool_input.file_path, NotebookEdit uses notebook_path. Codex: apply_patch puts
// the whole patch in tool_input.command ("*** Update File: <path>" etc.).
// Cursor: the Write tool (key names not documented, so accept the common ones).
function filesOf(toolInput) {
  const ti = toolInput || {};
  const one = ti.file_path || ti.notebook_path || ti.path || ti.target_file;
  if (one) return [String(one)];
  if (typeof ti.command === "string" && ti.command.includes("*** Begin Patch")) {
    return [...ti.command.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((m) => (m[1] || m[2]).trim());
  }
  return [];
}

let isCursor = false;

async function hook(input) {
  const ev = String(input.hook_event_name || "");
  const cursor = isCursor = "cursor_version" in input || "conversation_id" in input;   // Cursor's hook payload
  const agent = String((cursor ? input.conversation_id || input.session_id : input.session_id) || "");
  const out = (o) => process.stdout.write(JSON.stringify(o));
  if (!agent) { warn("hook input has no session id; skipping"); if (cursor) out(ev === "preToolUse" ? { permission: "allow" } : {}); return; }

  if (ev === "PreToolUse" || ev === "preToolUse") {
    const files = filesOf(input.tool_input);
    const cwd = input.cwd || input.workspace_roots?.[0] || process.cwd();
    const had = new Set(remembered(agent));
    let held = null;
    const granted = [];
    for (const file of files) {
      const cell = cellFor(file, cwd);
      const r = await claim(cell, agent);
      if (!r.ok) { held = { file, holder: r.holder }; break; }
      if (!r.failedOpen && !had.has(cell)) granted.push(cell);
    }
    if (!held) { if (cursor) out({ permission: "allow" }); return; }   // Claude Code / Codex: no output = normal permission flow
    // A multi-file patch is all or nothing: give back what this call just took.
    await Promise.all(granted.map((c) => release(c, agent)));
    const reason = holdReason(held.file, held.holder);
    if (cursor) out({ permission: "deny", user_message: reason, agent_message: reason });
    else out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
    return;
  }
  // A subagent shares its parent's session id, so only the parent's Stop releases.
  if (["Stop", "SessionEnd", "stop", "sessionEnd"].includes(ev)) await releaseAll(agent);
  if (cursor) out({});
}

async function cli(argv) {
  const [cmd, ...rest] = argv;
  const i = rest.indexOf("--agent");
  const agent = i >= 0 ? rest.splice(i, 2)[1] : process.env.CASCADE_AGENT;
  const file = rest[0];
  if (!agent || (cmd !== "release-all" && !file) || !["claim", "release", "release-all"].includes(cmd)) {
    process.stderr.write("usage: cascade-file-lock.mjs claim|release <file> --agent <id>  |  release-all --agent <id>\n");
    process.exit(2);
  }
  if (cmd === "claim") {
    const r = await claim(cellFor(file, process.cwd()), agent);
    if (r.ok) { console.log(r.failedOpen ? `UNLOCKED ${file} (lock service unavailable; go ahead)` : `LOCKED ${file} for ${agent}`); process.exit(0); }
    console.log(`HELD ${file}: ${holdReason(file, r.holder)}`);
    process.exit(3);
  }
  if (cmd === "release") { console.log((await release(cellFor(file, process.cwd()), agent)) ? `RELEASED ${file}` : `NOT HELD ${file}`); return; }
  console.log(`RELEASED ${await releaseAll(agent)} file(s) for ${agent}`);
}

const argv = process.argv.slice(2);
try {
  if (argv.length) await cli(argv);
  else {
    const raw = await readStdin();
    let input;
    try { input = JSON.parse(raw); } catch { warn("stdin is not hook JSON; allowing"); process.exit(0); }
    await hook(input);
  }
} catch (e) {
  // Any bug in here must not block an edit either.
  warn(`internal error: ${e?.stack || e}; allowing`);
  if (isCursor) process.stdout.write(JSON.stringify({ permission: "allow" }));
  process.exit(0);
}
