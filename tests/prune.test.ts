import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.REFLEX_HOME = mkdtempSync(join(tmpdir(), "reflex-prune-"));
process.env.REFLEX_NO_CALL_LOG = "1";
const { applyPrune, contextChars, KEEP_RECENT_RESULTS, MIN_RESULT_CHARS, reconstruct, selectCandidates } = await import("../src/extensions/typesafe/prune.ts");

const text = (t: string) => [{ type: "text", text: t }];
const user = (t: string) => ({ role: "user", content: text(t) });
const assistant = (t: string) => ({ role: "assistant", content: text(t) });
const result = (id: string, tool: string, chars: number) => ({ role: "toolResult", toolCallId: id, toolName: tool, content: text("x".repeat(chars)) });

/** A session: a request, some work, and ten tool results of varying size. */
const session = () => [
	user("fix the failing parser test"),
	assistant("I'll look at the test output."),
	...Array.from({ length: 10 }, (_, i) => result(`t${i}`, i % 2 ? "bash" : "read", 400 + i * 300)),
	user("now also update the README"),
	assistant("Done."),
];

test("only old, large tool results are candidates; messages never are", () => {
	const messages = session();
	const picked = selectCandidates(messages);
	assert.ok(picked.length > 0);
	assert.ok(picked.every((c) => c.toolCallId.startsWith("t")), "only tool results");
	// The most recent results belong to the work in progress.
	const recent = new Set(["t9", "t8", "t7", "t6", "t5", "t4"].slice(0, KEEP_RECENT_RESULTS));
	assert.ok(picked.every((c) => !recent.has(c.toolCallId)), "the newest results are left alone");
	assert.ok(picked.every((c) => c.chars >= MIN_RESULT_CHARS), "small results free nothing");
	// Biggest first, so the cap keeps the candidates that matter.
	assert.deepEqual([...picked].sort((a, b) => b.chars - a.chars).map((c) => c.toolCallId), picked.map((c) => c.toolCallId));
	assert.deepEqual(selectCandidates(messages, { already: new Set(picked.map((c) => c.toolCallId)) }), [], "a judged result is not re-judged");
});

test("pruning replaces output with a marker, keeps every message, and frees real characters", () => {
	const messages = session();
	const before = contextChars(messages);
	const pruned = applyPrune(messages, new Set(["t0", "t2"]));
	assert.equal(pruned.dropped, 2);
	assert.ok(pruned.charsFreed > 0);
	assert.equal(contextChars(pruned.messages), before - pruned.charsFreed);
	assert.equal(pruned.messages.length, messages.length, "nothing is removed, only emptied");
	assert.deepEqual(pruned.messages.filter((m) => m.role === "user"), messages.filter((m) => m.role === "user"), "user turns are untouched");
	assert.deepEqual(pruned.messages.filter((m) => m.role === "assistant"), messages.filter((m) => m.role === "assistant"), "assistant turns are untouched");
	const marker = pruned.messages.find((m) => m.toolCallId === "t0");
	assert.match((marker!.content as Array<{ text: string }>)[0].text, /pruned from this request .* run the command again/s);
});

test("a result smaller than its own marker is left alone", () => {
	const tiny = [result("small", "bash", 20)];
	const out = applyPrune(tiny, new Set(["small"]));
	assert.equal(out.dropped, 0, "replacing 20 characters with a 180-character marker is not a saving");
	assert.equal(out.charsFreed, 0);
});

test("the rebuilt transcript is verbatim: no paraphrase, and the exact words survive", () => {
	const messages = [
		user("deploy the staging service, the token is in .env.staging"),
		assistant("Checking the deploy script first."),
		result("t1", "read", 3000),
		user("what was that path again?"),
	];
	const out = reconstruct(messages);
	assert.match(out, /deploy the staging service, the token is in \.env\.staging/, "the user's exact words");
	assert.match(out, /Checking the deploy script first\./, "the assistant's exact words");
	assert.match(out, /what was that path again\?/);
	assert.match(out, /\[\d+ more characters pruned\]/, "long output is cut, not described");
	assert.match(out, /Nothing below is a summary/);
	assert.ok(out.length < contextChars(messages), "and it is smaller than what it replaces");
});
