# cascade-swarm

Point a swarm of your own coding agents at a goal.

```bash
npx cascade-swarm "make the failing tests pass" --agents 4 --check "npm test"
```

cascade-swarm starts N workers using the Claude Code or Codex CLI you already have installed and signed in. One worker turns the goal into tasks. The others take tasks, each in its own git worktree, and merge finished work into a new branch. The run stops when your check command passes, when the budget runs out, or when you press Ctrl-C. Your current branch is never touched: you get a branch to review and a report.

The workers coordinate through [Cascade](https://cascadedynamics.ai), a coordination API: claim a named cell, release it, get a signed receipt for each decision. Two workers can't hold the same task, merge at the same moment, or edit the same file at once, and the receipts let you check that afterwards, offline.

- **Your agents, your machine, your login.** cascade-swarm runs `claude -p` or `codex exec` as you. It never sees your model credentials.
- **Zero dependencies.** Node 18+ and git.
- **Open source**, MIT.

## Install

```bash
npm install -g cascade-swarm     # or use npx cascade-swarm ...
export CASCADE_API_KEY=csc_...   # free key at https://cascadedynamics.ai
```

You also need one of:

- **Claude Code** (`claude`), signed in (`claude`, then `/login`) or with `ANTHROPIC_API_KEY` set.
- **Codex CLI** (`codex`), signed in.

Try a dry run first. It starts, changes and charges nothing:

```bash
cascade-swarm "make the failing tests pass" --agents 4 --check "npm test" --dry-run
```

## What happens in a run

1. **Setup.** A branch `cascade-swarm/<run>` is created at your HEAD, plus one worktree and branch per worker under `.cascade-swarm/runs/<run>/` (git-excluded). Uncommitted changes are not included. The check runs once on HEAD; if it already passes, the run ends without spending anything.
2. **Plan.** One worker claims `goal/<run>` and asks your agent to split the goal into tasks. It plans read-only, with edits disabled. The plan comes from your agent, never from Cascade.
3. **Work.** Each worker claims `task/<run>/<id>`, resets its worktree to the latest merged state, runs your agent on the task, and commits the result. A heartbeat renews the claim while the agent works.
4. **Merge.** The worker claims `merge/<run>`, merges its branch, runs the check, and releases the cell with a receipt of the merge commit. A conflict sends the task back with the conflict as context.
5. **Finish.** When the task list is empty, a worker re-runs the check under `goal/<run>`. If it still fails, the planner gets the failing output and adds tasks (up to `--max-replans`). Agents can also add tasks they discover by printing `TASK: ...` lines.
6. **Report.** `REPORT.md` lists every task, who did it, its cost, its commit and its claim and merge receipts. `receipts.json` holds the signed bundle.

If a task fails, it is retried on the same model with the failure text (`--retries`), then once on `--escalate-model` if you set one, and then it is marked failed. Finished tasks don't end the run: the check does.

## Steering a run

Workers re-read the hints file (`.cascade-swarm/hints.md` by default, or `--hints <file>`) before every task. Edit it while the swarm runs: "use the existing logger", "don't touch the migrations".

## Stopping

- **Ctrl-C once:** workers stop their agents, give their tasks back to the board and release every claim. Then the report is written.
- **Ctrl-C twice:** workers are killed. Their claims free themselves when their TTL runs out.
- Or create `.cascade-swarm/runs/<run>/STOP`. On Windows, a script can't send Ctrl-C to another process, so use this file there.
- `--max-minutes <n>` stops the run on a timer.

If a worker crashes or hangs, its task claim expires (`--task-ttl`, default 120 s) and another worker takes the task over. A replacement worker is started in its slot. A worker that outlives its claim can't merge stale work: before merging it re-checks its claim's fencing token, and discards its work if the token changed.

## Safety

**Workers run with your permissions.** They are your agent CLI, on your machine, in your repository, under your account. Treat a swarm like a teammate with your keyboard:

- Each worker runs in its own worktree, and merges go to the `cascade-swarm/<run>` branch. cascade-swarm never pushes or merges into your branch; you do that after you review. A worktree is not a sandbox, though: an agent with shell access can reach anything your user account can.
- Claude Code workers run with `--permission-mode acceptEdits` and a fixed tool list. A guard hook (`hooks/guard.mjs`) **refuses** shell commands that push, rewrite git history, delete recursively, publish packages, deploy, read secrets (`.env`, keys), drop tables, shut down the machine, schedule tasks or pipe downloads into a shell. If the guard can't read a command, it refuses it (fail closed). It is a pattern list, not a sandbox: a determined workaround can get past it. Run swarms on code you're willing to let an agent edit.
- Codex workers run with `--sandbox workspace-write`, or read-only for planning.
- The planner runs with edits disabled.

**Budget caps.** `--max-cost` (default $5) is a hard cap for the whole run. Before each agent session, a worker reserves money from the remaining budget (at most `--max-cost-per-call`) and passes it to Claude Code as `--max-budget-usd`. Parallel workers can't jointly overspend, because the reservations are made while holding the board cell. When the remaining money is too little for another session, no new sessions start. Notes:

- Claude Code checks its budget between turns, so one session can run slightly past its own reservation.
- If a worker dies mid-session, its whole reservation counts as spent.
- **Codex doesn't report dollars**, so its spend can't be capped in dollars. Its runs are bounded by `--max-tasks`, the retry limits and `--max-minutes`, and the report shows tokens instead.
- Planning, retries and re-plans are agent sessions too, and each one costs money.

**What Cascade sees:** cell names and agent ids, nothing else. Cell names look like `goal/<run>`, `board/<run>`, `merge/<run>`, `task/<run>/t3` (task ids, not task text) and `file/<run>/src/app.js` (repo-relative paths, from the file-lock hook). Agent ids look like `<run>-w2` plus random session UUIDs. Prompts, code, diffs, task titles, test output and your model credentials never leave your machine through cascade-swarm. If file paths are sensitive, use `--no-file-locks`. Each claim, granted or held, counts as one decision on your Cascade plan. Releases and repeated waits on the same cell are free.

## Parallel edits to the same file

Each worker has its own worktree, so workers never overwrite each other on disk. Conflicts would show up at merge time instead. To prevent them, each Claude Code session gets the [file-lock hook](hooks/cascade-file-lock.mjs): before an edit, it claims `file/<run>/<path>`. If another worker's session holds that file, the edit is refused and the agent is told who holds it. Locks are held until that worker's change is merged, then released. A task that can't finish without a held file ends with `BLOCKED: <file>` and goes back on the board with a backoff. That doesn't use up a retry. The file-lock hook fails open: if Cascade is unreachable, edits are allowed. The swarm itself fails closed: with no referee, workers stop.

For Codex, the hooks are written to `.codex/hooks.json` in each worktree (git-excluded). Codex only runs project hooks after you trust them in Codex.

## Options

```
-n, --agents <n>          parallel workers (default 3, max 16)
-c, --check "<cmd>"       exits 0 when the goal is met; run after every merge
-w, --worker <type>       claude | codex | command (default claude)
    --worker-cmd "<cmd>"  for --worker command: any program that reads the prompt on stdin
-m, --model <name>        worker model (default: the CLI's own default)
    --planner-model <m>   planning model (default: --model)
    --escalate-model <m>  after retries fail, one more try on this model
    --retries <n>         same-model retries per task (default 1)
    --max-cost <usd>      hard cap for the whole run (default 5)
    --max-cost-per-call <usd>  cap for one agent session
    --max-tasks <n>       most tasks the plan may grow to (default 20)
    --max-minutes <n>     time limit
    --max-replans <n>     re-plans after the queue empties with the check failing (default 3)
    --hints <file>        notes re-read before every task
    --task-ttl <s>        claim TTL: how fast a dead worker's task frees (default 120)
    --task-timeout <min>  kill one agent session after this long (default 30)
    --check-timeout <min> check command time limit (default 15); a timeout counts as failing
    --check-at-end        check only when the task list empties, not after every merge
    --no-file-locks       don't install the file-lock hook
    --keep-worktrees      keep worker worktrees after the run
    --repo <dir>          repository (default: current directory)
    --dry-run             show the plan; start, change and charge nothing
```

`--worker command` runs any program you like. It gets the prompt on stdin and the worktree as its working directory, plus these environment variables: `CASCADE_SWARM_ROLE` (`plan` or `work`), `CASCADE_SWARM_AGENT`, `CASCADE_SWARM_SESSION`, `CASCADE_SWARM_BUDGET_USD`, and `CASCADE_SWARM_LOCK` (the file-lock CLI). It answers with `TASK:`, `SUMMARY:`, `BLOCKED:` and optionally `COST: <usd>` lines.

## Checking the receipts

`receipts.json` is your key's signed Cascade bundle. The report replays it and counts **duplicate holders**: cases where a cell was granted to one agent while another still held it. The count should be 0. To check the hash chain and signatures offline, run:

```bash
npx cascade-verify .cascade-swarm/runs/<run>/receipts.json
```

or drop the file on https://cascadedynamics.ai/verify.html.

## Development

```bash
npm test
```

The tests run the real CLI with a deterministic fake agent (`test/fake-agent.mjs`), so they cost nothing. They need a local Cascade API: set `CASCADE_SERVER` to its `server.mjs`. Each test starts it on a private port with a temporary state directory. `node test/real-claude.mjs` does one real Claude Code run on a two-bug fixture, capped at $2.

## License

MIT
