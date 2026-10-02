import assert from "node:assert/strict";
import { test } from "node:test";
import { hintsFrom, MIN_HINT_PROBABILITY } from "../src/extensions/typesafe/selector.ts";
import type { ChoiceAnswer } from "../src/extensions/typesafe/client.ts";

function answer(choice: string, probabilities: Record<string, number>): ChoiceAnswer {
	return { type: "choice", choice, probabilities, confidence: Math.max(...Object.values(probabilities)) };
}

const skills = ["testing"];
const servers = ["github"];

test("a skill or connector hint requires at least the minimum probability", () => {
	assert.equal(MIN_HINT_PROBABILITY, 0.5);
	assert.deepEqual(
		hintsFrom(
			{
				skill: answer("testing", { none: 0.1, testing: 0.9 }),
				connector: answer("github", { none: 0.1, github: 0.9 }),
			},
			skills,
			servers,
		),
		[
			'skill "testing" (90%) — read its SKILL.md before starting',
			'connector "github" (90%) — its tools are named github__*',
		],
	);
	assert.deepEqual(
		hintsFrom(
			{
				skill: answer("testing", { none: 0.6, testing: 0.4 }),
				connector: answer("github", { none: 0.6, github: 0.4 }),
			},
			skills,
			servers,
		),
		[],
	);
	assert.deepEqual(
		hintsFrom({ skill: answer("testing", { none: 0.5, testing: 0.5 }) }, skills, servers),
		['skill "testing" (50%) — read its SKILL.md before starting'],
	);
});

test("none and choices outside the available lists never produce hints", () => {
	assert.deepEqual(
		hintsFrom(
			{
				skill: answer("unknown", { none: 0.1, testing: 0.1, unknown: 0.8 }),
				connector: answer("unknown", { none: 0.1, github: 0.1, unknown: 0.8 }),
			},
			skills,
			servers,
		),
		[],
	);
	assert.deepEqual(
		hintsFrom(
			{
				skill: answer("none", { none: 0.9, testing: 0.1 }),
				connector: answer("none", { none: 0.9, github: 0.1 }),
			},
			skills,
			servers,
		),
		[],
	);
});

test("with more skills than one Choice holds, the ones matching the request are offered", async () => {
	const { shortlist, MAX_CHOICE_OPTIONS } = await import("../src/extensions/typesafe/selector.ts");
	const many = Array.from({ length: 300 }, (_, i) => ({ name: `skill-${i}`, text: "generic helper" }));
	many.push({ name: "postgres-migrations", text: "write and review database migrations for postgres" });
	const picked = shortlist(many, "write a postgres migration for the users table");
	assert.equal(picked.length, MAX_CHOICE_OPTIONS);
	assert.ok(picked.some((s) => s.name === "postgres-migrations"), "a matching skill past position 250 is still offered");
	assert.deepEqual(shortlist(many.slice(0, 10), "anything"), many.slice(0, 10), "short lists pass through unchanged");
});

// ── two-stage selection ────────────────────────────────────────────────────
const { applySelection, shortlistFrom, skillStage } = await import("../src/extensions/typesafe/selector.ts");
const { SKILL_GATE_THRESHOLD } = await import("../src/extensions/typesafe/policy.ts");
const { ReflexState: State } = await import("../src/extensions/typesafe/state.ts");
const { loadReflexConfig: loadCfg } = await import("../src/config.ts");

const pick = (choice: string, probabilities: Record<string, number>) => ({ type: "choice" as const, choice, confidence: probabilities[choice], probabilities });
const roster = ["deploy", "humanizer", "reflex-agents"];

test("the gate can decline every skill, however the choice ranked them", () => {
	// A Choice always names a winner — even when the whole field fits badly.
	// A near-certain winner stands on its own: the gate breaks ties, it does not overrule certainty.
	const confident = pick("deploy", { none: 0.1, deploy: 0.9 });
	assert.deepEqual(skillStage({ skill: confident, skill_needed: { noul: 0.2 } }, roster).verdict, "take-it", "a 90% match survives a doubtful gate");
	// Where it does decide: a middling field.
	const middling = { skill: pick("deploy", { none: 0.3, deploy: 0.45, humanizer: 0.25 }), skill_needed: { noul: 0.2 } };
	assert.deepEqual(skillStage(middling, roster).verdict, "no-skill-needed", "a weak winner plus a doubtful gate suggests nothing");
	assert.deepEqual(skillStage({ ...middling, skill_needed: { noul: SKILL_GATE_THRESHOLD } }, roster).verdict, "look-closer");
	assert.deepEqual(skillStage({ skill: pick("none", { none: 0.8, deploy: 0.2 }), skill_needed: { noul: 0.9 } }, roster).verdict, "no-skill-needed");
	assert.deepEqual(skillStage({ skill: pick("not-installed", { "not-installed": 0.9 }), skill_needed: { noul: 0.9 } }, roster).verdict, "no-skill-needed", "a name that isn't installed is not a suggestion");
});

test("a clear winner is taken as it is; a middling one goes to a second look", () => {
	assert.deepEqual(skillStage({ skill: pick("deploy", { none: 0.1, deploy: 0.9 }), skill_needed: { noul: 0.9 } }, roster), { verdict: "take-it", name: "deploy", shortlist: [] });
	const closer = skillStage({ skill: pick("deploy", { none: 0.2, deploy: 0.45, humanizer: 0.35 }), skill_needed: { noul: 0.9 } }, roster);
	assert.equal(closer.verdict, "look-closer");
	assert.deepEqual(closer.shortlist, ["deploy", "humanizer"], "the best few, none excluded");
	assert.deepEqual(shortlistFrom(pick("a", { none: 0.9, deploy: 0.5, humanizer: 0.4, "reflex-agents": 0.3 }), roster), ["deploy", "humanizer", "reflex-agents"]);
});

test("the second look can overturn the first stage, and a weak field produces no hint at all", async () => {
	const state = new State(loadCfg());
	const asked: string[][] = [];
	const hint = await applySelection(
		state,
		{ skill: pick("deploy", { none: 0.2, deploy: 0.45, humanizer: 0.35 }), skill_needed: { noul: 0.9 } },
		{ skills: roster, servers: [] },
		{ fit: async (names) => (asked.push(names), { deploy: 0.3, humanizer: 0.82 }) },
	);
	assert.deepEqual(asked, [["deploy", "humanizer"]], "only the shortlist is asked about");
	assert.match(hint ?? "", /skill "humanizer" \(82%\)/, "judged on its own merits, the runner-up wins");

	const none = await applySelection(
		new State(loadCfg()),
		{ skill: pick("deploy", { none: 0.2, deploy: 0.45, humanizer: 0.35 }), skill_needed: { noul: 0.9 } },
		{ skills: roster, servers: [] },
		{ fit: async () => ({ deploy: 0.2, humanizer: 0.25 }) },
	);
	assert.equal(none, undefined, "nothing clears the bar on its own, so nothing is suggested");

	// A clear first stage never pays for the second call.
	let called = false;
	const direct = await applySelection(
		new State(loadCfg()),
		{ skill: pick("deploy", { none: 0.1, deploy: 0.9 }), skill_needed: { noul: 0.9 } },
		{ skills: roster, servers: [] },
		{ fit: async () => ((called = true), {}) },
	);
	assert.equal(called, false, "no second call when the first stage is already clear");
	assert.match(direct ?? "", /skill "deploy" \(90%\)/);
});

// ── sending only the tools a request needs ─────────────────────────────────
const { heldBackNote, isCoreTool, planTools } = await import("../src/extensions/typesafe/tools.ts");

test("core tools always ship; other connectors' tools are left out and named", () => {
	const all = ["read", "edit", "write", "bash", "jira__getIssue", "jira__addComment", "slack__postMessage", "github__createPR"];
	const plan = planTools(all, { wanted: "jira" });
	assert.deepEqual(plan.keep, ["read", "edit", "write", "bash", "jira__getIssue", "jira__addComment"]);
	assert.deepEqual(plan.dropped, ["slack__postMessage", "github__createPR"]);
	assert.deepEqual(plan.heldBack, ["github", "slack"]);
	assert.match(heldBackNote(plan.heldBack), /github, slack.*say so and it will be available/s);
	assert.equal(heldBackNote([]), "", "nothing held back, nothing said");
});

test("a connector already used this session is never withheld again", () => {
	const all = ["bash", "jira__getIssue", "slack__postMessage"];
	assert.deepEqual(planTools(all, { wanted: "jira", used: new Set(["slack"]) }).dropped, [], "it reached for slack once; keep it loaded");
	assert.deepEqual(planTools(all, { wanted: undefined }).dropped, ["jira__getIssue", "slack__postMessage"], "no connector wanted: carry none of them");
	assert.deepEqual(planTools(["read", "bash"], { wanted: "jira" }).dropped, [], "nothing to save when no connectors are configured");
});

test("a connector whose name has a dash is matched by its tool prefix, not its spelling", () => {
	// Live finding: "cloudflare-docs" exposes "cloudflare_docs__search", so a literal comparison
	// dropped the very connector the request had asked for — and told the model it wasn't loaded.
	const all = ["bash", "cloudflare_docs__search", "context7__get_docs"];
	const plan = planTools(all, { wanted: "cloudflare-docs" });
	assert.deepEqual(plan.keep, ["bash", "cloudflare_docs__search"]);
	assert.deepEqual(plan.heldBack, ["context7"]);
	assert.deepEqual(planTools(all, { wanted: "x", used: new Set(["cloudflare-docs"]) }).dropped, ["context7__get_docs"]);
});

test("what counts as a core tool", () => {
	for (const t of ["read", "edit", "write", "bash", "request_secrets", "browse"]) assert.equal(isCoreTool(t), true, t);
	for (const t of ["jira__getIssue", "cloudflare_docs__search"]) assert.equal(isCoreTool(t), false, t);
});
