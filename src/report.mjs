// The final report: what was asked, what got done, by whom, at what cost, and
// the receipts that prove no two workers held the same thing at once.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const usd = (x) => (x === null || x === undefined ? "n/a" : "$" + Number(x).toFixed(2));

export function writeReport({ runDir, board: b, cfg, receipts, diffstat, o }) {
  const count = (s) => b.tasks.filter((t) => t.status === s).length;
  const lines = [];
  lines.push(`# cascade-swarm run ${b.run}`, "");
  lines.push(`**Goal:** ${b.goal}`, "");
  lines.push(`**Result:** ${b.done ? "DONE" : "NOT DONE"}${b.done ? ` (${b.doneNote || (b.check ? `\`${b.check}\` passed` : "nothing left to do")})` : ` (${b.stopReason || "stopped"})`}`, "");
  lines.push("| | |", "|---|---|");
  lines.push(`| Check | ${b.check ? "`" + esc(b.check) + "`" : "none"} |`);
  if (b.finalCheck) lines.push(`| Final check on \`${b.integration}\` | ${b.finalCheck.pass ? "passes" : `fails (exit ${b.finalCheck.code})`} |`);
  lines.push(`| Workers | ${cfg.agents} x ${cfg.workerType}${cfg.model ? ` (${cfg.model})` : ""} |`);
  lines.push(`| Tasks | ${count("done")} done, ${count("failed")} failed, ${count("open") + count("active")} unfinished, ${b.tasks.length} total |`);
  lines.push(`| Spend | ${usd(b.budget.spent)} of a ${usd(b.budget.cap)} cap${b.budget.chargedForDeadWorkers ? `, including ${usd(b.budget.chargedForDeadWorkers)} charged in full for sessions cut off when their worker died` : ""}${cfg.workerType === "codex" ? " (Codex does not report dollars)" : ""} |`);
  lines.push(`| Branch | \`${b.integration}\` from \`${String(b.base).slice(0, 8)}\`${diffstat ? `: ${diffstat}` : ""} |`);
  lines.push(`| Started / finished | ${b.created} / ${b.finishedAt || ""} |`, "");

  lines.push("## Tasks", "");
  lines.push("| id | task | status | by | attempts | cost | commit | claim receipt | merge receipt |", "|---|---|---|---|---|---|---|---|---|");
  for (const t of b.tasks) {
    lines.push(`| ${t.id} | ${esc(t.title).slice(0, 140)} | ${t.status}${t.escalated ? " (escalated)" : ""} | ${t.by || ""} | ${t.attempts} | ${usd(t.cost)} | ${t.commit ? t.commit.slice(0, 8) : ""} | ${t.claimReceipt || ""} | ${t.mergeReceipt || ""} |`);
  }
  const notes = b.tasks.filter((t) => t.history.some((h) => h.result !== "merged" && h.result !== "no changes") || t.summary);
  if (notes.length) {
    lines.push("", "### What happened", "");
    for (const t of notes) {
      lines.push(`- **${t.id}**${t.summary ? `: ${esc(t.summary)}` : ""}`);
      for (const h of t.history) if (h.result !== "merged" && h.result !== "no changes") lines.push(`  - ${h.at} ${h.agent}: ${h.result}${h.why ? ` (${esc(h.why).slice(0, 200)})` : ""}`);
    }
  }

  lines.push("", "## Workers", "", "| agent | tasks done | agent sessions | spend |", "|---|---|---|---|");
  for (const [a, s] of Object.entries(b.agents)) if (s.calls || s.tasks) lines.push(`| ${a} | ${s.tasks} | ${s.calls} | ${usd(s.spent)}${s.tokens ? ` (${s.tokens} tokens)` : ""} |`);
  for (const e of b.workerEvents || []) lines.push(`- ${e.at} ${e.ev}: ${e.agent}${e.replaces ? ` replaces ${e.replaces}` : ""}${e.code !== undefined ? ` (exit ${e.code}${e.signal ? ", " + e.signal : ""})` : ""}`);

  lines.push("", "## Checks", "");
  for (const k of b.checks) lines.push(`- ${k.at} after ${k.after} by ${k.by}: ${k.pass ? "PASS" : `fail (exit ${k.code})`}${k.receipt ? ` · receipt ${k.receipt}` : ""}`);

  lines.push("", "## Receipts", "");
  if (receipts) {
    lines.push(`Every claim and release in this run is a signed entry in your Cascade chain, saved in \`receipts.json\` (the full bundle, verifiable offline).`, "");
    lines.push(`- cells used: ${receipts.cells}`);
    lines.push(`- grants: ${receipts.grants} (plus ${receipts.renewals} renewals), holds: ${receipts.holds}, releases: ${receipts.releases} (${receipts.expired} by expiry)`);
    lines.push(`- **duplicate holders: ${receipts.duplicateHolders.length}**${receipts.duplicateHolders.length ? " " + JSON.stringify(receipts.duplicateHolders) : ""}`);
    lines.push(`- release outcomes: ${Object.entries(receipts.outcomes).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
    lines.push(`- chain head: ${receipts.chainHead} (${receipts.chainLength} entries in the bundle)`);
  } else lines.push("The receipt bundle could not be downloaded.");

  lines.push("", "## Next steps", "");
  if (b.tasks.some((t) => t.commit)) {
    lines.push("```", `git diff ${String(b.base).slice(0, 8)}...${b.integration}   # review`, `git merge ${b.integration}                  # apply`, `git branch -D ${b.integration}              # or throw it away`, "```");
  } else lines.push("Nothing was merged.");
  lines.push("");

  const md = join(runDir, "REPORT.md");
  writeFileSync(md, lines.join("\n"));
  writeFileSync(join(runDir, "report.json"), JSON.stringify({ board: b, receipts, options: { ...o } }, null, 2));
  return md;
}
