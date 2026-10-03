import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.REFLEX_HOME = mkdtempSync(join(tmpdir(), "reflex-filehints-"));
process.env.REFLEX_NO_CALL_LOG = "1";
const { loadReflexConfig } = await import("../src/config.ts");
const { ReflexState } = await import("../src/extensions/typesafe/state.ts");
const { FILE_HINT_THRESHOLD, namesAFile, pickFile, shortlistFiles } = await import("../src/extensions/typesafe/files.ts");
const { fileHint } = await import("../src/extensions/typesafe/filehints.ts");

const REPO = [
	"src/extensions/typesafe/router.ts",
	"src/extensions/typesafe/selector.ts",
	"src/extensions/typesafe/policy.ts",
	"src/agents/runner.ts",
	"src/agents/store.ts",
	"src/web/server.ts",
	"web/app.html",
	"README.md",
];

test("a request that already names a file needs no help finding one", () => {
	assert.equal(namesAFile("fix the bug in src/agents/runner.ts", REPO), true);
	assert.equal(namesAFile("why does runner.ts hang?", REPO), true, "the bare filename counts");
	assert.equal(namesAFile("update app.html", REPO), true);
	assert.equal(namesAFile("make the router stop switching models mid-session", REPO), false);
});

test("the shortlist ranks on the file's own name more than the folders above it", () => {
	const picked = shortlistFiles(REPO, "the model router keeps switching models", 4);
	assert.equal(picked[0], "src/extensions/typesafe/router.ts");
	assert.deepEqual(shortlistFiles(REPO, "completely unrelated words here", 4), [], "no overlap means no candidates, and no call");
});

test("only a confident, real choice is named", () => {
	const shortlist = ["src/agents/runner.ts", "src/agents/store.ts"];
	assert.deepEqual(pickFile({ choice: "src/agents/runner.ts", probabilities: { "src/agents/runner.ts": 0.8 }, confidence: 0.8 }, shortlist), { file: "src/agents/runner.ts", score: 0.8 });
	assert.equal(pickFile({ choice: "none", confidence: 0.9 }, shortlist), undefined, "none is an answer, not a file");
	assert.equal(pickFile({ choice: "src/agents/runner.ts", probabilities: { "src/agents/runner.ts": 0.5 }, confidence: 0.5 }, shortlist), undefined, "a coin flip anchors the model on the wrong file");
	assert.equal(pickFile({ choice: "src/made/up.ts", confidence: 0.99 }, shortlist), undefined, "a file that wasn't offered is never named");
	assert.ok(FILE_HINT_THRESHOLD >= 0.6, "measured: below this the pick is about a coin flip");
});

test("it stays off unless asked for, and silent when it has nothing to add", async () => {
	const state = new ReflexState(loadReflexConfig());
	let called = false;
	state.client = { systemOne: async () => ((called = true), { answers: { where: { type: "choice", choice: "README.md", confidence: 0.9, probabilities: { "README.md": 0.9 } } }, latencyMs: 1 }) } as never;

	// Default is off: the measurement didn't justify an always-on hint.
	assert.equal(state.config.reflex.fileHints, undefined);
	assert.equal(await fileHint(state, "make the router stop switching models", process.cwd()), "");
	assert.equal(called, false, "and nothing is asked while it is off");

	state.config.reflex.fileHints = true;
	assert.equal(await fileHint(state, "fix it", "/nonexistent-repo-path"), "", "no repo, nothing to say");
	assert.equal(called, false);
});
