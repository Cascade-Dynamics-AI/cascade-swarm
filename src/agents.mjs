// Run one agent session: Claude Code (`claude -p`), Codex (`codex exec`), or any
// command that reads a prompt on stdin. Uses the CLI already installed and
// signed in on this machine; cascade-swarm never sees your model credentials.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { killTree } from "./git.mjs";

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks");
export const GUARD_HOOK = join(HOOKS, "guard.mjs");
export const LOCK_HOOK = join(HOOKS, "cascade-file-lock.mjs");
const fwd = (p) => p.replace(/\\/g, "/");

export function which(name) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").concat([""]) : [""];
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    for (const ext of exts) { const p = join(dir, name + ext.toLowerCase()); if (dir && existsSync(p)) return p; }
  }
  return null;
}

export function findCli(type) {
  if (type === "claude") {
    return process.env.CASCADE_SWARM_CLAUDE || which("claude") ||
      [join(homedir(), ".local", "bin", "claude.exe"), join(homedir(), ".local", "bin", "claude"), join(homedir(), ".claude", "local", "claude")].find(existsSync) || null;
  }
  if (type === "codex") return process.env.CASCADE_SWARM_CODEX || which("codex") || null;
  return null;
}

const hookCmd = (script) => `"${fwd(process.execPath)}" "${fwd(script)}"`;

/** Claude Code settings for a worker session: the fail-closed shell guard on
 *  Bash, and the file-lock hook on every edit. File locks are NOT released on
 *  Stop: the worker releases them after its work is merged, so a second worker
 *  can't start editing a file whose first edit is still on its way to main. */
export function claudeSettings(runDir, { fileLocks = true } = {}) {
  const PreToolUse = [{ matcher: "Bash", hooks: [{ type: "command", command: hookCmd(GUARD_HOOK), timeout: 10 }] }];
  if (fileLocks) PreToolUse.push({ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: hookCmd(LOCK_HOOK), timeout: 15 }] });
  const path = join(runDir, "claude-settings.json");
  writeFileSync(path, JSON.stringify({ hooks: { PreToolUse } }, null, 2));
  return path;
}

/** Codex reads project hooks from .codex/hooks.json (and only runs them once
 *  you have trusted them in Codex). Written into the worktree, git-excluded. */
export function installCodexHooks(wt, { fileLocks = true } = {}) {
  const dir = join(wt, ".codex");
  mkdirSync(dir, { recursive: true });
  const PreToolUse = [{ matcher: "shell|exec_command|Bash", hooks: [{ type: "command", command: hookCmd(GUARD_HOOK), timeout: 10 }] }];
  if (fileLocks) PreToolUse.push({ matcher: "apply_patch|Edit|Write", hooks: [{ type: "command", command: hookCmd(LOCK_HOOK), timeout: 15 }] });
  writeFileSync(join(dir, "hooks.json"), JSON.stringify({ hooks: { PreToolUse } }, null, 2));
}

/**
 * -> { ok, code, costUsd (null if the CLI doesn't report it), text, killed, tokens }
 */
export function runAgent({ type, bin, cmd, prompt, cwd, model, budgetUsd, sessionId, role, settingsPath, env, isStopped, timeoutMs, onSpawn }) {
  let file, args, shell = false;
  if (type === "claude") {
    file = bin;
    args = ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--session-id", sessionId,
      "--settings", settingsPath, "--max-budget-usd", budgetUsd.toFixed(2)];
    if (model) args.push("--model", model);
    if (role === "plan") args.push("--allowedTools", "Read,Glob,Grep,Bash", "--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit");
    else args.push("--allowedTools", "Read,Glob,Grep,Bash,Edit,Write,MultiEdit,NotebookEdit,TodoWrite");
  } else if (type === "codex") {
    file = bin;
    args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", role === "plan" ? "read-only" : "workspace-write", "-C", cwd];
    if (model) args.push("-m", model);
    args.push("-");
  } else {
    file = cmd; args = []; shell = true;
  }
  // npm installs CLIs on Windows as .cmd shims, which need a shell. The prompt
  // goes over stdin, so the arguments are simple enough to quote by hand.
  if (!shell && /\.(cmd|bat)$/i.test(file)) {
    shell = true;
    const q = (s) => (/[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    file = q(file); args = args.map(q);
  }

  return new Promise((resolve) => {
    let out = "", err = "", killed = null;
    const p = spawn(file, args, {
      cwd, shell, windowsHide: true, detached: process.platform !== "win32",
      env: { ...process.env, ...env, CASCADE_SWARM_ROLE: role, CASCADE_SWARM_SESSION: sessionId, CASCADE_SWARM_BUDGET_USD: budgetUsd.toFixed(4) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    onSpawn?.(p.pid);
    p.stdout.on("data", (d) => { out += d; if (out.length > 4e6) out = out.slice(-2e6); });
    p.stderr.on("data", (d) => { err += d; if (err.length > 1e6) err = err.slice(-5e5); });
    p.stdin.on("error", () => {});
    p.stdin.end(prompt);
    const tick = setInterval(() => { if (!killed && isStopped?.()) { killed = "stopped"; killTree(p.pid); } }, 400);
    const timer = setTimeout(() => { killed = "timeout"; killTree(p.pid); }, timeoutMs);
    p.on("error", (e) => { err += `\n[cascade-swarm] could not start ${file}: ${e.message}`; });
    p.on("close", (code) => {
      clearInterval(tick); clearTimeout(timer);
      resolve({ ...parse(type, out, err, code), killed });
    });
  });
}

function parse(type, out, err, code) {
  if (type === "claude") {
    let j = null;
    try { j = JSON.parse(out.trim().split("\n").filter(Boolean).pop()); } catch {}
    if (!j) return { ok: false, code, costUsd: 0, text: (out + "\n" + err).slice(-4000) };
    return { ok: code === 0 && !j.is_error, code, costUsd: Number(j.total_cost_usd) || 0, text: String(j.result ?? j.subtype ?? ""), subtype: j.subtype };
  }
  if (type === "codex") {
    let text = "", tokens = 0;
    for (const line of out.split("\n")) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type === "item.completed" && e.item?.type === "agent_message") text = e.item.text ?? text;
      if (e.type === "turn.completed" && e.usage) tokens += (e.usage.input_tokens || 0) + (e.usage.output_tokens || 0);
    }
    return { ok: code === 0, code, costUsd: null, tokens, text: text || (out + err).slice(-4000) };
  }
  const costs = [...out.matchAll(/^COST:\s*([0-9.]+)\s*$/gm)];
  return { ok: code === 0, code, costUsd: costs.length ? Number(costs.at(-1)[1]) : 0, text: (out + (code ? "\n" + err : "")).slice(-8000) };
}

/** Lines the agent printed that start with TASK: become new tasks. */
export function tasksFrom(text) {
  return [...String(text).matchAll(/^\s*(?:[-*]\s*)?TASK:\s*(.+?)\s*$/gm)].map((m) => m[1]);
}
export function blockedFrom(text) {
  const m = String(text).match(/^\s*BLOCKED:\s*(.+?)\s*$/m);
  return m ? m[1].slice(0, 200) : null;
}
export function summaryFrom(text) {
  const m = [...String(text).matchAll(/^\s*SUMMARY:\s*(.+?)\s*$/gm)].pop();
  return m ? m[1].slice(0, 300) : String(text).trim().split("\n").pop()?.slice(0, 300) || "";
}
