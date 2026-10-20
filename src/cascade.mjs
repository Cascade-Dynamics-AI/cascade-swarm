// The Cascade API, as this tool uses it: claim, release, read the receipts.
// Cascade only ever sees cell names (goal/<run>, board/<run>, task/<run>/t3,
// merge/<run>, file/<path>) and agent ids. Never prompts, code or task titles.

export const DEFAULT_API = "https://api.cascadedynamics.ai/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CascadeError extends Error {}

export function client({ api = process.env.CASCADE_API || DEFAULT_API, key = process.env.CASCADE_API_KEY || "" } = {}) {
  api = api.replace(/\/+$/, "");
  const headers = { Authorization: "Bearer " + key, "Content-Type": "application/json", "User-Agent": "cascade-swarm/0.1" };

  async function call(method, path, body, timeoutMs = 20000) {
    for (let attempt = 0; ; attempt++) {
      let res, json = null;
      try {
        res = await fetch(api + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
        json = await res.json().catch(() => null);
      } catch (e) {
        // Network trouble: retry a few times, then fail CLOSED. With no referee
        // there is no safe way for two agents to share work, so the swarm stops.
        if (attempt < 5) { await sleep(300 * 2 ** attempt); continue; }
        throw new CascadeError(`could not reach ${api} (${e.message})`);
      }
      if (res.ok && json) return json;
      if ((res.status === 429 || res.status >= 500) && attempt < 5) { await sleep(300 * 2 ** attempt); continue; }
      throw new CascadeError(`Cascade ${method} ${path} -> HTTP ${res.status} ${json?.code ?? ""} ${json?.error ?? ""}`.trim());
    }
  }

  return {
    api,
    hasKey: !!key,
    /** -> { ok, entry_hash, fence } | { ok:false, hold:true, behind } */
    claim: (cell, agent, ttl_ms, wait_ms) => call("POST", "/claim", { cell, agent, ttl_ms, ...(wait_ms ? { wait_ms } : {}) }, (wait_ms || 0) + 20000),
    claimMany: (cells, agent, ttl_ms, wait_ms) => call("POST", "/claim", { cells, agent, ttl_ms, ...(wait_ms ? { wait_ms } : {}) }, (wait_ms || 0) + 20000),
    release: (cell, agent, outcome) => call("POST", "/release", { cell, agent, ...(outcome ? { outcome } : {}) }),
    usage: () => call("GET", "/usage"),
    bundle: () => call("GET", "/runs/current/bundle", undefined, 60000),
    /** Block until granted, using the free server-side long-poll. */
    async acquire(cell, agent, ttl_ms, { shouldStop = () => false, many = null } = {}) {
      for (;;) {
        const r = many ? await this.claimMany(many, agent, ttl_ms, 8000) : await this.claim(cell, agent, ttl_ms, 8000);
        if (r.ok) return r;
        if (shouldStop()) return null;
        await sleep(50 + Math.random() * 100);
      }
    },
  };
}
