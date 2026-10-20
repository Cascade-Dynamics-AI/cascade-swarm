#!/usr/bin/env node
// A deterministic stand-in for a coding agent, used by the tests (zero model
// spend). Run by cascade-swarm as `--worker command`: prompt on stdin, the
// worktree as cwd, same output protocol as a real agent (TASK:/SUMMARY:/COST:).
//
// Plan role:  initial plan = FAKE_INITIAL (comma list of files, default every
//             src/*.txt that says BROKEN); re-plan = every file still BROKEN.
// Work role:  task "fix src/x.txt" -> claim the file lock like the real hook
//             does, wait FAKE_DELAY_MS, write "FIXED".
// Knobs:      FAKE_HANG_FILE (+ FAKE_HANG_MARKER: hang once on that file, writing
//             the marker so the test knows), FAKE_SLOW_FILE (+ FAKE_SLOW_MARKER:
//             once, take FAKE_SLOW_MS), FAKE_REFUSE_FILE (always fail),
//             FAKE_DISCOVER="src/a.txt>src/e.txt" (fixing a reports e as new work),
//             FAKE_COST (dollars per call, capped at the session budget like
//             claude --max-budget-usd), FAKE_LOG (append every prompt).
import { readFileSync, writeFileSync, readdirSync, existsSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let prompt = "";
for await (const c of process.stdin) prompt += c;
const env = process.env;
const role = env.CASCADE_SWARM_ROLE;
const agent = env.CASCADE_SWARM_AGENT;
if (env.FAKE_LOG) appendFileSync(env.FAKE_LOG, JSON.stringify({ at: Date.now(), role, agent, prompt }) + "\n");
const cost = () => { if (env.FAKE_COST) console.log(`COST: ${Math.min(Number(env.FAKE_COST), Number(env.CASCADE_SWARM_BUDGET_USD)).toFixed(4)}`); };
const broken = () => readdirSync("src").filter((f) => readFileSync(join("src", f), "utf8").includes("BROKEN")).map((f) => "src/" + f);

if (role === "plan") {
  const initial = !prompt.includes("Tasks already finished");
  const files = initial && env.FAKE_INITIAL ? env.FAKE_INITIAL.split(",") : broken();
  for (const f of files) console.log(`TASK: fix ${f}`);
  cost();
  process.exit(0);
}

const m = prompt.match(/^YOUR TASK \(t\d+\): fix (\S+?)(?: part (\d+))?$/m);
if (!m) { console.log("SUMMARY: could not understand the task"); cost(); process.exit(1); }
const [, file, part] = m;

if (env.FAKE_REFUSE_FILE === file) { console.log(`SUMMARY: I can't fix ${file}`); cost(); process.exit(1); }

if (env.FAKE_SLOW_FILE === file && env.FAKE_SLOW_MARKER && !existsSync(env.FAKE_SLOW_MARKER)) {
  writeFileSync(env.FAKE_SLOW_MARKER, agent);
  await sleep(Number(env.FAKE_SLOW_MS) || 4000);         // outlive our claim, then try to finish anyway
}
// Take the file lock exactly as the Claude Code hook would before an edit.
if (env.CASCADE_SWARM_LOCK) {
  try { execFileSync(process.execPath, [env.CASCADE_SWARM_LOCK, "claim", file, "--agent", env.CASCADE_SWARM_SESSION], { stdio: "pipe" }); }
  catch (e) {
    if (e.status === 3) { console.log(`BLOCKED: ${file}`); console.log(`SUMMARY: ${file} is being edited by another agent; not touched`); cost(); process.exit(0); }
    throw e;
  }
}

if (env.FAKE_HANG_FILE === file && env.FAKE_HANG_MARKER && !existsSync(env.FAKE_HANG_MARKER)) {
  writeFileSync(env.FAKE_HANG_MARKER, agent);
  await sleep(Number(env.FAKE_HANG_MS) || 60000);       // the test kills our worker long before this
  process.exit(1);
}
await sleep(Number(env.FAKE_DELAY_MS) || 200);

if (part) {
  // Several tasks share one file, one line each.
  const lines = readFileSync(file, "utf8").split("\n");
  lines[Number(part) - 1] = `FIXED part ${part} by ${agent}`;
  writeFileSync(file, lines.join("\n"));
} else writeFileSync(file, `FIXED by ${agent}\n`);

for (const rule of (env.FAKE_DISCOVER || "").split(",").filter(Boolean)) {
  const [from, to] = rule.split(">");
  if (from === file) console.log(`TASK: fix ${to}`);
}
console.log(`SUMMARY: fixed ${file}${part ? " part " + part : ""}`);
cost();
