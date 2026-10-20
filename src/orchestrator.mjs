// Set up a run, start the workers, keep them alive, stop cleanly, report.
import { fork, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, readdirSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { client } from "./cascade.mjs";
import { newBoard, readBoard, writeBoardUnlocked, reservedTotal, editBoard } from "./board.mjs";
import { git, head, runCheck, killTree } from "./git.mjs";
import { findCli, claudeSettings, installCodexHooks } from "./agents.mjs";
import { analyze, runCells } from "./receipts.mjs";
import { releaseLocksFor } from "./worker.mjs";
import { writeReport } from "./report.mjs";

const BIN = fileURLToPath(new URL("../bin/cascade-swarm.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s = "") => process.stdout.write(s + "\n");

export async function run(o) {
  // ---- preflight -------------------------------------------------------------
  const cwd = resolve(o.repo || process.cwd());
  const top = await git(cwd, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (top.code) return fail(`${cwd} is not inside a git repository. cascade-swarm works on a git repo so every change is reviewable.`);
  const repo = resolve(top.stdout.trim());
  if ((await git(repo, ["rev-parse", "--verify", "HEAD"], { allowFail: true })).code) return fail("the repository has no commits yet; commit something first.");
  const dirty = (await git(repo, ["status", "--porcelain", "--untracked-files=no"])).stdout.trim();

  let bin = null;
  if (o.worker === "command") { if (!o.workerCmd) return fail("--worker command needs --worker-cmd \"<command>\""); }
  else {
    bin = findCli(o.worker);
    if (!bin && !o.dryRun) return fail(`could not find the ${o.worker} CLI. Install it and sign in first (or set CASCADE_SWARM_${o.worker.toUpperCase()} to its path).`);
  }
  // Fail fast if Claude Code is installed but signed out (and no API key in the
  // environment): otherwise the planner fails twice before the run gives up.
  let signedIn = "unknown";
  if (o.worker === "claude" && bin) {
    signedIn = await claudeSignedIn(bin);
    if (signedIn === false && !process.env.ANTHROPIC_API_KEY && !o.dryRun) return fail("the claude CLI is not signed in. Run `claude` and /login (or set ANTHROPIC_API_KEY), then try again.");
  }
  const c = client({});
  if (!c.hasKey && !o.dryRun) return fail("CASCADE_API_KEY is not set. Get a free key at https://cascadedynamics.ai and export it.");

  const run = Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 5);
  const home = join(repo, ".cascade-swarm");
  const runDir = join(home, "runs", run);
  const integration = `cascade-swarm/${run}`;
  const workBranchPrefix = `cascade-swarm-work/${run}`;
  const hintsPath = o.hints ? (isAbsolute(o.hints) ? o.hints : resolve(cwd, o.hints)) : join(home, "hints.md");
  const minCallUsd = Number(process.env.CASCADE_SWARM_MIN_CALL_USD) || (o.worker === "claude" ? 0.05 : 0.0001);
  const perCallUsd = Math.min(o.maxCost, o.maxCostPerCall ?? Math.max(0.5, Math.min(2, o.maxCost / 2)));
  const taskTtlMs = o.taskTtl * 1000;

  if (o.dryRun) {
    let reach = "not checked (no CASCADE_API_KEY)";
    if (c.hasKey) reach = await c.usage().then((u) => `reachable (${u.used ?? "?"} of ${u.quota ?? "?"} decisions used)`, (e) => `NOT reachable: ${e.message}`);
    say(`cascade-swarm dry run: nothing will be started, changed or charged.

  goal          ${o.goal}
  repository    ${repo}${dirty ? "  (has uncommitted changes: they are NOT included, only HEAD is)" : ""}
  check         ${o.check || "(none: the run ends when the planner finds nothing left)"}
  workers       ${o.agents} x ${o.worker}${bin ? ` (${bin}${signedIn === false ? ", NOT SIGNED IN" : ""})` : o.worker === "command" ? ` (${o.workerCmd})` : " (CLI NOT FOUND)"}${o.model ? `, model ${o.model}` : ""}${o.escalateModel ? `, escalating to ${o.escalateModel}` : ""}
  budget        hard cap $${o.maxCost.toFixed(2)}, at most $${perCallUsd.toFixed(2)} per agent session${o.worker === "codex" ? " (Codex does not report dollars: only --max-tasks and retries bound it)" : ""}
  tasks         at most ${o.maxTasks}, ${o.retries} same-model retr${o.retries === 1 ? "y" : "ies"} per task
  Cascade       ${c.api}: ${reach}
  hints file    ${hintsPath}  (workers re-read it before every task)

It would:
  1. create branch cascade-swarm/<run> at HEAD, and one worktree + branch per worker under ${join(home, "runs", "<run>")}
  2. have one worker plan the goal into tasks while holding goal/<run> (the planner is your agent, not Cascade)
  3. let workers claim task/<run>/<id>, edit in their own worktree, and merge into cascade-swarm/<run> while holding merge/<run>
  4. ${o.check ? `run \`${o.check}\` after each merge and stop when it passes` : "stop when every task is done and the planner adds no more"}
  5. write REPORT.md and receipts.json; your current branch is never touched.
Cascade sees only cell names like task/<run>/t3 and file/<run>/src/app.js, and agent ids.`);
    return 0;
  }

  // ---- set up the run --------------------------------------------------------
  mkdirSync(runDir, { recursive: true });
  const commonDir = resolve(repo, (await git(repo, ["rev-parse", "--git-common-dir"])).stdout.trim());
  const exclude = join(commonDir, "info", "exclude");
  mkdirSync(join(commonDir, "info"), { recursive: true });
  const ex = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!/^\/?\.cascade-swarm\/?$/m.test(ex)) appendFileSync(exclude, `${ex && !ex.endsWith("\n") ? "\n" : ""}.cascade-swarm/\n`);
  if (o.worker === "codex" && !/^\.codex\/hooks/m.test(ex)) appendFileSync(exclude, ".codex/hooks.json\n");
  if (!existsSync(hintsPath)) writeFileSync(hintsPath, "<!-- Write notes for the swarm here while it runs. Every worker re-reads this file before each task. -->\n");

  const base = await head(repo);
  const mainWt = join(runDir, "main");
  await git(repo, ["branch", integration, base]);
  await git(repo, ["worktree", "add", "-q", mainWt, integration]);
  for (let i = 1; i <= o.agents; i++) {
    const wt = join(runDir, "wt", "w" + i);
    await git(repo, ["worktree", "add", "-q", "-b", `${workBranchPrefix}/w${i}`, wt, integration]);
    if (o.worker === "codex") installCodexHooks(wt, { fileLocks: o.fileLocks });
  }

  say(`cascade-swarm run ${run}: ${o.agents} ${o.worker} worker(s), budget $${o.maxCost.toFixed(2)}`);
  say(`  goal: ${o.goal}`);
  if (dirty) say("  note: you have uncommitted changes; the swarm works from HEAD and will not see them.");
  say(`  hints: edit ${hintsPath} any time; workers re-read it before each task.`);

  let baseline = null;
  if (o.check) {
    say(`  running the check once on HEAD: ${o.check}`);
    baseline = await runCheck(o.check, mainWt, { timeoutMs: o.checkTimeoutMs });
    say(`  check on HEAD: ${baseline.pass ? "PASSES" : `fails (exit ${baseline.code})`}`);
  }

  const boardPath = join(runDir, "board.json");
  const board = newBoard({ run, goal: o.goal, check: o.check, agents: o.agents, maxCost: o.maxCost, maxTasks: o.maxTasks });
  board.base = base; board.integration = integration;
  if (baseline) board.checks.push({ at: new Date().toISOString(), pass: baseline.pass, code: baseline.code, by: "baseline", after: "HEAD", tail: baseline.tail.slice(-1500) });
  if (baseline?.pass) Object.assign(board, { done: true, doneBy: "baseline", doneNote: "the check already passes on HEAD; nothing to do" });
  await writeBoardUnlocked(boardPath, board);

  const cfg = {
    run, repo, runDir, boardPath, mainWt, integration, workBranchPrefix, base,
    goal: o.goal, check: o.check || null, baseline: baseline && { pass: baseline.pass, code: baseline.code, tail: baseline.tail },
    agents: o.agents, workerType: o.worker, bin, workerCmd: o.workerCmd || null,
    model: o.model || null, plannerModel: o.plannerModel || null, escalateModel: o.escalateModel || null,
    retries: o.retries, maxReplans: o.maxReplans, perCallUsd, minCallUsd,
    maxAttempts: (o.retries + 1) * (o.escalateModel ? 2 : 1) + 4, maxBlocks: 8,
    taskTtlMs, heartbeatMs: process.env.CASCADE_SWARM_HEARTBEAT_MS !== undefined ? Number(process.env.CASCADE_SWARM_HEARTBEAT_MS) : Math.floor(taskTtlMs / 3),
    mergeTtlMs: Number(process.env.CASCADE_SWARM_MERGE_TTL_MS) || Math.max(60000, o.checkTimeoutMs + 60000),
    fileLocks: o.fileLocks, fileLockTtlMs: Number(process.env.CASCADE_SWARM_FILE_LOCK_TTL_MS) || 30 * 60 * 1000,
    hintsPath, taskTimeoutMs: o.taskTimeout * 60 * 1000, checkTimeoutMs: o.checkTimeoutMs, checkEachMerge: !o.checkAtEnd,
    api: c.api,
    claudeSettings: o.worker === "claude" ? claudeSettings(runDir, { fileLocks: o.fileLocks }) : null,
  };
  writeFileSync(join(runDir, "config.json"), JSON.stringify(cfg, null, 2));

  // ---- workers -----------------------------------------------------------------
  let stopping = false, forced = false, stopWhy = null;
  const workers = new Map();     // slot -> { agent, child, respawns, exited }
  const workersFile = join(runDir, "workers.json");
  const saveWorkers = () => writeFileSync(workersFile, JSON.stringify(Object.fromEntries([...workers].map(([s, w]) => [s, { agent: w.agent, pid: w.child?.pid ?? null, respawns: w.respawns, exited: w.exited }])), null, 2));
  const events = [];

  function start(slot, agent, respawns) {
    const child = fork(BIN, ["__worker", runDir, slot, agent], { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    const w = { agent, child, respawns, exited: false };
    workers.set(slot, w);
    const prefix = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => say(`[${agent}] ${l}`));
    child.stdout.on("data", prefix);
    child.stderr.on("data", prefix);
    child.on("exit", (code, signal) => onExit(slot, w, code, signal));
    saveWorkers();
  }

  async function onExit(slot, w, code, signal) {
    w.exited = true; saveWorkers();
    if (code === 0 || stopping) return;
    // A worker died without being asked to. Kill anything it left running, charge
    // its in-flight reservation as spent (we can't know what it used), and start
    // a fresh worker in the same slot. Its task comes back to the board when its
    // Cascade claim expires.
    const pidFile = join(runDir, "pids", w.agent + ".json");
    try { killTree(JSON.parse(readFileSync(pidFile, "utf8")).pid); rmSync(pidFile, { force: true }); } catch {}
    await releaseDeadSessions(w.agent);
    try {
      const b = await readBoard(boardPath);
      const held = b.budget.reserved[w.agent];
      if (held !== undefined) {
        await editBoard(c, boardPath, run, "orchestrator-" + run, (bb) => {
          const r = bb.budget.reserved[w.agent];
          if (r !== undefined) {
            delete bb.budget.reserved[w.agent]; bb.budget.spent += r; (bb.agents[w.agent] ??= { spent: 0, tasks: 0, calls: 0 }).spent += r;
            bb.budget.chargedForDeadWorkers = (bb.budget.chargedForDeadWorkers || 0) + r;
          }
        });
      }
      if (b.done || b.stuck || b.stopReason) return;
    } catch {}
    const ev = { at: new Date().toISOString(), ev: "worker-died", agent: w.agent, code, signal };
    events.push(ev);
    if (w.respawns >= 3) { say(`[swarm] ${w.agent} died (${signal || "exit " + code}); slot ${slot} has been restarted 3 times, leaving it down`); return; }
    const next = `${slot}r${w.respawns + 1}`;
    say(`[swarm] ${w.agent} died (${signal || "exit " + code}); starting ${next}. Its task returns to the board when its claim expires (<= ${o.taskTtl}s).`);
    events.push({ at: new Date().toISOString(), ev: "worker-respawned", agent: next, replaces: w.agent });
    start(slot, `${run}-${next}`, w.respawns + 1);
  }

  // A dead worker's agent session may still hold file locks; give them back so
  // whoever takes over its task can edit those files.
  async function releaseDeadSessions(agent) {
    const f = join(runDir, "pids", agent + ".sessions.json");
    let ids = [];
    try { ids = JSON.parse(readFileSync(f, "utf8")); } catch { return; }
    const lockEnv = { CASCADE_API: c.api, CASCADE_LOCK_SCOPE: run };
    await Promise.all(ids.map((id) => releaseLocksFor(id, lockEnv)));
    try { rmSync(f, { force: true }); } catch {}
  }

  function requestStop(why) {
    if (stopping) return;
    stopping = true; stopWhy = why;
    try { writeFileSync(join(runDir, "STOP"), why + "\n"); } catch {}
    for (const w of workers.values()) if (!w.exited) try { w.child.send({ type: "stop" }); } catch {}
    say(`[swarm] stopping (${why}): workers are giving back their claims. Press Ctrl-C again to force.`);
  }
  function forceStop() {
    forced = true;
    say("[swarm] forcing stop: killing workers. Their claims free themselves when their TTLs run out.");
    for (const w of workers.values()) if (!w.exited) killTree(w.child.pid);
    try { for (const f of readdirSafe(join(runDir, "pids")).filter((x) => !x.endsWith(".sessions.json"))) killTree(JSON.parse(readFileSync(join(runDir, "pids", f), "utf8")).pid); } catch {}
  }
  const onSigint = () => (stopping ? forceStop() : requestStop("Ctrl-C"));
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);
  const deadline = o.maxMinutes ? Date.now() + o.maxMinutes * 60000 : Infinity;

  if (!board.done) for (let i = 1; i <= o.agents; i++) start("w" + i, `${run}-w${i}`, 0);
  while ([...workers.values()].some((w) => !w.exited)) {
    await sleep(250);
    if (!stopping && existsSync(join(runDir, "STOP"))) requestStop(readFileSync(join(runDir, "STOP"), "utf8").trim() || "STOP file");
    if (!stopping && Date.now() > deadline) requestStop(`time limit of ${o.maxMinutes} min`);
  }
  process.off("SIGINT", onSigint); process.off("SIGTERM", onSigint);

  // ---- wrap up -------------------------------------------------------------------
  let final = await readBoard(boardPath);
  if (stopping && !final.done && !final.stopReason) final.stopReason = `stopped: ${stopWhy}`;
  if (!final.done && !final.stopReason && !final.stuck) final.stopReason = "all workers exited";
  if (reservedTotal(final) > 0) {                         // only after a forced stop: charge what was in flight
    for (const [a, v] of Object.entries(final.budget.reserved)) { final.budget.spent += v; (final.agents[a] ??= { spent: 0, tasks: 0, calls: 0 }).spent += v; }
    final.budget.reserved = {};
  }
  final.workerEvents = events;
  for (const f of readdirSafe(join(runDir, "pids")).filter((x) => x.endsWith(".sessions.json"))) await releaseDeadSessions(f.replace(/\.sessions\.json$/, ""));
  let finalCheck = null;
  if (o.check && !stopping && !(baseline?.pass)) {          // after Ctrl-C, get out fast
    say(`[swarm] final check on ${integration}: ${o.check}`);
    finalCheck = await runCheck(o.check, mainWt, { timeoutMs: o.checkTimeoutMs });
    final.finalCheck = { pass: finalCheck.pass, code: finalCheck.code, tail: finalCheck.tail.slice(-3000), at: new Date().toISOString() };
    if (final.done && !finalCheck.pass) { final.done = false; final.stopReason = "the check passed during the run but fails on the final branch"; }
  }
  final.finishedAt = new Date().toISOString();
  await writeBoardUnlocked(boardPath, final, "final");

  let receipts = null;
  try {
    const bundle = await c.bundle();
    writeFileSync(join(runDir, "receipts.json"), JSON.stringify(bundle));
    receipts = analyze(bundle.chain, runCells(run));
    receipts.chainHead = bundle.chain.at(-1)?.hash ?? null;
    receipts.chainLength = bundle.chain.length;
  } catch (e) { say(`[swarm] could not download the receipt bundle: ${e.message}`); }

  const merged = final.tasks.filter((t) => t.commit).length;
  const diffstat = (await git(repo, ["diff", "--shortstat", `${base}...${integration}`], { allowFail: true })).stdout.trim();
  const reportPath = writeReport({ runDir, board: final, cfg, receipts, diffstat, o });

  // Worker worktrees and branches are scratch; the integration branch is the result.
  if (!o.keepWorktrees) {
    for (const slot of [...workers.keys()].concat(Array.from({ length: o.agents }, (_, i) => "w" + (i + 1)))) {
      await git(repo, ["worktree", "remove", "--force", join(runDir, "wt", slot)], { allowFail: true });
      await git(repo, ["branch", "-D", `${workBranchPrefix}/${slot}`], { allowFail: true });
    }
    await git(repo, ["worktree", "remove", "--force", mainWt], { allowFail: true });
    await git(repo, ["worktree", "prune"], { allowFail: true });
  }

  say("");
  say(final.done ? `DONE: ${final.doneNote || (o.check ? `\`${o.check}\` passes` : "the planner found nothing left")}` : `NOT DONE: ${final.stopReason || "stopped"}`);
  say(`  tasks: ${final.tasks.filter((t) => t.status === "done").length} done, ${final.tasks.filter((t) => t.status === "failed").length} failed, ${final.tasks.filter((t) => t.status === "open" || t.status === "active").length} unfinished; ${merged} merged`);
  say(`  spend: $${final.budget.spent.toFixed(2)} of $${final.budget.cap.toFixed(2)}${o.worker === "codex" ? " (Codex does not report dollars)" : ""}`);
  if (receipts) say(`  receipts: ${receipts.grants} grants, ${receipts.holds} holds, ${receipts.duplicateHolders.length} duplicate holders (receipts.json)`);
  say(`  report: ${reportPath}`);
  if (merged) {
    say(`  review: git diff ${base.slice(0, 8)}...${integration}`);
    say(`  apply:  git merge ${integration}`);
  }
  return final.done ? 0 : 1;
}

function readdirSafe(d) { try { return readdirSync(d); } catch { return []; } }
/** true / false from `claude auth status`, or "unknown" on CLIs without it. */
function claudeSignedIn(bin) {
  return new Promise((ok) => execFile(bin, ["auth", "status"], { timeout: 20000, windowsHide: true, shell: /\.(cmd|bat)$/i.test(bin) }, (_e, stdout) => {
    try { ok(JSON.parse(String(stdout)).loggedIn === true); } catch { ok("unknown"); }
  }));
}

function fail(msg) { process.stderr.write(`cascade-swarm: ${msg}\n`); return 2; }
