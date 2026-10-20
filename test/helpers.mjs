// Test plumbing: a LOCAL Cascade API on a private port with a throwaway state
// dir (never the shared build record on :18800), fixture repos, and a runner.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const BIN = join(HERE, "..", "bin", "cascade-swarm.mjs");
export const FAKE = join(HERE, "fake-agent.mjs");
export const KEY = "csc_test_localdev";
// Path to a local Cascade API's server.mjs. Without it the end-to-end tests skip.
export const SERVER = process.env.CASCADE_SERVER || "";
// Optional: cascade-verify's CLI, to check each run's receipt bundle offline.
export const VERIFY = process.env.CASCADE_VERIFY || "";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startServer() {
  if (!SERVER || !existsSync(SERVER)) throw new Error(`CASCADE_SERVER must point at a local Cascade API server.mjs (got "${SERVER}")`);
  const port = 18000 + Math.floor(Math.random() * 700) + 900;   // anywhere but :18800
  const stateDir = mkdtempSync(join(tmpdir(), "cswarm-api-"));
  const proc = spawn(process.execPath, [SERVER], {
    cwd: dirname(SERVER),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", CASCADE_STATE_DIR: stateDir, CASCADE_NO_LEASE: "1", CASCADE_PROD: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stderr.on("data", (d) => (log += d));
  await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error("server did not start:\n" + log)), 20000);
    proc.stdout.on("data", (d) => { log += d; if (String(d).includes("claim API on")) { clearTimeout(t); ok(); } });
    proc.on("exit", (c) => fail(new Error(`server exited ${c}:\n${log}`)));
  });
  return { api: `http://127.0.0.1:${port}/v1`, stop() { proc.kill(); try { rmSync(stateDir, { recursive: true, force: true }); } catch {} } };
}

const g = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const gitOut = g;

/** A tiny repo: src/<name>.txt files that say BROKEN, and check.mjs that fails
 *  (printing MISSING <file>) until every one of them says FIXED. */
export function fixtureRepo(files = ["a", "b", "c"], extra = {}) {
  const repo = mkdtempSync(join(tmpdir(), "cswarm-repo-"));
  mkdirSync(join(repo, "src"));
  for (const f of files) writeFileSync(join(repo, "src", f + ".txt"), "BROKEN\n");
  for (const [p, s] of Object.entries(extra)) writeFileSync(join(repo, p), s);
  writeFileSync(join(repo, "check.mjs"), `import { readdirSync, readFileSync } from "node:fs";
let bad = 0;
for (const f of readdirSync("src")) if (readFileSync("src/" + f, "utf8").includes("BROKEN")) { console.log("MISSING src/" + f); bad++; }
console.log(bad ? bad + " file(s) still broken" : "all fixed");
process.exit(bad ? 1 : 0);
`);
  g(repo, "init", "-q", "-b", "main");
  g(repo, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  g(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "fixture");
  return repo;
}

/** Run the CLI against a repo with the fake agent. Resolves when it exits;
 *  `during(ctx)` runs alongside it (ctx.runDir appears once the run starts). */
export function runSwarm(repo, args, { api, env = {}, during } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], {
      cwd: repo,
      env: { ...process.env, CASCADE_API: api, CASCADE_API_KEY: KEY, CASCADE_SWARM_MIN_CALL_USD: "0.0001", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ctx = { out: "", runDir: null, proc: p };
    const onData = (d) => {
      ctx.out += d;
      const m = ctx.out.match(/cascade-swarm run (\w+):/);
      if (m && !ctx.runDir) ctx.runDir = join(repo, ".cascade-swarm", "runs", m[1]);
    };
    p.stdout.on("data", onData); p.stderr.on("data", onData);
    const extra = during ? during(ctx).catch((e) => { ctx.duringError = e; }) : Promise.resolve();
    p.on("exit", async (code) => {
      await extra;
      const read = (f) => { try { return JSON.parse(readFileSync(join(ctx.runDir, f), "utf8")); } catch { return null; } };
      resolve({
        code, out: ctx.out, runDir: ctx.runDir, duringError: ctx.duringError,
        board: ctx.runDir && read("board.json"),
        bundle: ctx.runDir && read("receipts.json"),
        report: ctx.runDir && existsSync(join(ctx.runDir, "REPORT.md")) ? readFileSync(join(ctx.runDir, "REPORT.md"), "utf8") : "",
      });
    });
  });
}

export const fakeArgs = (goal, extra = []) => [goal, "--worker", "command", "--worker-cmd", `"${process.execPath}" "${FAKE}"`, "--check", "node check.mjs", ...extra];

export async function waitFor(fn, ms = 30000, every = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(every);
  }
}

export function verifyBundle(path) {
  if (!VERIFY || !existsSync(VERIFY)) return { skipped: "set CASCADE_VERIFY to check bundles offline" };
  try { return { code: 0, out: execFileSync(process.execPath, [VERIFY, path], { encoding: "utf8" }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; }
}
