import assert from "node:assert/strict";
import { test } from "node:test";
import { agentDiagram, toMermaid } from "../src/agents/diagram.ts";

const base = { id: "t", name: "t", cwd: "/tmp", prompt: "do it", enabled: true, createdAt: 0, updatedAt: 0 } as never;

test("single-prompt agent: triggers → LLM session (with TypeSafe gate badge) → end → chain", () => {
	const d = agentDiagram({ ...(base as object), triggers: [{ type: "cron", schedule: "@daily" }, { type: "manual" }], chain: [{ agentId: "notify", input: "{{output}}" }] } as never);
	assert.deepEqual(d.nodes.map((n) => n.kind), ["trigger", "trigger", "llm", "end", "chain"]);
	assert.ok(d.nodes.find((n) => n.id === "prompt")?.badges?.some((b) => b.includes("TypeSafe gate")));
	assert.deepEqual(d.edges.filter((e) => e.kind === "chain").map((e) => e.to), ["chain:0"]);
});

test("workflow agent: implicit order, route rules with conditions, back edge for retry, implicit end", () => {
	const steps = [
		{ id: "tests", type: "shell", run: "npm test" },
		{ id: "verdict", type: "decide", state: {}, questions: { failed: { type: "noul", instructions: "?" } }, route: [{ when: "verdict.failed.noul < 0.5", next: "ok" }, { when: "default", next: "fix" }] },
		{ id: "fix", type: "llm", prompt: "fix it", next: "tests" },
		{ id: "ok", type: "end", output: "green" },
	];
	const d = agentDiagram({ ...(base as object), triggers: [{ type: "webhook", secret: "s" }], steps } as never);
	assert.deepEqual(d.nodes.map((n) => n.id), ["trigger:0", "tests", "verdict", "fix", "ok"]);
	const routes = d.edges.filter((e) => e.from === "verdict");
	assert.deepEqual(routes.map((e) => [e.to, e.kind, e.label]), [["ok", "route", "verdict.failed.noul < 0.5"], ["fix", "default", "otherwise"]]);
	assert.ok(d.edges.some((e) => e.from === "fix" && e.to === "tests"), "retry loop edge");
	assert.ok(d.edges.some((e) => e.from === "trigger:0" && e.to === "tests"));
	const mm = toMermaid(d);
	assert.ok(mm.startsWith("flowchart TD"));
	assert.ok(mm.includes(':::decide') && mm.includes(':::llm') && mm.includes(':::shell'));
	assert.ok(mm.includes('|"otherwise"|'));
});
