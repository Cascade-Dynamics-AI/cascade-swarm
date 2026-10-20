#!/usr/bin/env node
// One REAL run with Claude Code: 2 workers on a tiny repo with two broken
// functions, capped at $2. Not part of `npm test` (it spends money).
//   node test/real-claude.mjs            needs `claude` signed in (or ANTHROPIC_API_KEY)
// Coordinates through a LOCAL Cascade API (CASCADE_SERVER), like the other tests.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, runSwarm } from "./helpers.mjs";

const repo = mkdtempSync(join(tmpdir(), "cswarm-real-"));
mkdirSync(join(repo, "src")); mkdirSync(join(repo, "test"));
writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" } }, null, 2));
writeFileSync(join(repo, "src", "math.mjs"), "export function add(a, b) {\n  return a - b;\n}\n");
writeFileSync(join(repo, "src", "words.mjs"), "export function capitalize(s) {\n  return s.toLowerCase();\n}\n");
writeFileSync(join(repo, "test", "math.test.mjs"), `import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/math.mjs";
test("add", () => { assert.equal(add(2, 3), 5); });
`);
writeFileSync(join(repo, "test", "words.test.mjs"), `import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalize } from "../src/words.mjs";
test("capitalize", () => { assert.equal(capitalize("hello"), "Hello"); });
`);
const g = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
g("init", "-q", "-b", "main"); g("add", "-A"); g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "fixture with two bugs");

const server = await startServer();
console.log(`fixture: ${repo}\nlocal Cascade API: ${server.api}\n`);
const r = await runSwarm(repo, ["make the failing tests pass", "--agents", "2", "--check", "node --test", "--max-cost", "2", "--max-cost-per-call", "0.75",
  ...(process.env.REAL_MODEL ? ["--model", process.env.REAL_MODEL] : [])], { api: server.api, env: { CASCADE_SWARM_MIN_CALL_USD: "" } });
server.stop();
console.log(r.out);
console.log("==== REPORT.md\n" + r.report);
process.exit(r.code);
