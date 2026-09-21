import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.REFLEX_HOME = mkdtempSync(join(tmpdir(), "reflex-broken-agents-"));
const { agentDir, agentFileError, listAgents, listBrokenAgents, saveAgent } = await import("../src/agents/store.ts");

test("an agent.json broken by an unescaped quote is listed as broken, with where it broke", () => {
	saveAgent({ name: "fine", prompt: "say hi" });
	mkdirSync(agentDir("oncall"), { recursive: true });
	// The real failure: a sed command whose &quot; was decoded into a bare quote inside a JSON string.
	writeFileSync(join(agentDir("oncall"), "agent.json"), `{\n  "name": "oncall",\n  "prompt": "run sed -e 's/"/\\\\"/g' on the runbook"\n}\n`);
	assert.deepEqual(listAgents().map((a) => a.id), ["fine"], "a broken agent never runs");
	const [b] = listBrokenAgents();
	assert.equal(b.id, "oncall");
	assert.equal(b.line, 3);
	assert.ok(b.column && b.column > 20, `column ${b.column}`);
	assert.ok(b.snippet?.includes("⟪here⟫"));
});

test("a valid file has no error", () => {
	assert.equal(agentFileError("x", '{"name":"x","prompt":"p"}'), undefined);
});

test("a run's resume checkpoint is not listed as a run", async () => {
	const { listRuns, saveCheckpoint } = await import("../src/agents/store.ts");
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const run = { id: "20260922000000-abc123", agentId: "fine", status: "succeeded", trigger: { type: "manual" }, startedAt: Date.now(), toolCalls: 0, reflexBlocks: 0 };
	const dir = join(process.env.REFLEX_HOME!, "agents", "fine", "runs");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${run.id}.json`), JSON.stringify(run));
	saveCheckpoint(run as never, { nextIndex: 2, vars: {}, completed: [], savedAt: Date.now() } as never);
	const runs = listRuns("fine");
	assert.deepEqual(runs.map((r) => r.id), [run.id]);
	assert.ok(runs.every((r) => r.trigger), "every listed run has a trigger");
});
