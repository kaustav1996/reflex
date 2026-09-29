import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const HOME = mkdtempSync(join(tmpdir(), "reflex-decisions-"));
process.env.REFLEX_HOME = HOME;
delete process.env.REFLEX_NO_CALL_LOG; // this suite is about what lands on disk
const { clearDecisions, decisionLogPath, decisionLogStats, logDecision, logOutcome, readDecisions } = await import("../src/logs/decisions.ts");
const { confidenceBand } = await import("../src/extensions/typesafe/policy.ts");

test("a decision records the numbers, the threshold each was compared against, and the primitive", () => {
	clearDecisions();
	const id = logDecision({
		source: "gate",
		model: "jev-1.13.0",
		qhash: "abc123abc123",
		action: "ask",
		rule: "destructive-over-threshold",
		band: confidenceBand(0.62),
		summary: "bash: rm -rf build",
		signals: {
			destructive: { primitive: "noul", value: 0.82, threshold: 0.35 },
			risk: { primitive: "score", value: 1.8, confidence: 0.62, threshold: 1.5 },
		},
	});
	const [d] = readDecisions();
	assert.equal(d.id, id);
	assert.equal(d.action, "ask");
	assert.equal(d.model, "jev-1.13.0", "the version that answered, so a model change is visible");
	assert.equal(d.qhash, "abc123abc123", "and the wording it answered");
	assert.equal(d.band, "likely");
	assert.equal(d.signals.destructive.primitive, "noul");
	assert.equal(d.signals.destructive.threshold, 0.35, "the cut-off travels with the number, so it can be replayed");
	assert.equal(d.signals.risk.primitive, "score", "a score is never compared with a noul");
	assert.equal(d.outcome, undefined, "an outcome arrives later, if at all");
});

test("an outcome is a separate line, folded in on read", () => {
	clearDecisions();
	const id = logDecision({ source: "gate", action: "ask", summary: "bash: git push --force", signals: { destructive: { primitive: "noul", value: 0.7 } } });
	logOutcome(id, "user-allowed", "said it was their own branch");
	const [d] = readDecisions();
	assert.equal(d.outcome?.label, "user-allowed");
	assert.equal(d.outcome?.note, "said it was their own branch");
	// Appended, never rewritten: other Reflex processes write to the same file.
	const lines = readFileSync(decisionLogPath(), "utf8").trim().split("\n");
	assert.equal(lines.length, 2);
	assert.match(lines[0], /"t":"d"/);
	assert.match(lines[1], /"t":"o"/);
	assert.deepEqual(decisionLogStats().decisions, 1);
	assert.deepEqual(decisionLogStats().outcomes, 1);
	logOutcome(undefined, "ignored");
	assert.equal(readFileSync(decisionLogPath(), "utf8").trim().split("\n").length, 2, "an outcome for nothing is dropped");
});

test("reading filters by source and by whether an outcome came back", () => {
	clearDecisions();
	const asked = logDecision({ source: "gate", action: "ask", summary: "a", signals: {} });
	logDecision({ source: "route", action: "switch:strong", summary: "b", signals: {} });
	logDecision({ source: "screen", action: "mark:data", summary: "c", signals: {} });
	logOutcome(asked, "user-denied");

	assert.deepEqual(readDecisions({ sources: ["gate"] }).map((d) => d.summary), ["a"]);
	assert.deepEqual(readDecisions({ sources: ["route", "screen"] }).map((d) => d.summary), ["b", "c"]);
	assert.deepEqual(readDecisions({ withOutcome: true }).map((d) => d.outcome?.label), ["user-denied"]);
	assert.equal(readDecisions({ limit: 2 }).length, 2);
	assert.equal(readDecisions({ since: Date.now() + 1000 }).length, 0);
});

test("bands are only for grouping, and match the cuts the layer already uses", () => {
	assert.equal(confidenceBand(0.2), "unsure");
	assert.equal(confidenceBand(0.5), "likely");
	assert.equal(confidenceBand(0.79), "likely");
	assert.equal(confidenceBand(0.8), "confident");
});
