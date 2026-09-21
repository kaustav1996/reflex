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
