#!/usr/bin/env node
// cascade-swarm: point a swarm of your own coding agents at a goal.
//   npx cascade-swarm "make the failing tests pass" --agents 4 --check "npm test"
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);

if (argv[0] === "__worker") {
  const { workerMain } = await import("../src/worker.mjs");
  await workerMain(argv[1], argv[2], argv[3]);
} else {
  const HELP = `cascade-swarm: point a swarm of your own coding agents at a goal.

Usage:
  cascade-swarm "<goal>" [options]

Options:
  -n, --agents <n>          parallel workers (default 3)
  -c, --check "<cmd>"       command that exits 0 when the goal is met, e.g. "npm test".
                            Run after every merge; the swarm stops when it passes.
  -w, --worker <type>       claude | codex | command (default claude)
      --worker-cmd "<cmd>"  for --worker command: any program that reads the prompt on stdin
  -m, --model <name>        model for the workers (default: the CLI's own default)
      --planner-model <m>   model for planning (default: --model)
      --escalate-model <m>  after retries fail, try a task once more on this model
      --retries <n>         same-model retries per task, with the failure text (default 1)
      --max-cost <usd>      HARD budget cap for the whole run (default 5)
      --max-cost-per-call <usd>  cap for one agent session (default: half the budget, $0.50-$2)
      --max-tasks <n>       most tasks the plan may grow to (default 20)
      --max-minutes <n>     stop after this long (default: no limit)
      --hints <file>        notes for the workers, re-read before every task
                            (default .cascade-swarm/hints.md)
      --task-ttl <s>        claim TTL; a dead worker's task frees after this (default 120)
      --task-timeout <min>  kill one agent session after this long (default 30)
      --check-at-end        run the check only when the task list is empty, not after every merge
      --no-file-locks       don't install the per-file lock hook in worker sessions
      --keep-worktrees      keep the per-worker worktrees after the run
      --repo <dir>          repository (default: the current directory)
      --dry-run             show what would happen; start, change and charge nothing
  -h, --help, --version

Needs: Node 18+, git, CASCADE_API_KEY, and the claude or codex CLI signed in.
Stop with Ctrl-C (once: finish cleanly; twice: force) or by creating
.cascade-swarm/runs/<run>/STOP.`;

  let p;
  try {
    p = parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: {
        agents: { type: "string", short: "n" }, check: { type: "string", short: "c" }, worker: { type: "string", short: "w" },
        "worker-cmd": { type: "string" }, model: { type: "string", short: "m" }, "planner-model": { type: "string" },
        "escalate-model": { type: "string" }, retries: { type: "string" }, "max-cost": { type: "string" },
        "max-cost-per-call": { type: "string" }, "max-tasks": { type: "string" }, "max-minutes": { type: "string" },
        hints: { type: "string" }, "task-ttl": { type: "string" }, "task-timeout": { type: "string" },
        "check-at-end": { type: "boolean" }, "no-file-locks": { type: "boolean" }, "keep-worktrees": { type: "boolean" },
        "check-timeout": { type: "string" }, "max-replans": { type: "string" },
        repo: { type: "string" }, "dry-run": { type: "boolean" }, goal: { type: "string" },
        help: { type: "boolean", short: "h" }, version: { type: "boolean" },
      },
    });
  } catch (e) { console.error(`cascade-swarm: ${e.message}\n\n${HELP}`); process.exit(2); }
  const v = p.values;
  if (v.help) { console.log(HELP); process.exit(0); }
  if (v.version) { console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version); process.exit(0); }

  const num = (name, dflt, { min = 0, int = false } = {}) => {
    if (v[name] === undefined) return dflt;
    const n = Number(v[name]);
    if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) { console.error(`cascade-swarm: --${name} must be ${int ? "an integer" : "a number"} >= ${min}`); process.exit(2); }
    return n;
  };
  const goal = (v.goal || p.positionals.join(" ")).trim();
  if (!goal) { console.error(`cascade-swarm: say what the swarm should do.\n\n${HELP}`); process.exit(2); }
  const worker = v.worker || "claude";
  if (!["claude", "codex", "command"].includes(worker)) { console.error("cascade-swarm: --worker must be claude, codex or command"); process.exit(2); }

  const o = {
    goal, worker, workerCmd: v["worker-cmd"], check: v.check, model: v.model, plannerModel: v["planner-model"], escalateModel: v["escalate-model"],
    agents: num("agents", 3, { min: 1, int: true }), retries: num("retries", 1, { int: true }),
    maxCost: num("max-cost", 5, { min: 0.01 }), maxCostPerCall: v["max-cost-per-call"] !== undefined ? num("max-cost-per-call", 1, { min: 0.01 }) : undefined,
    maxTasks: num("max-tasks", 20, { min: 1, int: true }), maxMinutes: num("max-minutes", 0),
    taskTtl: num("task-ttl", 120, { min: 1 }), taskTimeout: num("task-timeout", 30, { min: 0.1 }),
    checkTimeoutMs: num("check-timeout", 15, { min: 0.05 }) * 60000, maxReplans: num("max-replans", 3, { int: true }),
    checkAtEnd: !!v["check-at-end"], fileLocks: !v["no-file-locks"], keepWorktrees: !!v["keep-worktrees"],
    hints: v.hints, repo: v.repo, dryRun: !!v["dry-run"],
  };
  if (o.agents > 16) { console.error("cascade-swarm: at most 16 agents"); process.exit(2); }
  const { run } = await import("../src/orchestrator.mjs");
  process.exitCode = await run(o);
}
