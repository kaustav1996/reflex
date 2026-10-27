import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.REFLEX_HOME = mkdtempSync(join(tmpdir(), "reflex-gate-fallback-"));
process.env.REFLEX_NO_CALL_LOG = "1";
const { loadReflexConfig } = await import("../src/config.ts");
const { ReflexState } = await import("../src/extensions/typesafe/state.ts");
const { describeAction, registerGate, sessionKey } = await import("../src/extensions/typesafe/gate.ts");

type Handler = (event: unknown, ctx: unknown) => Promise<{ block: boolean; reason?: string } | undefined>;
type JevMode = "missing client" | "service error" | "timeout";

function setup(mode: JevMode, hasUI = false, choice = "Deny") {
	const state = new ReflexState(loadReflexConfig());
	const requests: unknown[] = [];
	state.client = mode === "missing client" ? undefined : {
		systemOne: async (req: unknown) => {
			requests.push(req);
			throw new Error(mode === "timeout" ? "TypeSafe request timed out after 4000ms" : "TypeSafe HTTP 500");
		},
	} as never;
	const handlers: Record<string, Handler> = {};
	const prompts: string[] = [];
	const ctx = {
		cwd: process.cwd(), hasUI,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus() {},
			select: async (prompt: string) => {
				assert.ok(hasUI, "headless runs must not prompt");
				prompts.push(prompt);
				return choice;
			},
		},
	};
	registerGate({ on: (event: string, h: Handler) => (handlers[event] = h) } as never, state);
	const call = (toolName: string, input: Record<string, unknown>) => handlers.tool_call({ toolName, input }, ctx);
	return { state, ctx, call, prompts, requests };
}

const actions = [
	{ tool: "write", input: { path: "src/example.ts", content: "updated" } },
	{ tool: "edit", input: { path: "src/example.ts", edits: [{ oldText: "before", newText: "after" }] } },
	{ tool: "bash", input: { command: "npm install example-package" } },
];

for (const mode of ["missing client", "service error", "timeout"] as const) {
	for (const { tool, input } of actions) {
		test(`${mode}: an unapproved ${tool} blocks without a UI`, async () => {
			const s = setup(mode);
			const out = await s.call(tool, input);
			assert.equal(out?.block, true);
			assert.match(out?.reason ?? "", /confirmation required/);
			assert.match(out?.reason ?? "", mode === "missing client" ? /cannot reach Jev/ : mode === "timeout" ? /timed out/ : /HTTP 500/);
			assert.equal(s.state.gate.blocked, 1);
			assert.equal(s.state.gate.allowed, 0);
			assert.equal(s.prompts.length, 0);
			assert.equal(s.requests.length, mode === "missing client" ? 0 : 1);
		});

		test(`${mode}: an unapproved ${tool} asks and respects denial`, async () => {
			const s = setup(mode, true);
			const out = await s.call(tool, input);
			assert.equal(s.prompts.length, 1);
			assert.match(s.prompts[0], /confirmation required/);
			assert.equal(out?.block, true);
			assert.match(out?.reason ?? "", /User denied/);
			assert.equal(s.state.gate.asked, 1);
			assert.equal(s.state.gate.userDenied, 1);
		});
	}

	test(`${mode}: allowing once does not approve the next call`, async () => {
		const s = setup(mode, true, "Allow once");
		for (let i = 0; i < 2; i++) assert.equal(await s.call("write", actions[0].input), undefined);
		assert.equal(s.prompts.length, 2);
		assert.equal(s.state.gate.userAllowed, 2);
		assert.equal(s.state.sessionAllow.size, 0);
	});

	test(`${mode}: an exact session approval skips the next call`, async () => {
		const s = setup(mode, true, "Allow this exact action for the session");
		for (let i = 0; i < 2; i++) assert.equal(await s.call("write", actions[0].input), undefined);
		assert.equal(s.prompts.length, 1);
		assert.equal(s.state.sessionAllow.size, 1);
		assert.equal(s.state.gate.skipped, 1);
		assert.equal(s.requests.length, mode === "missing client" ? 0 : 1);
	});

	test(`${mode}: existing exact and scoped session allowances still bypass the gate`, async () => {
		for (const key of [sessionKey(describeAction("write", actions[0].input, process.cwd())), "files-dir:src"]) {
			const s = setup(mode);
			s.state.sessionAllow.add(key);
			assert.equal(await s.call("write", actions[0].input), undefined);
			assert.equal(s.requests.length, 0);
			assert.equal(s.prompts.length, 0);
			assert.equal(s.state.gate.skipped, 1);
		}
	});

	test(`${mode}: read-only tools and an explicitly disabled gate still bypass it`, async () => {
		const read = setup(mode, true);
		assert.equal(await read.call("read", { path: "src/example.ts" }), undefined);
		assert.equal(read.requests.length, 0);
		assert.equal(read.prompts.length, 0);
		for (const setting of ["enabled", "gateToolCalls"] as const) {
			const s = setup(mode, true);
			s.state.config.reflex[setting] = false;
			assert.equal(await s.call("write", actions[0].input), undefined);
			assert.equal(s.requests.length, 0);
			assert.equal(s.prompts.length, 0);
		}
	});

	test(`${mode}: protected paths and dangerous patterns keep their explanation`, async () => {
		for (const { tool, input, reason } of [
			{ tool: "write", input: { path: ".env", content: "example" }, reason: /protected path.*\.env/ },
			{ tool: "bash", input: { command: "rm -rf build" }, reason: /dangerous command pattern/ },
		]) {
			for (const hasUI of [false, true]) {
				const s = setup(mode, hasUI);
				const out = await s.call(tool, input);
				assert.equal(out?.block, true);
				assert.match(hasUI ? s.prompts[0] : out?.reason ?? "", reason);
			}
		}
	});
}
