// Read a Cascade receipt bundle back: replay every ASSIGN/RELEASE and check
// that no cell ever had two holders at once.

/** chain: the bundle's entries. cellFilter: which cells to count (default all). */
export function analyze(chain, cellFilter = () => true) {
  const holder = new Map();
  const out = { entries: 0, grants: 0, renewals: 0, holds: 0, releases: 0, expired: 0, cells: new Set(), duplicateHolders: [], outcomes: {} };
  for (const e of chain || []) {
    if (typeof e?.cell !== "string" || !cellFilter(e.cell)) continue;
    out.entries++;
    out.cells.add(e.cell);
    if (e.verb === "ASSIGN") {
      const cur = holder.get(e.cell);
      if (cur && cur !== e.agent) out.duplicateHolders.push({ cell: e.cell, holder: cur, alsoGranted: e.agent, hash: e.hash });
      if (cur === e.agent) out.renewals++; else out.grants++;
      holder.set(e.cell, e.agent);
    } else if (e.verb === "RELEASE") {
      out.releases++;
      if (/· expired$/.test(e.detail || "")) out.expired++;
      if (e.outcome?.status) out.outcomes[e.outcome.status] = (out.outcomes[e.outcome.status] || 0) + 1;
      if (holder.get(e.cell) === e.agent) holder.delete(e.cell);
    } else if (e.verb === "HOLD") out.holds++;
  }
  out.stillHeld = [...holder.entries()].map(([cell, agent]) => ({ cell, agent }));
  out.cells = out.cells.size;
  return out;
}

/** The cells one run used: goal/<run>, board/<run>, merge/<run>, task/<run>/..., file/<run>/... */
export const runCells = (run) => (cell) => {
  const [, rest = ""] = cell.split(/\/(.*)/s);
  return rest === run || rest.startsWith(run + "/");
};
