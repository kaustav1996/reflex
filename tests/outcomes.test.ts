import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.REFLEX_HOME = mkdtempSync(join(tmpdir(), "reflex-outcomes-"));
delete process.env.REFLEX_NO_CALL_LOG;
const { loadReflexConfig } = await import("../src/config.ts");
const { ReflexState } = await import("../src/extensions/typesafe/state.ts");
const { isVerification, readsSkill, registerOutcomes } = await import("../src/extensions/typesafe/outcomes.ts");
const { clearDecisions, logDecision, readDecisions } = await import("../src/logs/decisions.ts");

type Handler = (event: unknown, ctx?: unknown) => Promise<unknown> | unknown;

function setup() {
	clearDecisions();
	const state = new ReflexState(loadReflexConfig());
	const handlers: Record<string, Handler> = {};
	registerOutcomes({ on: (event: string, h: Handler) => (handlers[event] = h) } as never, state);
	const decide = (source: "route" | "select" | "completion", action: string) => logDecision({ source, action, summary: "x", signals: {} });
	const labels = () => readDecisions().map((d) => [d.action, d.outcome?.label]);
	return { state, handlers, decide, labels };
}

test("reading the suggested skill closes the hint; not reading it is recorded at the end of the turn", async () => {
	const s = setup();
	s.state.pending.skill = { id: s.decide("select", "hint"), name: "reflex-agents" };
	await s.handlers.tool_call({ toolName: "read", input: { path: "/Users/x/.reflex/agent/skills/reflex-agents/SKILL.md" } });
	assert.deepEqual(s.labels(), [["hint", "skill-read"]]);
	assert.equal(s.state.pending.skill, undefined, "closed once");

	const t = setup();
	t.state.pending.skill = { id: t.decide("select", "hint"), name: "reflex-agents" };
	await t.handlers.tool_call({ toolName: "read", input: { path: "/Users/x/project/README.md" } });
	assert.deepEqual(t.labels(), [["hint", undefined]], "an unrelated read proves nothing");
	await t.handlers.agent_end({});
	assert.deepEqual(t.labels(), [["hint", "skill-not-read"]], "silence is evidence, recorded when the turn ends");
});

test("the verification the completion check demanded is followed to pass, fail or never", async () => {
	const pass = setup();
	pass.state.pending.verify = pass.decide("completion", "nudge:verify");
	await pass.handlers.tool_result({ toolName: "bash", input: { command: "npm test" }, isError: false });
	assert.deepEqual(pass.labels(), [["nudge:verify", "verification-passed"]]);

	const fail = setup();
	fail.state.pending.verify = fail.decide("completion", "nudge:verify");
	await fail.handlers.tool_result({ toolName: "bash", input: { command: "npx tsc --noEmit" }, isError: true });
	assert.deepEqual(fail.labels(), [["nudge:verify", "verification-failed"]]);

	// The nudge is sent as a turn ends, so the first agent_end after it must not call it "never run":
	// the model can only act on it in the turn that follows.
	const later = setup();
	later.state.pending.verify = later.decide("completion", "nudge:verify");
	later.state.verifyJustAsked = true;
	await later.handlers.agent_end({});
	assert.deepEqual(later.labels(), [["nudge:verify", undefined]], "the turn it was asked in doesn't count");
	await later.handlers.tool_result({ toolName: "bash", input: { command: "npm test" }, isError: true });
	assert.deepEqual(later.labels(), [["nudge:verify", "verification-failed"]], "the next turn does");

	const never = setup();
	never.state.pending.verify = never.decide("completion", "nudge:verify");
	await never.handlers.tool_result({ toolName: "bash", input: { command: "ls -la" }, isError: false });
	assert.deepEqual(never.labels(), [["nudge:verify", undefined]], "listing files is not a verification");
	await never.handlers.agent_end({});
	assert.deepEqual(never.labels(), [["nudge:verify", "verification-not-run"]]);
});

test("a routing decision is closed by the turn it produced, or by the user overriding it", async () => {
	const clean = setup();
	clean.state.pending.route = clean.decide("route", "switch:fast");
	await clean.handlers.agent_end({});
	assert.deepEqual(clean.labels(), [["switch:fast", "turn-clean"]]);

	const nudged = setup();
	nudged.state.pending.route = nudged.decide("route", "switch:fast");
	nudged.state.nudgedThisPrompt = true;
	await nudged.handlers.agent_end({});
	assert.deepEqual(nudged.labels(), [["switch:fast", "turn-needed-nudge"]], "the cheap tier needed help");

	// A new prompt closes whatever the last turn left open, so nothing leaks between turns.
	const leftover = setup();
	leftover.state.pending.route = leftover.decide("route", "switch:strong");
	await leftover.handlers.input({});
	assert.deepEqual(leftover.labels(), [["switch:strong", "new-prompt"]]);
	assert.equal(leftover.state.nudgedThisPrompt, false, "the nudge flag resets with the prompt");
});

test("what counts as reading a skill, and as a verification", () => {
	assert.equal(readsSkill("read", { path: "~/.reflex/agent/skills/humanizer/SKILL.md" }, "humanizer"), true);
	assert.equal(readsSkill("read", { path: "/repo/skills/Reflex-Agents/SKILL.md" }, "reflex-agents"), true, "case doesn't matter");
	assert.equal(readsSkill("read", { path: "/repo/src/humanizer.ts" }, "humanizer"), false, "a source file with the same name is not the skill");
	assert.equal(readsSkill("bash", { command: "cat skills/humanizer/SKILL.md" }, "humanizer"), false, "only the read and skill tools count");

	assert.equal(isVerification("bash", { command: "npm test" }), true);
	assert.equal(isVerification("bash", { command: "pytest -q" }), true);
	assert.equal(isVerification("bash", { command: "npm run build" }), true);
	assert.equal(isVerification("bash", { command: "git status" }), false);
	assert.equal(isVerification("read", { path: "test.txt" }), false);
});
