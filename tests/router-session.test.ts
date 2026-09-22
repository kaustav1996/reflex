import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.REFLEX_HOME = mkdtempSync(join(tmpdir(), "reflex-router-session-"));
process.env.REFLEX_NO_CALL_LOG = "1";
const { loadReflexConfig } = await import("../src/config.ts");
const { ReflexState } = await import("../src/extensions/typesafe/state.ts");
const { effectiveRouting, registerRouter, routeStatus } = await import("../src/extensions/typesafe/router.ts");

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

/** A Reflex state with three saved tiers, a fake Jev that always answers `tier`, and a fake Pi. */
function setup(tier: "fast" | "default" | "strong" = "fast") {
	const config = loadReflexConfig();
	config.reflex.enabled = true;
	config.reflex.routeModels = true;
	config.reflex.routing = { fast: "or/fast-saved", default: "or/default-saved", strong: "or/strong-saved" };
	const state = new ReflexState(config);
	let jevCalls = 0;
	state.client = {
		systemOne: async () => {
			jevCalls++;
			const probabilities = { fast: 0.05, default: 0.05, strong: 0.05, [tier]: 0.9 };
			return { answers: { tier: { type: "choice", choice: tier, confidence: 0.9, probabilities } }, usage: { input_tokens: 10 }, latencyMs: 1 };
		},
	} as never;
	const handlers: Record<string, Handler> = {};
	const switched: string[] = [];
	let current = { provider: "or", id: "start" };
	const ctx = {
		hasUI: false,
		cwd: "/tmp/proj",
		thinkingLevel: "medium",
		get model() {
			return current;
		},
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
		ui: { setStatus() {}, notify() {} },
	};
	const pi = {
		on: (event: string, h: Handler) => (handlers[event] = h),
		setThinkingLevel() {},
		// Like Pi: switching fires model_select with source "set".
		setModel: async (m: { provider: string; id: string }) => {
			switched.push(`${m.provider}/${m.id}`);
			const previousModel = current;
			current = m;
			await handlers.model_select?.({ type: "model_select", model: m, previousModel, source: "set" }, ctx);
			return true;
		},
	};
	registerRouter(pi as never, state);
	const prompt = (text = "rename this variable across the file") => handlers.before_agent_start({ type: "before_agent_start", prompt: text, systemPrompt: "" }, ctx);
	const userPicks = (provider: string, id: string) => handlers.model_select({ type: "model_select", model: { provider, id }, previousModel: current, source: "set" }, ctx);
	return { state, prompt, userPicks, switched, jev: () => jevCalls };
}

test("the router's own switch is not taken for the user's pick", async () => {
	const s = setup("fast");
	await s.prompt();
	assert.deepEqual(s.switched, ["or/fast-saved"]);
	assert.equal(s.state.sessionRoute.pinned, undefined);
	assert.equal(s.state.routerSwitching, false);
});

test("a model the user picks is pinned for the session and routing stops over it", async () => {
	const s = setup("strong");
	await s.userPicks("anthropic", "claude-x");
	assert.equal(s.state.sessionRoute.pinned, "anthropic/claude-x");
	await s.prompt("why does this crash under load?");
	assert.equal(s.jev(), 0, "no routing question while pinned");
	assert.deepEqual(s.switched, [], "the pinned model is kept");
	assert.match(routeStatus(s.state) ?? "", /📌 anthropic\/claude-x · routing paused/);

	s.state.sessionRoute.pinned = undefined; // what /reflex route auto does
	await s.prompt("why does this crash under load?");
	assert.deepEqual(s.switched, ["or/strong-saved"], "routing resumes");
});

test("session tier overrides win over the saved tiers, and only for this session", async () => {
	const s = setup("fast");
	s.state.sessionRoute.routing.fast = "or/fast-session";
	s.state.sessionRoute.effort.fast = "low";
	assert.deepEqual(effectiveRouting(s.state).tiers, { fast: "or/fast-session", default: "or/default-saved", strong: "or/strong-saved" });
	assert.equal(effectiveRouting(s.state).effort.fast, "low");
	await s.prompt();
	assert.deepEqual(s.switched, ["or/fast-session"]);
	assert.equal(s.state.config.reflex.routing.fast, "or/fast-saved", "the saved config is untouched");
	assert.equal(routeStatus(s.state), "⇄ routing · session tiers");
});
