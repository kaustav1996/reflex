import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.REFLEX_HOME = mkdtempSync(join(tmpdir(), "reflex-brief-"));
process.env.REFLEX_NO_CALL_LOG = "1";
const { loadReflexConfig } = await import("../src/config.ts");
const { ReflexState } = await import("../src/extensions/typesafe/state.ts");
const { registerRequestBrief } = await import("../src/extensions/typesafe/brief.ts");

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function setup(opts: { routing?: boolean; skills?: boolean } = {}) {
	const config = loadReflexConfig();
	config.reflex.enabled = true;
	config.reflex.routeModels = opts.routing !== false;
	config.reflex.selectSkills = opts.skills !== false;
	config.reflex.routing = { fast: "or/fast", default: "or/default", strong: "or/strong" };
	const state = new ReflexState(config);
	const requests: Array<{ state: unknown; questions: Record<string, unknown> }> = [];
	state.client = {
		systemOne: async (req: { state: unknown; questions: Record<string, unknown> }) => {
			requests.push(req);
			const answers: Record<string, unknown> = {};
			if (req.questions.tier) answers.tier = { type: "choice", choice: "strong", confidence: 0.9, probabilities: { fast: 0.05, default: 0.05, strong: 0.9 } };
			if (req.questions.skill) answers.skill = { type: "choice", choice: "deploy", confidence: 0.8, probabilities: { none: 0.2, deploy: 0.8 } };
			return { answers, usage: { input_tokens: 10 }, latencyMs: 1 };
		},
	} as never;
	const handlers: Record<string, Handler> = {};
	const switched: string[] = [];
	const ctx = { hasUI: false, cwd: "/tmp/proj", thinkingLevel: "medium", model: { provider: "or", id: "start" }, modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) }, ui: { setStatus() {}, notify() {} }, getSystemPrompt: () => "" };
	const pi = { on: (event: string, h: Handler) => (handlers[event] = h), setThinkingLevel() {}, setModel: async (m: { provider: string; id: string }) => (switched.push(`${m.provider}/${m.id}`), true) };
	registerRequestBrief(pi as never, state);
	const ask = (text = "deploy the staging service and watch the logs") =>
		handlers.before_agent_start({ type: "before_agent_start", prompt: text, systemPrompt: "", systemPromptOptions: { skills: [{ name: "deploy", description: "Deploy services and watch rollout" }] } }, ctx);
	return { ask, requests, switched, state };
}

test("routing and relevance are one Jev call, not one per question", async () => {
	const s = setup();
	const out = (await s.ask()) as { message?: { content: string } } | undefined;
	assert.equal(s.requests.length, 1, "one call for the whole request");
	assert.deepEqual(Object.keys(s.requests[0].questions).sort(), ["skill", "tier"], "both questions ride along");
	// The state is charged once per call, so the request text must appear exactly once.
	const state = s.requests[0].state as { request: string; recent_context: string };
	assert.match(state.request, /deploy the staging service/);
	assert.ok("recent_context" in state);
	assert.deepEqual(s.switched, ["or/strong"], "the tier answer still switches the model");
	assert.match(out?.message?.content ?? "", /skill "deploy"/, "the relevance hint still reaches the model");
});

test("only the questions that apply are asked", async () => {
	const noRouting = setup({ routing: false });
	await noRouting.ask();
	assert.deepEqual(Object.keys(noRouting.requests[0].questions), ["skill"]);
	assert.deepEqual(noRouting.switched, []);

	const noSkills = setup({ skills: false });
	const out = await noSkills.ask();
	assert.deepEqual(Object.keys(noSkills.requests[0].questions), ["tier"]);
	assert.equal(out, undefined, "no relevance message when selection is off");

	const neither = setup({ routing: false, skills: false });
	assert.equal(await neither.ask(), undefined);
	assert.equal(neither.requests.length, 0, "nothing to ask means no call at all");

	const slash = setup();
	assert.equal(await slash.ask("/reflex stats"), undefined);
	assert.equal(slash.requests.length, 0, "a slash command isn't a request to judge");
});
