import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.REFLEX_HOME = mkdtempSync(join(tmpdir(), "reflex-triage-"));
process.env.REFLEX_NO_CALL_LOG = "1";
const { loadReflexConfig } = await import("../src/config.ts");
const { ReflexState } = await import("../src/extensions/typesafe/state.ts");
const { isFailedCommand, noteFor, registerTriage, suggestInstall } = await import("../src/extensions/typesafe/triage.ts");
const { TRIAGE_MAX_REPEATS } = await import("../src/extensions/typesafe/policy.ts");

type Handler = (event: unknown, ctx?: unknown) => Promise<unknown>;

function setup(answer: { kind: string; confidence: number; repeat: number }) {
	const state = new ReflexState(loadReflexConfig());
	const asked: unknown[] = [];
	state.client = {
		systemOne: async (req: unknown) => {
			asked.push(req);
			return {
				answers: {
					kind: { type: "choice", choice: answer.kind, confidence: answer.confidence, probabilities: { [answer.kind]: answer.confidence } },
					repeat: { type: "noul", noul: answer.repeat },
				},
				latencyMs: 1,
			};
		},
	} as never;
	const handlers: Record<string, Handler> = {};
	const notices: string[] = [];
	registerTriage({ on: (e: string, h: Handler) => (handlers[e] = h) } as never, state);
	const fail = (text: string, command = "npm test") =>
		handlers.tool_result({ toolName: "bash", isError: true, input: { command }, content: [{ type: "text", text }] }, { hasUI: true, ui: { notify: (m: string) => notices.push(m) } }) as Promise<{ content: Array<{ text: string }> } | undefined>;
	return { state, fail, asked, notices, handlers };
}

const MISSING = "node:internal/modules/esm/resolve\nError: Cannot find module 'left-pad'\n    at resolve (node:internal/modules:275:11)";

test("only failed shell commands with real output are triaged", () => {
	assert.equal(isFailedCommand("bash", true, MISSING), true);
	assert.equal(isFailedCommand("bash", false, MISSING), false, "a command that succeeded has nothing to triage");
	assert.equal(isFailedCommand("read", true, MISSING), false, "a failed file read is not a command failure");
	assert.equal(isFailedCommand("bash", true, "exit 1"), false, "too short to say anything about");
});

test("a missing dependency is named and an install is proposed, never run", async () => {
	const s = setup({ kind: "missing_dependency", confidence: 0.92, repeat: 0.1 });
	const out = await s.fail(MISSING);
	const text = out!.content[0].text;
	assert.match(text, /isn't installed, not a bug in the code/);
	assert.match(text, /npm install left-pad/);
	assert.match(text, /Don't install anything without asking/, "proposing is the whole point: nothing runs by itself");
	assert.ok(text.includes(MISSING), "the output itself is untouched, the note sits above it");
});

test("what an install suggestion can be read from", () => {
	assert.equal(suggestInstall("Error: Cannot find module 'express'"), "npm install express");
	assert.equal(suggestInstall("ModuleNotFoundError: No module named 'requests'"), "pip install requests");
	assert.match(suggestInstall("bash: terraform: command not found") ?? "", /install terraform/);
	assert.equal(suggestInstall("AssertionError: expected 3 got 4"), undefined, "a real bug names nothing to install");
});

test("transient and environment failures get their own words; a real bug gets silence", async () => {
	assert.match((await setup({ kind: "transient", confidence: 0.8, repeat: 0.1 }).fail("Error: ETIMEDOUT connecting to registry.npmjs.org"))!.content[0].text, /One retry is reasonable/);
	assert.match((await setup({ kind: "environment", confidence: 0.8, repeat: 0.1 }).fail("Error: DATABASE_URL is not set, cannot connect"))!.content[0].text, /configuration or credentials rather than code/);
	// Most failures are ordinary bugs, and the model reads those as it always did.
	assert.equal(await setup({ kind: "real_bug", confidence: 0.95, repeat: 0.1 }).fail("FAIL parser.test.ts:42 expected 3 but got 4"), undefined);
	// An unsure category says nothing either, rather than guessing out loud.
	assert.equal(await setup({ kind: "missing_dependency", confidence: 0.4, repeat: 0.1 }).fail(MISSING), undefined);
});

test("the same failure three times stops the loop and tells the user", async () => {
	const s = setup({ kind: "real_bug", confidence: 0.95, repeat: 0.9 });
	assert.equal(await s.fail("FAIL parser.test.ts:42 expected 3 but got 4"), undefined, "once is just a failure");
	await s.fail("FAIL parser.test.ts:42 expected 3 but got 4 (again)");
	const third = await s.fail("FAIL parser.test.ts:42 still expected 3 but got 4");
	assert.equal(s.state.repeatedFailures, TRIAGE_MAX_REPEATS);
	assert.match(third!.content[0].text, /3th time the same failure/);
	assert.match(third!.content[0].text, /stop, say what you have established .* ask the user/s);
	assert.match(s.notices.at(-1) ?? "", /the agent has been told to stop and ask/);

	// A new request is a new problem.
	await s.handlers.input({});
	assert.equal(s.state.repeatedFailures, 0);
	assert.deepEqual(s.state.recentFailures, []);
});

test("a repeat note wins over the category note, because it is the more useful thing to say", () => {
	assert.match(noteFor("missing_dependency", MISSING, TRIAGE_MAX_REPEATS) ?? "", /same failure has come back/);
	assert.match(noteFor("missing_dependency", MISSING, 1) ?? "", /isn't installed/);
});
