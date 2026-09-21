import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.REFLEX_HOME = mkdtempSync(join(tmpdir(), "reflex-wf-"));
process.env.REFLEX_NO_CALL_LOG = "1";
const { budgetExceeded, buildQuestion, runWorkflow } = await import("../src/agents/workflow.ts");
const { emptyCost, findRunByKey, newRun, saveRun } = await import("../src/agents/store.ts");

type Req = { state: unknown; questions: Record<string, { type: string; criteria?: unknown; instructions?: unknown }> };
/** Fake Jev: choice picks the first option; score returns the number found in the item's `rel` field. */
function fakeJev(seen: Req[]) {
	return {
		systemOne: async (req: Req) => {
			seen.push(req);
			const answers: Record<string, unknown> = {};
			for (const [id, q] of Object.entries(req.questions)) {
				if (q.type === "choice") {
					const ids = Object.keys(q.criteria as object);
					answers[id] = { type: "choice", choice: ids[0], confidence: 0.9, probabilities: Object.fromEntries(ids.map((k, i) => [k, i === 0 ? 0.9 : 0.1 / (ids.length - 1 || 1)])) };
				} else if (q.type === "score") {
					const item = (q.instructions as { judge_only_this_item?: { rel: number } }).judge_only_this_item;
					answers[id] = { type: "score", score: item?.rel ?? 0, confidence: 0.8, probabilities: {} };
				} else answers[id] = { type: "noul", noul: 0.9 };
			}
			return { answers, usage: { input_tokens: 1000 }, latencyMs: 5 };
		},
	};
}
const hooks = (seen: Req[], extra: Record<string, unknown> = {}) => ({ cwd: process.cwd(), emit: () => {}, runLlm: async () => ({ status: "succeeded", output: "drafted", toolCalls: 1, reflexBlocks: 0, costUsd: 0.02, tokens: 500 }), callAgent: async () => ({ status: "succeeded" }), jev: fakeJev(seen), ...extra }) as never;

test("a choice rebuilds its options from a list variable each time, keeping static escapes", () => {
	const q = buildQuestion({ type: "choice", instructions: "Pick a worker for {{goal}}", optionsFrom: "workers.json", optionId: "name", optionText: "{{item.skill}} ({{item.load}} jobs)", criteria: { review: "unclear" } } as never, { goal: "briefing", workers: { json: [{ name: "researcher", skill: "finds sources", load: 2 }, { name: "writer", skill: "drafts", load: 0 }] } });
	assert.equal(q.instructions, "Pick a worker for briefing");
	assert.deepEqual(q.criteria, { researcher: "finds sources (2 jobs)", writer: "drafts (0 jobs)", review: "unclear" });
	assert.throws(() => buildQuestion({ type: "choice", instructions: "x", optionsFrom: "nope", criteria: {} } as never, {}), /not a list/);
});

test("shell JSON feeds the menu; forEach scores every item in parallel batches and ranks a shortlist", async () => {
	const seen: Req[] = [];
	const papers = Array.from({ length: 45 }, (_, i) => ({ title: `p${i}`, rel: i % 3 }));
	const r = await runWorkflow([
		{ id: "fetch", type: "shell", run: `printf '%s' '${JSON.stringify(papers)}'` },
		{ id: "rank", type: "decide", state: { goal: "{{input}}" }, forEach: { from: "fetch.json", id: "title", top: 4, min: 2, question: { type: "score", instructions: "relevance of {{item.title}}", criteria: ["no", "some", "yes"] } }, questions: { worker: { type: "choice", instructions: "who?", optionsFrom: "fetch.json", optionId: "title", criteria: { review: "unclear" } } } },
		{ id: "done", type: "end", output: "{{rank.count}} relevant, first {{rank.ranked.0.id}}, worker {{rank.worker.choice}}" },
	] as never, { input: "agents" }, hooks(seen));
	assert.equal(r.status, "succeeded");
	assert.equal(r.output, "15 relevant, first p2, worker p0");
	assert.equal((r.vars.rank as { shortlist: unknown[] }).shortlist.length, 4);
	assert.equal(seen.length, 3); // 1 request for the fixed question + 2 batches (40 + 5) for 45 items, sent together
	assert.equal(Object.keys(seen[1].questions).length, 40);
	const first = seen[1].questions.item_0.instructions as { question: string; judge_only_this_item: { title: string } };
	assert.deepEqual([first.question, first.judge_only_this_item.title], ["relevance of p0", "p0"]); // each question carries its own item
	assert.deepEqual(seen[1].state, { goal: "agents" }); // shared context only, not the whole list
});

test("budgets stop a run before the step that would cross them, and cost is accumulated", async () => {
	const cost = emptyCost();
	assert.equal(budgetExceeded({ ...cost, totalUsd: 0.3 }, { maxCostUsd: 0.25 }, "shell")?.includes("spend limit"), true);
	assert.equal(budgetExceeded({ ...cost, jevCalls: 2 }, { maxJevCalls: 2 }, "decide")?.includes("TypeSafe call limit"), true);
	assert.equal(budgetExceeded({ ...cost, jevCalls: 2 }, { maxJevCalls: 2 }, "shell"), undefined);
	assert.equal(budgetExceeded({ ...cost, steps: 200 }, undefined, "shell")?.includes("step limit"), true);

	const live = emptyCost();
	const steps = [
		{ id: "write", type: "llm", prompt: "draft", next: "check" },
		{ id: "check", type: "decide", state: "x", questions: { ok: { type: "noul", instructions: "good?" } }, next: "write" },
	];
	const r = await runWorkflow(steps as never, {}, hooks([], { limits: { maxLlmRuns: 2 }, cost: live }));
	assert.equal(r.status, "failed");
	assert.match(r.error ?? "", /budget: LLM run limit reached \(2\) before step "write"/);
	assert.deepEqual([live.llmRuns, live.jevCalls, live.steps], [2, 2, 4]);
	assert.ok(Math.abs(live.totalUsd - (0.04 + 2 * 1000 * 0.042e-6)) < 1e-9);
});

test("a checkpoint after every step lets a run resume without repeating completed steps", async () => {
	const ran: string[] = [];
	let cp: { nextIndex: number; completed: string[]; vars: Record<string, unknown> } | undefined;
	let fail = true;
	const steps = [
		{ id: "a", type: "shell", run: "echo one" },
		{ id: "b", type: "llm", prompt: "after {{a.stdout}}" },
		{ id: "c", type: "end", output: "finished with {{b.output}}" },
	];
	const h = hooks([], { checkpoint: (c: typeof cp) => { cp = c; }, emit: (e: { type: string; id: string }) => { if (e.type === "step_start") ran.push(e.id); }, runLlm: async () => (fail ? { status: "failed", error: "model down", toolCalls: 0, reflexBlocks: 0 } : { status: "succeeded", output: "draft", toolCalls: 0, reflexBlocks: 0 }) });
	const first = await runWorkflow(steps as never, {}, h);
	assert.equal(first.status, "failed");
	assert.deepEqual([cp?.completed, cp?.nextIndex], [["a"], 1]);
	fail = false;
	const second = await runWorkflow(steps as never, {}, h, { ...cp!, savedAt: 0 } as never);
	assert.equal(second.output, "finished with draft");
	assert.deepEqual(ran, ["a", "b", "b", "c"]); // "a" ran once; the interrupted "b" ran again; then "c"
});

test("an idempotency key finds the run it already produced, but not a failed one", () => {
	const agent = { id: "dedupe-test", name: "d" } as never;
	const ok = { ...newRun(agent, { type: "webhook" }, "x"), idempotencyKey: "hook:abc", status: "succeeded" as const };
	const bad = { ...newRun(agent, { type: "webhook" }, "y"), idempotencyKey: "hook:failed", status: "failed" as const };
	saveRun(ok);
	saveRun(bad);
	assert.equal(findRunByKey("dedupe-test", "hook:abc")?.id, ok.id);
	assert.equal(findRunByKey("dedupe-test", "hook:failed"), undefined);
	assert.equal(findRunByKey("dedupe-test", "hook:other"), undefined);
});
