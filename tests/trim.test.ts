import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.REFLEX_HOME = mkdtempSync(join(tmpdir(), "reflex-trim-"));
process.env.REFLEX_NO_CALL_LOG = "1";
const { ALWAYS_KEEP, applyTrim, approxTokens, KEEP_HEAD, KEEP_TAIL, planTrim, TRIM_MIN_CHARS } = await import("../src/extensions/typesafe/trim.ts");
const { trimmable } = await import("../src/extensions/typesafe/trimmer.ts");

const noisy = (n: number, prefix = "downloading package") => Array.from({ length: n }, (_, i) => `${prefix} ${i} ... ok`);
const long = (needleAt?: number, needle = "FAIL: parser.test.ts:42 expected 3 got 4") => {
	const lines = noisy(400);
	if (needleAt !== undefined) lines[needleAt] = needle;
	return ["$ npm test", ...lines, "", "2 passing, 1 failing"].join("\n");
};

test("short output is left alone: the call would cost more than it saves", () => {
	assert.equal(planTrim("hello\nworld").skip, true);
	assert.equal(planTrim("x".repeat(TRIM_MIN_CHARS - 1)).skip, true);
	const manyShortLines = Array.from({ length: 500 }, () => "x").join("\n");
	assert.equal(planTrim(manyShortLines).skip, true, "500 one-character lines are not worth a Jev call");
});

test("the head, the tail and anything that looks like a failure survive a drop-everything verdict", () => {
	const text = long(200);
	const plan = planTrim(text);
	assert.equal(plan.skip, false);
	assert.ok(plan.chunks.length > 1);
	// The worst case: Jev says nothing is needed.
	const out = applyTrim(text, plan, () => false, "/tmp/full.txt");
	assert.match(out.text, /^\$ npm test/, "the command stays");
	assert.match(out.text, /2 passing, 1 failing$/, "the summary line stays");
	assert.match(out.text, /FAIL: parser\.test\.ts:42/, "the failure survives even when the chunk was not wanted");
	assert.match(out.text, /\[reflex: \d+ lines trimmed \(\d+–\d+\); full output: \/tmp\/full\.txt\]/, "the marker says what went and where to find it");
	assert.ok(out.droppedLines > 200, `only ${out.droppedLines} lines dropped`);
	assert.ok(approxTokens(text) - approxTokens(out.text) > 500, "the point is the tokens");
});

test("a chunk holding a needle is pinned, so no answer can drop it", () => {
	const plan = planTrim(long(200));
	const pinned = plan.chunks.filter((c) => c.pinned);
	assert.equal(pinned.length, 1);
	assert.match(pinned[0].text, /FAIL:/);
	// Pinned chunks are never even asked about, so they cost nothing either.
	assert.ok(plan.chunks.some((c) => !c.pinned), "and the rest still get judged");
});

test("what counts as a needle", () => {
	for (const line of ["error: cannot find module", "Build FAILED", "Traceback (most recent call last):", "  at run (/app/x.ts:10:3)", "+ added line", "- removed line", "connection refused", "fatal: not a git repository"]) {
		assert.ok(ALWAYS_KEEP.test(line), `should be kept: ${line}`);
	}
	for (const line of ["downloading package 12 ... ok", "  3 files changed", "Compiled successfully"]) {
		assert.equal(ALWAYS_KEEP.test(line), false, `should be droppable: ${line}`);
	}
});

test("keeping everything changes nothing, and the line budget adds up", () => {
	const text = long();
	const plan = planTrim(text);
	const kept = applyTrim(text, plan, () => true);
	assert.equal(kept.droppedLines, 0);
	assert.equal(kept.text, text, "a keep-everything verdict returns the output untouched");

	const dropped = applyTrim(text, plan, () => false);
	const middle = plan.totalLines - KEEP_HEAD - KEEP_TAIL;
	assert.equal(dropped.droppedLines + plan.chunks.filter((c) => c.pinned).reduce((n, c) => n + (c.to - c.from + 1), 0), middle, "every middle line is either dropped or pinned");
});

test("only tools that produce long repetitive output are trimmed", () => {
	assert.equal(trimmable("bash"), true);
	assert.equal(trimmable("read"), true);
	assert.equal(trimmable("atlassian__getJiraIssue"), true);
	assert.equal(trimmable("edit"), false, "an edit's result is a confirmation, not a log");
	assert.equal(trimmable("write"), false);
});
