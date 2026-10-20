// The board: one JSON file per run holding the plan, who did what, receipts and
// spend. Anyone may read it at any time (writes are an atomic rename); only the
// holder of the board/<run> cell may change it.
import { readFile, writeFile, rename } from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// On Windows a file another process is reading can't be replaced for a moment,
// and a reader can catch the board mid-swap.
async function retry(fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= 60 || (!["EPERM", "EBUSY", "EACCES", "ENOENT"].includes(e.code) && !(e instanceof SyntaxError))) throw e;
      await sleep(15 + Math.random() * 30);
    }
  }
}

export const readBoard = (path) => retry(async () => JSON.parse(await readFile(path, "utf8")));

export async function writeBoardUnlocked(path, board, tag = "init") {
  await writeFile(path + ".tmp-" + tag, JSON.stringify(board, null, 2));
  await retry(() => rename(path + ".tmp-" + tag, path));
}

export function newBoard({ run, goal, check, agents, maxCost, maxTasks }) {
  return {
    run, goal, check: check || null,
    created: new Date().toISOString(),
    planned: false, done: false, stuck: false, stopReason: null,
    replans: 0,
    budget: { cap: maxCost, spent: 0, reserved: {} },   // reserved: { agent: usd } while a call is in flight
    maxTasks, nextId: 1,
    tasks: [],          // { id, title, status: open|active|done|failed, by, attempts, model, history: [] }
    checks: [],         // { at, pass, after, by, tail }
    agents: Object.fromEntries(Array.from({ length: agents }, (_, i) => [`w${i + 1}`, { spent: 0, tasks: 0, calls: 0 }])),
    events: [],
  };
}

/** Change the board while holding board/<run>. Returns the new board. */
export async function editBoard(cascade, path, run, agent, change) {
  const cell = "board/" + run;
  const g = await cascade.acquire(cell, agent, 15000);
  try {
    const board = await readBoard(path);
    const out = change(board);
    await writeBoardUnlocked(path, board, agent);
    return out === undefined ? board : out;
  } finally {
    await cascade.release(cell, agent).catch(() => {});
  }
}

export function addTasks(board, titles, from) {
  const added = [];
  for (const raw of titles || []) {
    const title = String(raw).trim().slice(0, 500);
    if (!title) continue;
    if (board.tasks.some((t) => t.title.toLowerCase() === title.toLowerCase())) continue;
    if (board.tasks.length >= board.maxTasks) { board.events.push({ at: Date.now(), ev: "max-tasks", dropped: title }); continue; }
    const t = { id: "t" + board.nextId++, title, status: "open", from, attempts: 0, model: null, history: [] };
    board.tasks.push(t);
    added.push(t);
  }
  return added;
}

export const spentTotal = (b) => b.budget.spent;
export const reservedTotal = (b) => Object.values(b.budget.reserved).reduce((s, v) => s + v, 0);
export const unreserved = (b) => Math.max(0, b.budget.cap - b.budget.spent - reservedTotal(b));
