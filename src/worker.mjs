// One worker: a loop that takes tasks off the board and runs your agent CLI on
// them, in its own git worktree. Runs as its own process so that a crash (or a
// kill) takes down only this worker; its claim then expires and another worker
// picks the task up.
//
// Cells (all Cascade ever sees, besides agent ids):
//   goal/<run> + merge/<run>  planning and goal checks (one planner at a time)
//   board/<run>               editing the board file
//   task/<run>/<id>           working on one task (renewed by a heartbeat)
//   merge/<run>               merging into the integration branch
//   file/<run>/<path>         per-file edit locks, from the file-lock hook
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { client } from "./cascade.mjs";
import { readBoard, editBoard, addTasks, unreserved, reservedTotal } from "./board.mjs";
import { syncWorktree, commitAll, mergeInto, runCheck, sha256 } from "./git.mjs";
import { runAgent, tasksFrom, summaryFrom, blockedFrom, LOCK_HOOK } from "./agents.mjs";
import { planPrompt, workPrompt } from "./prompts.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function workerMain(runDir, slot, agent) {
  const cfg = JSON.parse(readFileSync(join(runDir, "config.json"), "utf8"));
  const c = client({ api: cfg.api });
  const { run, boardPath, mainWt, integration } = cfg;
  const wt = join(runDir, "wt", slot);
  const branch = `${cfg.workBranchPrefix}/${slot}`;
  const stopFile = join(runDir, "STOP");
  const log = (ev, extra = {}) => {
    const line = { at: new Date().toISOString(), agent, ev, ...extra };
    try { appendFileSync(join(runDir, "log.jsonl"), JSON.stringify(line) + "\n"); } catch {}
    process.stdout.write(`${ev}${extra.task ? " " + extra.task : ""}${extra.note ? " · " + extra.note : ""}\n`);
  };

  // ---- stopping ------------------------------------------------------------
  let stopping = false, finished = false;
  process.on("message", (m) => { if (m?.type === "stop") stopping = true; });
  // Ctrl-C reaches every process in the terminal. The orchestrator decides what
  // a stop means and tells us over IPC; here it just means "wind down".
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });
  process.on("disconnect", () => { stopping = true; });   // orchestrator gone
  const poll = setInterval(async () => {
    if (existsSync(stopFile)) stopping = true;
    try { const b = await readBoard(boardPath); finished = !!(b.done || b.stuck || b.stopReason); } catch {}
  }, 1000);
  const stopped = () => stopping || finished;

  const sessions = new Set();            // agent sessions whose file locks we still hold
  const lockEnv = { CASCADE_API: cfg.api, CASCADE_LOCK_SCOPE: run, CASCADE_LOCK_TTL_MS: String(cfg.fileLockTtlMs) };
  async function releaseFileLocks(sessionId) {
    if (!cfg.fileLocks) return;
    await releaseLocksFor(sessionId, lockEnv);
    sessions.delete(sessionId);
    saveSessions();
  }

  const heartbeat = (renew) => {
    if (!cfg.heartbeatMs) return { stop() {}, lost: () => false };
    let lost = false;
    const t = setInterval(async () => { try { const r = await renew(); if (r && r.ok === false) lost = true; } catch {} }, cfg.heartbeatMs);
    return { stop: () => clearInterval(t), lost: () => lost };
  };

  // ---- budget: reserve before a call, settle after --------------------------
  async function reserve() {
    return editBoard(c, boardPath, run, agent, (b) => {
      const amount = Math.min(cfg.perCallUsd, unreserved(b));
      if (amount < cfg.minCallUsd) return null;
      b.budget.reserved[agent] = amount;
      return amount;
    });
  }
  async function settle(cost, extra = {}) {
    await editBoard(c, boardPath, run, agent, (b) => {
      delete b.budget.reserved[agent];
      b.budget.spent = round(b.budget.spent + (cost || 0));
      const a = (b.agents[agent] ??= { spent: 0, tasks: 0, calls: 0 });
      a.spent = round(a.spent + (cost || 0)); a.calls++;
      if (extra.tokens) a.tokens = (a.tokens || 0) + extra.tokens;
    });
  }
  const pidFile = join(runDir, "pids", agent + ".json");
  const recordPid = (pid) => { try { mkdirSync(join(runDir, "pids"), { recursive: true }); writeFileSync(pidFile, JSON.stringify({ pid })); } catch {} };
  // Agent sessions whose file locks this worker still holds. If the worker dies,
  // the orchestrator releases them, so whoever takes the task over can edit.
  const sessionsFile = join(runDir, "pids", agent + ".sessions.json");
  const saveSessions = () => { try { mkdirSync(join(runDir, "pids"), { recursive: true }); writeFileSync(sessionsFile, JSON.stringify([...sessions])); } catch {} };

  const hints = () => {
    try { return readFileSync(cfg.hintsPath, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim(); } catch { return ""; }
  };

  async function callAgent(role, prompt, model, lost = () => false) {
    const budgetUsd = await reserve();
    if (budgetUsd === null) return { noBudget: true };
    const sessionId = randomUUID();
    if (role === "work") { sessions.add(sessionId); saveSessions(); }
    let r;
    try {
      r = await runAgent({
        type: cfg.workerType, bin: cfg.bin, cmd: cfg.workerCmd, prompt, cwd: wt, model, budgetUsd, sessionId, role,
        settingsPath: cfg.claudeSettings, timeoutMs: cfg.taskTimeoutMs, isStopped: () => stopped() || lost(), onSpawn: recordPid,
        // CASCADE_SWARM_LOCK: the lock CLI, for command workers that want to lock files themselves.
        env: { ...lockEnv, CASCADE_SWARM_AGENT: agent, CASCADE_SWARM_RUN: run, CASCADE_SWARM_LOCK: cfg.fileLocks ? LOCK_HOOK : "" },
      });
    } finally {
      try { rmSync(pidFile, { force: true }); } catch {}
    }
    await settle(r.costUsd, { tokens: r.tokens });
    return { ...r, sessionId };
  }

  // ---- planning and goal checks: one agent at a time, under goal/ + merge/ ---
  async function planRound() {
    const cells = [`goal/${run}`, `merge/${run}`];
    const g = await c.claimMany(cells, agent, cfg.taskTtlMs);
    if (!g.ok) { await sleep(300 + Math.random() * 300); return; }
    const hb = heartbeat(() => c.claimMany(cells, agent, cfg.taskTtlMs));
    let status = "noop";
    try {
      const b = await readBoard(boardPath);
      if (b.done || b.stuck || b.stopReason) return;
      const initial = !b.planned;
      if (!initial && b.tasks.some((t) => t.status === "open" || t.status === "active")) return;

      let chk = null;
      if (cfg.check && !initial) {
        chk = await runCheck(cfg.check, mainWt, { timeoutMs: cfg.checkTimeoutMs });
        log(chk.pass ? "check-pass" : "check-fail", { note: `exit ${chk.code}` });
        await editBoard(c, boardPath, run, agent, (bb) => {
          bb.checks.push({ at: new Date().toISOString(), pass: chk.pass, code: chk.code, by: agent, after: "goal-check", receipt: g.entry_hash, tail: chk.tail.slice(-1500) });
          if (chk.pass) Object.assign(bb, { done: true, doneBy: agent, doneReceipt: g.entry_hash });
        });
        if (chk.pass) { status = "goal-met"; return; }
      }
      if (initial && cfg.check) chk = cfg.baseline;
      if (!initial && b.replans >= cfg.maxReplans) {
        await editBoard(c, boardPath, run, agent, (bb) => { bb.stuck = true; bb.stopReason = `stuck: the check still fails after ${b.replans} re-plans`; });
        status = "stuck"; return;
      }

      await syncWorktree(wt, branch, integration);
      const maxNew = Math.max(1, Math.min(Math.max(cfg.agents * 2, 3), b.maxTasks - b.tasks.length));
      log(initial ? "planning" : "re-planning");
      const prompt = planPrompt({ goal: cfg.goal, check: cfg.check, agents: cfg.agents, board: b, checkResult: chk, hints: hints(), initial, maxNew });
      const r = await callAgent("plan", prompt, cfg.plannerModel || cfg.model);
      if (r.noBudget) { await outOfBudget(); return; }
      if (stopping) return;
      const titles = r.ok ? tasksFrom(r.text).slice(0, maxNew) : [];
      await editBoard(c, boardPath, run, agent, (bb) => {
        const added = addTasks(bb, titles, initial ? "plan" : "re-plan");
        bb.events.push({ at: Date.now(), ev: initial ? "plan" : "re-plan", by: agent, receipt: g.entry_hash, added: added.map((t) => t.id), ok: r.ok, cost: r.costUsd });
        if (initial) {
          bb.planFailures = (bb.planFailures || 0) + (added.length ? 0 : 1);
          if (added.length) bb.planned = true;
          else if (bb.planFailures >= 2) { bb.stuck = true; bb.stopReason = `the planner produced no tasks (${r.ok ? "empty plan" : "agent failed: " + summaryFrom(r.text)})`; }
        } else {
          bb.replans++;
          if (!added.length && !cfg.check) Object.assign(bb, { done: true, doneBy: agent, doneReceipt: g.entry_hash, doneNote: "no check command; the planner found nothing left to do" });
        }
      });
      status = titles.length ? "planned" : "empty";
      log(initial ? "planned" : "re-planned", { note: `${titles.length} task(s)` });
    } finally {
      hb.stop();
      for (const cell of cells) await c.release(cell, agent, { status }).catch(() => {});
    }
  }

  async function outOfBudget() {
    await editBoard(c, boardPath, run, agent, (b) => {
      if (!b.stopReason && reservedTotal(b) === 0) b.stopReason = `budget: $${b.budget.spent.toFixed(2)} of $${b.budget.cap.toFixed(2)} spent`;
    });
  }

  // ---- one task ------------------------------------------------------------
  async function failTask(task, why, { countTry = true } = {}) {
    await editBoard(c, boardPath, run, agent, (b) => {
      const t = b.tasks.find((x) => x.id === task.id);
      if (!t || t.by !== agent || t.status !== "active") return;
      t.lastFailure = why;
      t.history.push({ at: new Date().toISOString(), agent, result: countTry ? "failed" : "blocked", why: String(why).slice(0, 500), model: t.model || cfg.model || "default" });
      if (!countTry) {
        // A held file is nobody's failure: it doesn't use a retry or an attempt,
        // but the task waits (2 s, 4 s, ... up to 60 s) before anyone tries again.
        t.tries = Math.max(0, (t.tries || 0) - 1);
        t.attempts = Math.max(0, t.attempts - 1);
        t.blocks = (t.blocks || 0) + 1;
        t.notBefore = Date.now() + Math.min(60000, 2000 * 2 ** (t.blocks - 1));
        t.status = t.blocks > cfg.maxBlocks ? "failed" : "open";
        return;
      }
      if (t.tries <= cfg.retries) t.status = "open";                         // same model again, with the failure text
      else if (cfg.escalateModel && !t.escalated) {                           // one step up the ladder, once
        Object.assign(t, { status: "open", escalated: true, model: cfg.escalateModel, tries: 0 });
        b.events.push({ at: Date.now(), ev: "escalate", task: t.id, to: cfg.escalateModel });
      } else t.status = "failed";
    });
    log(countTry ? "task-failed" : "task-blocked", { task: task.id, note: String(why).split("\n")[0].slice(0, 160) });
  }

  async function doTask(picked, g) {
    const cell = `task/${run}/${picked.id}`;
    const fence = g.fence;
    const hb = heartbeat(async () => { const r = await c.claim(cell, agent, cfg.taskTtlMs); return r.ok && r.fence === fence ? r : { ok: false }; });
    let status = "skipped", sessionId = null;
    try {
      const task = await editBoard(c, boardPath, run, agent, (b) => {
        const t = b.tasks.find((x) => x.id === picked.id);
        if (!t) return null;
        if (t.status === "active" && t.by !== agent) {
          // We were granted the cell, so the previous holder's claim expired:
          // it crashed or hung. Take the task over. The abandoned attempt was
          // not the model failing, so it doesn't use up a retry.
          t.history.push({ at: new Date().toISOString(), agent: t.by, result: "abandoned", why: "its claim expired (worker died or hung); taken over by " + agent });
          b.events.push({ at: Date.now(), ev: "takeover", task: t.id, from: t.by, to: agent, receipt: g.entry_hash });
          t.tries = Math.max(0, (t.tries || 0) - 1);
        } else if (t.status !== "open") return null;
        // Bound the total, whatever the reason (lost claims, conflicts, retries).
        if (t.attempts >= cfg.maxAttempts) {
          Object.assign(t, { status: "failed", lastFailure: `gave up after ${t.attempts} attempts` });
          t.history.push({ at: new Date().toISOString(), agent, result: "failed", why: t.lastFailure });
          return null;
        }
        Object.assign(t, { status: "active", by: agent, fence, claimReceipt: g.entry_hash, attempts: t.attempts + 1, tries: (t.tries || 0) + 1, startedAt: new Date().toISOString() });
        return { ...t, others: b.tasks.filter((x) => x.status === "active" && x.id !== t.id).map((x) => ({ title: x.title })) };
      });
      if (!task) return;
      log("task-start", { task: task.id, note: task.title.slice(0, 100) });
      status = "failed";

      await syncWorktree(wt, branch, integration);
      const prompt = workPrompt({ goal: cfg.goal, check: cfg.check, agents: cfg.agents, agent, task, others: task.others, hints: hints() });
      const r = await callAgent("work", prompt, task.model || cfg.model, hb.lost);
      sessionId = r.sessionId;
      if (r.noBudget) {
        await editBoard(c, boardPath, run, agent, (b) => { const t = b.tasks.find((x) => x.id === task.id); if (t?.by === agent) Object.assign(t, { status: "open", attempts: t.attempts - 1, tries: t.tries - 1 }); });
        status = "no-budget"; await outOfBudget(); return;
      }

      // Fencing: before anything else, prove we still hold the task. If our
      // claim lapsed and another worker took it, our fence no longer matches
      // and this session's work, whatever it did, is discarded.
      const again = hb.lost() ? { ok: false } : await c.claim(cell, agent, cfg.taskTtlMs);
      if (!again.ok || again.fence !== fence) {
        log("task-lost", { task: task.id, note: "claim lost; discarding this work" });
        status = "lost"; return;
      }
      if (r.killed === "stopped" || stopped()) {
        // Interrupted (Ctrl-C, or the goal was met elsewhere): give the task back.
        // On Windows Ctrl-C reaches the agent CLI directly, so it may have died
        // on its own before we killed it: what matters is that we are stopping.
        await editBoard(c, boardPath, run, agent, (b) => { const t = b.tasks.find((x) => x.id === task.id); if (t?.by === agent && t.status === "active") Object.assign(t, { status: "open", attempts: t.attempts - 1, tries: t.tries - 1 }); });
        status = "interrupted";
        log("task-interrupted", { task: task.id });
        return;
      }
      if (!r.ok) { await failTask(task, `the agent exited with code ${r.code}${r.killed ? ` (${r.killed})` : ""}${r.subtype ? ` [${r.subtype}]` : ""}:\n${r.text.slice(-1500)}`); return; }

      const blocked = blockedFrom(r.text);
      if (blocked) { await failTask(task, `blocked: ${blocked} was being edited by another agent; try again on the latest code`, { countTry: false }); return; }
      const newTasks = tasksFrom(r.text);
      const summary = summaryFrom(r.text);
      const sha = await commitAll(wt, `${task.id}: ${task.title.slice(0, 72)}\n\nby ${agent} (cascade-swarm ${run})`);

      let merged = null, chk = null, mergeReceipt = null;
      if (sha) {
        const m = await c.acquire(`merge/${run}`, agent, cfg.mergeTtlMs, { shouldStop: () => stopping });
        if (!m) { status = "interrupted"; await editBoard(c, boardPath, run, agent, (b) => { const t = b.tasks.find((x) => x.id === task.id); if (t?.by === agent) Object.assign(t, { status: "open" }); }); return; }
        mergeReceipt = m.entry_hash;
        const mhb = heartbeat(() => c.claim(`merge/${run}`, agent, cfg.mergeTtlMs));
        let mstatus = "conflict";
        try {
          const mr = await mergeInto(mainWt, branch, `merge ${task.id} (${agent}): ${task.title.slice(0, 60)}`);
          if (!mr.ok) {
            await failTask(task, `merge conflict in ${mr.conflict.join(", ")}: another task changed the same lines first. Redo the task on the latest code.`);
            return;
          }
          merged = mr.sha; mstatus = "merged";
          if (cfg.check && cfg.checkEachMerge) {
            chk = await runCheck(cfg.check, mainWt, { timeoutMs: cfg.checkTimeoutMs });
            log(chk.pass ? "check-pass" : "check-fail", { task: task.id, note: `after merge, exit ${chk.code}` });
          }
        } finally {
          mhb.stop();
          await c.release(`merge/${run}`, agent, merged ? { status: mstatus, digest: sha256(merged) } : { status: mstatus }).catch(() => {});
        }
      }
      if (sessionId) await releaseFileLocks(sessionId);

      await editBoard(c, boardPath, run, agent, (b) => {
        const t = b.tasks.find((x) => x.id === task.id);
        Object.assign(t, { status: "done", commit: merged, mergeReceipt, summary, cost: r.costUsd, finishedAt: new Date().toISOString() });
        t.history.push({ at: t.finishedAt, agent, result: merged ? "merged" : "no changes", model: t.model || cfg.model || "default" });
        const a = (b.agents[agent] ??= { spent: 0, tasks: 0, calls: 0 }); a.tasks++;
        const added = addTasks(b, newTasks, task.id);
        if (added.length) b.events.push({ at: Date.now(), ev: "discovered", by: agent, from: task.id, added: added.map((x) => x.id) });
        if (chk) {
          b.checks.push({ at: new Date().toISOString(), pass: chk.pass, code: chk.code, by: agent, after: task.id, commit: merged, receipt: mergeReceipt, tail: chk.tail.slice(-1500) });
          if (chk.pass && !b.done) Object.assign(b, { done: true, doneBy: agent, doneReceipt: mergeReceipt });
        }
      });
      status = "done";
      log("task-done", { task: task.id, note: merged ? `merged ${merged.slice(0, 8)}` : "no changes" });
    } catch (e) {
      log("task-error", { task: picked.id, note: e.message });
      try { await failTask(picked, `cascade-swarm error: ${e.message}`); } catch {}
    } finally {
      hb.stop();
      if (sessionId && sessions.has(sessionId)) await releaseFileLocks(sessionId);
      await c.release(cell, agent, { status }).catch(() => {});
    }
  }

  // ---- the loop --------------------------------------------------------------
  log("worker-start", { note: `slot ${slot}, pid ${process.pid}` });
  let exitCode = 0;
  try {
    for (;;) {
      if (stopping) break;
      const b = await readBoard(boardPath);
      if (b.done || b.stuck || b.stopReason) break;
      if (unreserved(b) < cfg.minCallUsd) {
        if (reservedTotal(b) === 0) { await outOfBudget(); break; }
        await sleep(1000); continue;                         // money may come back when in-flight calls settle
      }
      if (!b.planned) { await planRound(); continue; }
      const now = Date.now();
      const open = b.tasks.filter((t) => t.status === "open" && !(t.notBefore > now));
      const active = b.tasks.filter((t) => t.status === "active" && t.by !== agent);
      const waiting = b.tasks.some((t) => t.status === "open" && t.notBefore > now);
      if (!open.length && !active.length) { if (waiting) { await sleep(500); continue; } await planRound(); continue; }
      // Prefer open work; otherwise probe an active task in case its worker died
      // (the probe is a HOLD while the holder is alive; repeats are free).
      const pool = open.length ? open : active;
      const task = pool[Math.floor(Math.random() * pool.length)];
      const g = await c.claim(`task/${run}/${task.id}`, agent, cfg.taskTtlMs);
      if (!g.ok) { await sleep(open.length ? 150 + Math.random() * 250 : 1000 + Math.random() * 1000); continue; }
      await doTask(task, g);
    }
  } catch (e) {
    log("worker-error", { note: e.stack || e.message });
    exitCode = 1;
  } finally {
    clearInterval(poll);
    for (const s of [...sessions]) await releaseFileLocks(s);
    log("worker-exit");
  }
  process.exit(exitCode);
}

const round = (x) => Math.round(x * 1e6) / 1e6;

/** Give back every file lock one agent session took (via the hook's own CLI). */
export function releaseLocksFor(sessionId, lockEnv) {
  return new Promise((ok) => execFile(process.execPath, [LOCK_HOOK, "release-all", "--agent", sessionId], { env: { ...process.env, ...lockEnv }, windowsHide: true }, () => ok()));
}
