import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.REFLEX_HOME = mkdtempSync(join(tmpdir(), "reflex-climb-test-"));
process.env.REFLEX_NO_CALL_LOG = "1";
const { climbReport, decideRound, findLeaks, failureBrief, hillclimb } = await import("../src/evals/hillclimb.ts");
const { validateSpec } = await import("../src/evals/spec.ts");
const { runEval, splitOf } = await import("../src/evals/project.ts");

const report = (train: number, test_: number, all = (train + test_) / 2) =>
	({ name: "x", results: [], score: { all, train, test: test_ }, interval: [0, 1], errors: 0 }) as never;

test("the keep/revert rule is the whole policy, and it favours the held-out set", () => {
	const noise = 0.02;
	assert.equal(decideRound(report(0.5, 0.5), report(0.6, 0.6), noise).keep, true, "both up: keep");
	assert.equal(decideRound(report(0.5, 0.5), report(0.4, 0.5), noise).keep, false, "train down: revert");
	assert.equal(decideRound(report(0.5, 0.5), report(0.7, 0.4), noise).keep, false, "held-out down: revert whatever train did");

	// The one the whole exercise exists for.
	const overfit = decideRound(report(0.5, 0.5), report(0.8, 0.5), noise);
	assert.equal(overfit.keep, false);
	assert.match(overfit.reason, /overfitting/);

	// Smaller than the noise floor is not a result.
	const tiny = decideRound(report(0.5, 0.5), report(0.51, 0.51), 0.05);
	assert.equal(tiny.keep, false);
	assert.match(tiny.reason, /noise floor/);
});

test("case text copied into a surface is caught, including held-out cases", () => {
	const cases = [
		{ id: "a", whyHard: "x", input: "the customer asked for a refund on order 11823 after the trial" },
		{ id: "b", whyHard: "x", input: "short" },
	];
	const leaked = findLeaks("Rule: if the customer asked for a refund on order 11823 after the trial, route to billing.", cases);
	assert.deepEqual(leaked.map((l) => l.id), ["a"]);
	assert.deepEqual(findLeaks("Route refund requests to billing.", cases), [], "a general rule is the point; it isn't a leak");
	assert.deepEqual(findLeaks("short", cases), [], "fragments too short to be a leak are ignored");
});

test("the brief shows train failures only, with the reason and the grader's objection, never the case text", () => {
	const spec = validateSpec({
		name: "t",
		run: { command: "echo hi" },
		grade: { kind: "exact" },
		cases: [
			{ id: "keep-train", whyHard: "a tricky refund phrasing", input: "SECRET-INPUT-TEXT" },
			{ id: "other", whyHard: "another", input: "x" },
		],
	});
	const r = {
		name: "t",
		results: [
			{ id: "keep-train", split: "train", pass: false, score: 0, output: "", detail: "expected billing, got support" },
			{ id: "held", split: "test", pass: false, score: 0, output: "", detail: "expected refunds" },
		],
		score: { all: 0, train: 0, test: 0 },
		interval: [0, 1],
		errors: 0,
	} as never;
	const brief = failureBrief(spec, r);
	assert.match(brief, /keep-train/);
	assert.match(brief, /a tricky refund phrasing/);
	assert.match(brief, /expected billing/);
	assert.doesNotMatch(brief, /SECRET-INPUT-TEXT/, "the case's own text is not handed to the proposer");
	assert.doesNotMatch(brief, /held/, "held-out failures are never shown");
});

test("a climb keeps a real gain, reverts a leak, and leaves the surface as it found it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "reflex-climb-run-"));
	const surface = join(dir, "rules.txt");
	writeFileSync(surface, "answer: no\n");
	// The system under test: it echoes whatever rules.txt says after "answer:".
	const runner = join(dir, "run.sh");
	writeFileSync(runner, `#!/bin/sh\nsed -n 's/^answer: //p' ${surface}\n`);
	const spec = validateSpec({
		name: "echo-rules",
		run: { command: `sh ${runner}` },
		grade: { kind: "exact", expect: "yes" },
		cases: Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, whyHard: "covers the only behaviour there is", input: `the customer asked for a refund on order 1182${i} after the trial ended` })),
	}, dir);
	assert.ok(spec.cases.some((c) => splitOf(c.id) === "test"), "the fixture needs a held-out case to be meaningful");

	const proposals = [
		() => writeFileSync(surface, "answer: yes\n"), // a real fix: helps every case
		() => writeFileSync(surface, "answer: yes\n# special-case: the customer asked for a refund on order 11823 after the trial ended\n"), // a leak
	];
	let n = 0;
	const result = await hillclimb(spec, {
		surfaces: [surface],
		rounds: 2,
		noise: 0.01,
		propose: async () => {
			proposals[n]?.();
			return `round ${++n}`;
		},
	});

	assert.equal(result.baseline.score.all, 0);
	assert.equal(result.rounds[0].decision.keep, true, result.rounds[0].decision.reason);
	assert.equal(result.best.score.all, 1);
	assert.equal(result.rounds[1].decision.keep, false);
	assert.match(result.rounds[1].decision.reason, /copied case text/);
	assert.equal(readFileSync(surface, "utf8"), "answer: yes\n", "the leaked patch was rolled back, the good one kept");
	assert.match(climbReport(result, 0.01), /held-out gain/i);
});

test("a gain inside the noise is reported as no evidence", () => {
	const result = { baseline: report(0.8, 0.8), best: report(0.81, 0.81), rounds: [], kept: 0 } as never;
	assert.match(climbReport(result, 0.05), /inside the noise floor/);
	assert.match(climbReport(result, 0.05), /Add cases or repeats/);
});
