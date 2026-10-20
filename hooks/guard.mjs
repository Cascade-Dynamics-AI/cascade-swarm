#!/usr/bin/env node
// cascade-swarm guard: a PreToolUse hook on shell commands. Workers run with
// your permissions, so the irreversible commands below are refused outright,
// with no model judgement involved. Ordinary work (running tests, installing
// packages, reading files) passes.
//
// FAIL CLOSED: if this script can't read its input or hits a bug, the command
// is denied. (The file-lock hook is the opposite: a coordination aid fails open.)
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RULES = [
  ["push to a remote", /\bgit\s+push(?![\w-])/i],
  ["rewrite or discard git history", /\bgit\s+(?:reset\b[^|;&]*--hard|clean\b[^|;&]*(?:-\w*f|--force)|checkout\s+(?:-f\b|--force)|branch\s+-D\b|rebase\b|filter-branch\b|update-ref\b|worktree\s+remove\b|switch\b)/i],
  ["recursively delete files", /\brm\s+(?:-\w+\s+)*-\w*(?:rf|fr)\w*(?:\s|$)|\brm\s+(?:-\w+\s+)*-\w*r\w*\s+(?:-\w+\s+)*-\w*f|\brm\s+(?:-\w+\s+)*-\w*f\w*\s+(?:-\w+\s+)*-\w*r|\brm\b[^|;&]*--recursive|\bRemove-Item\b[^|;&]*-Recurse|\b(?:rmdir|rd)\s+[^|;&]*\/s\b|\bdel\s+[^|;&]*\/s\b/i],
  ["publish a package", /\b(?:npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b|\bgh\s+(?:release|repo\s+create|pr\s+create|workflow\s+run)\b/i],
  ["deploy or change cloud infrastructure", /(?:^|[\s;|&(])(?:aws|gcloud|az|terraform|kubectl|pulumi|flyctl|vercel|wrangler)\s|\bdocker\s+push\b/i],
  ["read secret material", /\b(?:cat|type|more|less|head|tail|cp|copy|scp|curl|Get-Content|gc)\b[^|;&]*(?:\.env(?!\.(?:example|sample|template))\b|id_rsa|id_ed25519|\.npmrc|\.pypirc|credentials\b)|\bsecretsmanager\b|\bprintenv\b|^\s*env\s*$/i],
  ["drop or truncate a database table", /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\s+(?:TABLE\s+)?\w/i],
  ["shut down or reboot the machine", /(?:^|[\s;|&(])(?:shutdown|reboot|halt|poweroff)\b|\b(?:Stop|Restart)-Computer\b/i],
  ["install something that runs later", /\bschtasks\b[^|;&]*\/create\b|\bRegister-ScheduledTask\b|\bcrontab\s+(?!-l)/i],
  ["pipe a download into a shell", /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\biex\b|\bInvoke-Expression\b/i],
];

export function verdict(command) {
  const c = String(command ?? "");
  for (const [what, re] of RULES) if (re.test(c)) return what;
  return null;
}

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  process.exit(0);
}

const isMain = !!process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  try {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw);
    const cmd = input?.tool_input?.command;
    if (typeof cmd !== "string") deny("cascade-swarm guard could not read the command; refusing (fail closed).");
    const what = verdict(cmd);
    if (what) deny(`Refused by cascade-swarm: this command would ${what}. Workers may not do that. The swarm handles git itself (commits, merges); do not retry or work around this, carry on with your task and mention it in your SUMMARY.`);
    process.exit(0);
  } catch (e) {
    deny(`cascade-swarm guard error (${e?.message || e}); refusing (fail closed).`);
  }
}
