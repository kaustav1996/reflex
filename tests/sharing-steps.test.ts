import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.REFLEX_HOME = mkdtempSync(join(tmpdir(), "reflex-sharing-steps-"));
process.env.REFLEX_NO_CALL_LOG = "1";
const { effectOf, fillSpawnTemplate, runWorkflow } = await import("../src/agents/workflow.ts");
const { listChildren, loadAgent, saveAgent } = await import("../src/agents/store.ts");
const { runAgent } = await import("../src/agents/runner.ts");

const hooks = (extra: Record<string, unknown> = {}) => ({ cwd: process.cwd(), emit: () => {}, runLlm: async () => ({ status: "succeeded", output: "", toolCalls: 0, reflexBlocks: 0 }), callAgent: async () => ({ status: "succeeded" }), ...extra });

test("untagged steps count as external; decide and end as read", () => {
	assert.equal(effectOf({ type: "shell", run: "x" } as never), "external");
	assert.equal(effectOf({ type: "llm", prompt: "x" } as never), "external");
	assert.equal(effectOf({ type: "decide", state: "" } as never), "read");
	assert.equal(effectOf({ type: "end" } as never), "read");
	assert.equal(effectOf({ type: "shell", run: "x", effect: "local" } as never), "local");
});

test("a trial runs read and local steps and only reports external ones", async () => {
	const dir = mkdtempSync(join(tmpdir(), "reflex-trial-"));
	const events: Array<{ type: string; id: string; result?: { skipped?: string; wouldRun?: string } }> = [];
	const r = await runWorkflow(
		[
			{ id: "read", type: "shell", run: "echo hi", effect: "read" },
			{ id: "edit", type: "shell", run: `touch ${join(dir, "local.txt")}`, effect: "local" },
			{ id: "push", type: "shell", run: `touch ${join(dir, "pushed.txt")}`, effect: "external" },
			{ id: "untagged", type: "shell", run: `touch ${join(dir, "untagged.txt")}` },
			{ id: "helper", type: "spawn", template: "monitor" },
			{ id: "done", type: "end", output: "{{read.stdout}}" },
		] as never,
		{},
		hooks({ trial: true, emit: (e: never) => events.push(e) }) as never,
	);
	assert.equal(r.status, "succeeded", r.error);
	assert.ok(existsSync(join(dir, "local.txt")), "local step ran");
	assert.ok(!existsSync(join(dir, "pushed.txt")), "external step did not run");
	assert.ok(!existsSync(join(dir, "untagged.txt")), "untagged step counts as external");
	const skipped = events.filter((e) => e.type === "step_end" && e.result?.skipped).map((e) => e.id);
	assert.deepEqual(skipped, ["push", "untagged", "helper"]);
	assert.match(events.find((e) => e.id === "push" && e.type === "step_end")!.result!.wouldRun!, /pushed\.txt/, "the trial says what would have run");
});

test("spawn fills only {{spawn.*}} placeholders, creates the helper, and manages only its own helpers", async () => {
	assert.deepEqual(fillSpawnTemplate({ a: "watch {{spawn.ticket}} on {{input}}" }, { ticket: "DO-1" }), { a: "watch DO-1 on {{input}}" });
	const parent = saveAgent({
		id: "oncall",
		name: "oncall",
		prompt: "",
		cwd: process.cwd(),
		templates: { monitor: { name: "Monitor {{spawn.ticket}}", prompt: "Check {{spawn.ticket}} for {{input}}", triggers: [{ type: "cron", schedule: "*/30 * * * *" }] } },
		steps: [
			{ id: "make", type: "spawn", template: "monitor", agent: "monitor-{{input}}", with: { ticket: "{{input}}" } },
			{ id: "done", type: "end", output: "{{make.id}}" },
		],
	} as never);
	const run = await runAgent(parent, { type: "manual" }, "do-7");
	assert.equal(run.status, "succeeded", run.error);
	assert.equal(run.output, "monitor-do-7");
	const child = loadAgent("monitor-do-7")!;
	assert.equal(child.parent, "oncall");
	assert.equal(child.prompt, "Check do-7 for {{input}}", "the child's own placeholders survive");
	assert.deepEqual(listChildren("oncall").map((a) => a.id), ["monitor-do-7"]);

	saveAgent({ id: "someone-else", name: "someone else", prompt: "x", cwd: process.cwd() } as never);
	const other = saveAgent({ id: "rogue", name: "rogue", prompt: "", cwd: process.cwd(), steps: [{ id: "del", type: "spawn", action: "delete", agent: "someone-else" }] } as never);
	const r2 = await runAgent(other, { type: "manual" });
	assert.equal(r2.status, "failed");
	assert.ok(loadAgent("someone-else"), "an agent it didn't create is untouched");

	const cleanup = saveAgent({ ...parent, steps: [{ id: "del", type: "spawn", action: "delete", agent: "monitor-do-7" }] } as never);
	assert.equal((await runAgent(cleanup, { type: "manual" })).status, "succeeded");
	assert.equal(loadAgent("monitor-do-7"), undefined);
});

test("a trial run of a spawning agent creates nothing and records what it skipped", async () => {
	const a = saveAgent({ id: "trialer", name: "trialer", prompt: "", cwd: process.cwd(), templates: { m: { name: "m", prompt: "p" } }, steps: [{ id: "make", type: "spawn", template: "m", agent: "should-not-exist" }] } as never);
	const run = await runAgent(a, { type: "manual" }, undefined, undefined, { trial: true });
	assert.equal(run.status, "succeeded", run.error);
	assert.equal(run.trial, true);
	assert.deepEqual(run.skippedExternal, ["make"]);
	assert.equal(loadAgent("should-not-exist"), undefined);
});
