// node --test test/
// End-to-end runs of the real CLI with the fake agent (zero model spend),
// against a LOCAL Cascade API on its own port and state dir.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { analyze, runCells } from "../src/receipts.mjs";
import { startServer, fixtureRepo, runSwarm, fakeArgs, waitFor, gitOut, verifyBundle, sleep, SERVER } from "./helpers.mjs";

const skip = SERVER ? false : "set CASCADE_SERVER to a local Cascade API server.mjs to run the end-to-end tests";

let server;
before(async () => { if (!skip) server = await startServer(); });
after(() => server?.stop());

const runId = (r) => r.board.run;
const dupes = (r) => analyze(r.bundle.chain, runCells(runId(r))).duplicateHolders;
const show = (r) => `exit ${r.code}\n${r.out.slice(-4000)}`;

test("plan, work in parallel, discover work, re-plan when the check still fails, stop when it passes", { timeout: 240000, skip }, async () => {
  const repo = fixtureRepo(["a", "b", "c", "d", "e"]);
  const userHead = gitOut(repo, "rev-parse", "HEAD");
  // The planner only sees a, b, c at first. Fixing a reports e as new work.
  // d is found only when the check still fails after the queue empties.
  const r = await runSwarm(repo, fakeArgs("fix every broken file", ["--agents", "3"]), {
    api: server.api, env: { FAKE_INITIAL: "src/a.txt,src/b.txt,src/c.txt", FAKE_DISCOVER: "src/a.txt>src/e.txt" },
  });
  assert.equal(r.code, 0, show(r));
  const b = r.board;
  assert.equal(b.done, true);
  assert.deepEqual(b.tasks.map((t) => t.title).sort(), ["fix src/a.txt", "fix src/b.txt", "fix src/c.txt", "fix src/d.txt", "fix src/e.txt"]);
  assert.ok(b.tasks.every((t) => t.status === "done" && t.commit && t.claimReceipt && t.mergeReceipt), JSON.stringify(b.tasks, null, 1));
  assert.equal(b.tasks.find((t) => t.title.endsWith("e.txt")).from, b.tasks.find((t) => t.title.endsWith("a.txt")).id, "e was discovered by a's worker");
  assert.equal(b.tasks.find((t) => t.title.endsWith("d.txt")).from, "re-plan", "d came from the re-plan after the check failed");
  assert.ok(b.replans >= 1);
  assert.equal(new Set(b.tasks.map((t) => t.by)).size > 1, true, "more than one worker did work");
  assert.equal(b.finalCheck.pass, true);
  // The result is on the integration branch; the user's branch is untouched.
  assert.equal(gitOut(repo, "rev-parse", "HEAD"), userHead);
  assert.match(readFileSync(join(repo, "src", "a.txt"), "utf8"), /BROKEN/);
  for (const f of "abcde") assert.match(gitOut(repo, "show", `${b.integration}:src/${f}.txt`), /FIXED/);
  // Receipts: 0 duplicate holders, every task claim released, bundle verifies offline.
  assert.deepEqual(dupes(r), []);
  const a = analyze(r.bundle.chain, runCells(runId(r)));
  assert.deepEqual(a.stillHeld, [], "every cell this run took was given back");
  assert.ok(a.outcomes.merged >= 5, JSON.stringify(a.outcomes));
  const v = verifyBundle(join(r.runDir, "receipts.json"));
  if (!v.skipped) assert.equal(v.code, 0, v.out);
  // The report covers tasks, workers, receipts and spend.
  assert.match(r.report, /\*\*Result:\*\* DONE/);
  assert.match(r.report, /duplicate holders: 0/);
  for (const t of b.tasks) assert.ok(r.report.includes(t.claimReceipt));
  // Scratch worktrees are gone; the integration branch stays.
  assert.ok(!existsSync(join(r.runDir, "wt", "w1")));
  assert.match(gitOut(repo, "branch", "--list", "cascade-swarm-work/*"), /^$/);
});

test("kill a worker mid-task: its claim expires, a fresh worker takes the task over, the run still finishes", { timeout: 240000, skip }, async () => {
  const repo = fixtureRepo(["a", "b", "c", "d"]);
  const marker = join(repo, "..", "hang-" + Date.now());
  let killed = null;
  const r = await runSwarm(repo, fakeArgs("fix every broken file", ["--agents", "2", "--task-ttl", "2"]), {
    api: server.api, env: { FAKE_HANG_FILE: "src/b.txt", FAKE_HANG_MARKER: marker },
    during: async (ctx) => {
      // The fake agent writes the marker once it is hanging inside task b.
      const agent = await waitFor(() => existsSync(marker) && readFileSync(marker, "utf8"), 60000);
      const workers = JSON.parse(readFileSync(join(ctx.runDir, "workers.json"), "utf8"));
      const w = Object.values(workers).find((x) => x.agent === agent);
      process.kill(w.pid, "SIGKILL");                  // no goodbye: no release, no board update
      killed = agent;
    },
  });
  assert.equal(r.duringError, undefined, String(r.duringError));
  assert.ok(killed, "a worker was killed");
  assert.equal(r.code, 0, show(r));
  const b = r.board;
  assert.equal(b.done, true);
  const tb = b.tasks.find((t) => t.title === "fix src/b.txt");
  assert.equal(tb.status, "done");
  assert.notEqual(tb.by, killed, "someone else finished b");
  assert.ok(tb.history.some((h) => h.agent === killed && h.result === "abandoned"), JSON.stringify(tb.history));
  assert.ok(b.workerEvents.some((e) => e.ev === "worker-died" && e.agent === killed));
  assert.ok(b.workerEvents.some((e) => e.ev === "worker-respawned" && e.replaces === killed));
  // The chain shows the dead worker's claim expiring, then the takeover, and no overlap.
  const cell = `task/${b.run}/${tb.id}`;
  const onCell = r.bundle.chain.filter((e) => e.cell === cell);
  assert.ok(onCell.some((e) => e.verb === "RELEASE" && e.agent === killed && / expired$/.test(e.detail)), JSON.stringify(onCell));
  assert.ok(onCell.some((e) => e.verb === "ASSIGN" && e.agent === tb.by));
  assert.deepEqual(dupes(r), []);
  assert.match(gitOut(repo, "show", `${b.integration}:src/b.txt`), /FIXED/);
  assert.match(r.report, /worker-died/);
});

test("the check gates completion: finished tasks are not enough, and a goal that can't be met ends NOT DONE", { timeout: 240000, skip }, async () => {
  const repo = fixtureRepo(["a", "b", "c"]);
  const r = await runSwarm(repo, fakeArgs("fix every broken file", ["--agents", "2", "--retries", "1", "--escalate-model", "bigger-model", "--max-replans", "1"]), {
    api: server.api, env: { FAKE_REFUSE_FILE: "src/c.txt" },
  });
  assert.equal(r.code, 1, show(r));
  const b = r.board;
  assert.equal(b.done, false);
  assert.match(b.stopReason, /check still fails/);
  assert.equal(b.finalCheck.pass, false);
  const tc = b.tasks.find((t) => t.title === "fix src/c.txt");
  assert.equal(tc.status, "failed");
  // Iterate, then escalate, then give up: 2 tries on the default model, 2 on the bigger one.
  assert.deepEqual(tc.history.map((h) => h.model), ["default", "default", "bigger-model", "bigger-model"]);
  assert.equal(tc.escalated, true);
  assert.ok(b.tasks.filter((t) => t.status === "done").length === 2);
  assert.ok(b.checks.filter((k) => k.by !== "baseline").every((k) => !k.pass));
  assert.match(r.report, /\*\*Result:\*\* NOT DONE/);
  assert.match(r.out, /NOT DONE/);
  assert.deepEqual(dupes(r), []);
});

test("hard budget cap: reservations keep total spend under the cap even with parallel workers", { timeout: 240000, skip }, async () => {
  const repo = fixtureRepo(["a", "b", "c", "d", "e", "f"]);
  const r = await runSwarm(repo, fakeArgs("fix every broken file", ["--agents", "3", "--max-cost", "1", "--max-cost-per-call", "0.3"]), {
    api: server.api, env: { FAKE_COST: "0.3", FAKE_DELAY_MS: "300" },
  });
  assert.equal(r.code, 1, show(r));
  const b = r.board;
  assert.match(b.stopReason, /^budget/);
  assert.ok(b.budget.spent <= 1 + 1e-9, `spent ${b.budget.spent}`);
  assert.ok(b.budget.spent >= 0.9 - 1e-9, `spent ${b.budget.spent}`);   // the budget was used, not just refused
  assert.deepEqual(b.budget.reserved, {});
  assert.ok(b.tasks.some((t) => t.status === "open"), "work was left undone rather than overspending");
  assert.match(r.report, /of a \$1\.00 cap/);
  assert.deepEqual(dupes(r), []);
});

test("hints: workers re-read the hints file before every task", { timeout: 240000, skip }, async () => {
  const repo = fixtureRepo(["a", "b", "c", "d"]);
  const log = join(repo, "..", "prompts-" + Date.now() + ".jsonl");
  const HINT = "HINT-" + Math.random().toString(36).slice(2);
  const r = await runSwarm(repo, fakeArgs("fix every broken file", ["--agents", "1"]), {
    api: server.api, env: { FAKE_LOG: log, FAKE_DELAY_MS: "600" },
    during: async (ctx) => {
      await waitFor(() => { try { return JSON.parse(readFileSync(join(ctx.runDir, "board.json"), "utf8")).tasks.some((t) => t.status === "done"); } catch { return false; } }, 60000, 50);
      writeFileSync(join(repo, ".cascade-swarm", "hints.md"), `Please keep it tidy. ${HINT}\n`);
    },
  });
  assert.equal(r.code, 0, show(r));
  const prompts = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((p) => p.role === "work");
  assert.equal(prompts.length, 4);
  assert.ok(!prompts[0].prompt.includes(HINT), "the first task ran before the hint existed");
  assert.ok(prompts.at(-1).prompt.includes(HINT), "a later task saw the hint");
  assert.match(prompts.at(-1).prompt, /Notes from the human running this swarm/);
  assert.deepEqual(dupes(r), []);
});

test("clean stop (the Ctrl-C path): in-flight tasks go back on the board and every claim is released", { timeout: 240000, skip }, async () => {
  const repo = fixtureRepo(["a", "b", "c", "d", "e", "f"]);
  const r = await runSwarm(repo, fakeArgs("fix every broken file", ["--agents", "3"]), {
    api: server.api, env: { FAKE_DELAY_MS: "5000" },
    during: async (ctx) => {
      await waitFor(() => { try { return JSON.parse(readFileSync(join(ctx.runDir, "board.json"), "utf8")).tasks.filter((t) => t.status === "active").length >= 2; } catch { return false; } }, 60000, 50);
      if (process.platform === "win32") writeFileSync(join(ctx.runDir, "STOP"), "Ctrl-C\n");   // Windows can't deliver SIGINT to a child; same code path
      else ctx.proc.kill("SIGINT");
    },
  });
  assert.equal(r.code, 1, show(r));
  const b = r.board;
  assert.match(b.stopReason, /stopped/);
  assert.ok(b.tasks.every((t) => t.status === "open" || t.status === "done"), JSON.stringify(b.tasks.map((t) => t.status)));
  assert.ok(b.tasks.some((t) => t.status === "open"));
  const a = analyze(r.bundle.chain, runCells(b.run));
  assert.deepEqual(a.stillHeld, [], "nothing is left held");
  assert.equal(a.expired, 0, "everything was released, not left to expire");
  assert.ok(a.outcomes.interrupted >= 2, JSON.stringify(a.outcomes));
  assert.match(r.out, /stopping \(/);
  assert.deepEqual(dupes(r), []);
});

test("dry run starts, changes and charges nothing", { timeout: 240000, skip }, async () => {
  const repo = fixtureRepo(["a"]);
  const before = (await fetch(server.api + "/runs/current/bundle", { headers: { Authorization: "Bearer csc_test_localdev" } }).then((x) => x.json())).chain.length;
  const r = await runSwarm(repo, fakeArgs("fix every broken file", ["--agents", "4", "--dry-run"]), { api: server.api });
  assert.equal(r.code, 0, show(r));
  assert.match(r.out, /dry run: nothing will be started, changed or charged/);
  assert.match(r.out, /4 x command/);
  assert.match(r.out, /reachable/);
  const after = (await fetch(server.api + "/runs/current/bundle", { headers: { Authorization: "Bearer csc_test_localdev" } }).then((x) => x.json())).chain.length;
  assert.equal(after, before, "no Cascade decisions");
  assert.ok(!existsSync(join(repo, ".cascade-swarm")));
  assert.equal(gitOut(repo, "branch", "--list"), "* main");
});

test("several tasks on one file: the file-lock hook serialises edits, so merges never conflict", { timeout: 240000, skip }, async () => {
  const repo = fixtureRepo([], { "src/s.txt": "BROKEN\nBROKEN\nBROKEN\n" });
  const r = await runSwarm(repo, fakeArgs("fix every line of src/s.txt", ["--agents", "3", "--retries", "0"]), {
    api: server.api, env: { FAKE_INITIAL: "src/s.txt part 1,src/s.txt part 2,src/s.txt part 3", FAKE_DELAY_MS: "500" },
  });
  assert.equal(r.code, 0, show(r));
  const s = gitOut(repo, "show", `${r.board.integration}:src/s.txt`);
  for (const n of [1, 2, 3]) assert.match(s, new RegExp(`FIXED part ${n} by`));
  const fileCell = `file/${r.board.run}/src/s.txt`;
  const onFile = r.bundle.chain.filter((e) => e.cell === fileCell);
  assert.ok(onFile.some((e) => e.verb === "HOLD"), "a second worker was held off the file while the first one's edit was unmerged");
  assert.ok(r.board.tasks.every((t) => t.history.every((h) => !/merge conflict/.test(h.why || ""))), "no merge conflicts");
  assert.ok(r.board.tasks.some((t) => t.history.some((h) => h.result === "blocked")), "a held file sent a task back to the board (BLOCKED)");
  assert.ok(r.board.tasks.every((t) => t.status === "done"));
  assert.deepEqual(dupes(r), []);
});

test("fencing: a worker that outlives its claim can't merge stale work over the new holder", { timeout: 240000, skip }, async () => {
  const repo = fixtureRepo(["a", "b", "c"]);
  const marker = join(repo, "..", "slow-" + Date.now());
  const r = await runSwarm(repo, fakeArgs("fix every broken file", ["--agents", "2", "--task-ttl", "3"]), {
    api: server.api,
    env: { CASCADE_SWARM_HEARTBEAT_MS: "0", FAKE_SLOW_FILE: "src/b.txt", FAKE_SLOW_MARKER: marker, FAKE_SLOW_MS: "9000" },
  });
  assert.equal(r.code, 0, show(r));
  const slow = readFileSync(marker, "utf8");
  const tb = r.board.tasks.find((t) => t.title === "fix src/b.txt");
  assert.notEqual(tb.by, slow, "the task was taken over");
  assert.match(r.out, new RegExp(`\\[${slow}\\] task-lost ${tb.id}`));
  const merges = gitOut(repo, "log", "--format=%s", r.board.integration).split("\n").filter((s) => s.startsWith(`merge ${tb.id} `));
  assert.equal(merges.length, 1, merges.join("\n"));
  assert.match(gitOut(repo, "show", `${r.board.integration}:src/b.txt`), new RegExp(`FIXED by ${tb.by}`));
  assert.deepEqual(dupes(r), []);
});
