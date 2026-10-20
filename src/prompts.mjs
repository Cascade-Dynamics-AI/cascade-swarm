// What each agent is told. Plain text over stdin; the agent answers with
// `TASK: ...` lines (new work) and one `SUMMARY: ...` line.

const block = (title, body) => (body && String(body).trim() ? `\n${title}\n${String(body).trim()}\n` : "");

export function planPrompt({ goal, check, agents, board, checkResult, hints, initial, maxNew }) {
  const done = board.tasks.filter((t) => t.status === "done").map((t) => `- ${t.title}`).join("\n");
  const failed = board.tasks.filter((t) => t.status === "failed").map((t) => `- ${t.title} (failed: ${String(t.lastFailure || "").split("\n")[0].slice(0, 200)})`).join("\n");
  return `You are the planner for a team of ${agents} coding agents working on this repository at the same time.

GOAL: ${goal}
${check ? `The goal is met when this command exits with code 0: ${check}\n` : ""}${checkResult && !checkResult.pass ? block(`Current output of the check (it is failing, exit code ${checkResult.code}):`, checkResult.tail.slice(-3000)) : ""}${initial ? "" : block("Tasks already finished:", done) + block("Tasks that failed:", failed)}${block("Notes from the human running this swarm (follow them):", hints)}
Read the code you need. Do NOT change any files: you are only planning.

Then split the work that remains into at most ${maxNew} tasks that different agents can do in parallel, ideally each touching different files. Make every task specific and self-contained: name the files and say what done looks like. Don't list work that is already finished. If nothing useful remains, list no tasks.

Answer with one line per task, in exactly this form:
TASK: <what to do, naming the files>
`;
}

export function workPrompt({ goal, check, agents, agent, task, others, hints }) {
  return `You are agent ${agent}, one of ${agents} coding agents working on this repository at the same time. Each agent works in its own copy of the repository; the swarm merges finished work for you.

OVERALL GOAL: ${goal}
YOUR TASK (${task.id}): ${task.title}
${check ? `The overall goal is met when \`${check}\` exits 0. You may run it to check your work, but only do what your task covers.\n` : ""}${block("Other agents are doing these tasks right now, so leave them alone:", others.map((t) => `- ${t.title}`).join("\n"))}${block("An earlier attempt at this task failed. What went wrong:", task.lastFailure ? String(task.lastFailure).slice(-3000) : "")}${block("Notes from the human running this swarm (follow them):", hints)}
Rules:
- Edit files directly in this directory. Do not commit, push, switch branches or rewrite git history: the swarm does all git work.
- If an edit is refused because another agent is editing that file, don't wait for it: do the rest of your task. If the task can't be finished without that file, end with one line: BLOCKED: <file>. The task then goes back on the board for later.
- If you find necessary work outside your task, don't do it. List it instead, one line each: TASK: <description>
- End your answer with one line: SUMMARY: <what you changed>
`;
}
