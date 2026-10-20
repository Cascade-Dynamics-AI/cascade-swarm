// Thin git wrappers. Every worker gets its own worktree and branch; finished
// work is merged into the run's integration branch while holding merge/<run>.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";

export function git(cwd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const out = { code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) };
      if (err && !allowFail) reject(new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr || err.message}`));
      else resolve(out);
    });
  });
}

export const head = async (cwd) => (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();

/** Point a worker's worktree at the integration tip, discarding its scratch state. */
export async function syncWorktree(wt, branch, integration) {
  await git(wt, ["checkout", "-q", "-B", branch, integration]);
  await git(wt, ["reset", "-q", "--hard", integration]);
  await git(wt, ["clean", "-q", "-fd"]);
}

/** Commit everything the agent changed. -> sha, or null when nothing changed. */
export async function commitAll(wt, message) {
  await git(wt, ["add", "-A"]);
  const st = await git(wt, ["diff", "--cached", "--quiet"], { allowFail: true });
  if (st.code === 0) return null;
  await git(wt, ["-c", "user.name=cascade-swarm", "-c", "user.email=cascade-swarm@localhost", "commit", "-q", "--no-verify", "-m", message]);
  return head(wt);
}

/** Merge a worker branch into the integration worktree. -> { ok, sha } | { ok:false, conflict } */
export async function mergeInto(mainWt, branch, message) {
  const r = await git(mainWt, ["-c", "user.name=cascade-swarm", "-c", "user.email=cascade-swarm@localhost", "merge", "--no-ff", "--no-edit", "-m", message, branch], { allowFail: true });
  if (r.code === 0) return { ok: true, sha: await head(mainWt) };
  const files = (await git(mainWt, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true })).stdout.trim().split("\n").filter(Boolean);
  await git(mainWt, ["merge", "--abort"], { allowFail: true });
  return { ok: false, conflict: files.length ? files : [(r.stderr || r.stdout).trim().slice(0, 300)] };
}

export const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");

/** Run the user's check command in a directory. Fail-closed: a check that
 *  cannot start, times out or is killed counts as FAILING, never passing. */
export function runCheck(cmd, cwd, { timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = "";
    let p;
    try { p = spawn(cmd, { cwd, shell: true, windowsHide: true, env: { ...process.env, CI: process.env.CI || "1" } }); }
    catch (e) { return resolve({ pass: false, code: null, tail: `could not start check: ${e.message}`, ms: 0 }); }
    const add = (d) => { out += d; if (out.length > 200000) out = out.slice(-100000); };
    p.stdout.on("data", add); p.stderr.on("data", add);
    const t = setTimeout(() => { out += `\n[cascade-swarm] check timed out after ${timeoutMs} ms`; killTree(p.pid); }, timeoutMs);
    p.on("error", (e) => { out += `\n[cascade-swarm] check error: ${e.message}`; });
    p.on("close", (code) => { clearTimeout(t); resolve({ pass: code === 0, code, tail: out.slice(-4000), ms: Date.now() - started }); });
  });
}

/** Kill a process and its children (agents spawn shells, test runners, ...). */
export function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else { try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); } }
  } catch {}
}
