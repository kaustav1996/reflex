import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "reflex-sharing-bundle-"));
process.env.REFLEX_HOME = home;
process.env.REFLEX_NO_CALL_LOG = "1";
process.env.REFLEX_WEB_URL = "http://127.0.0.1:7999";
const { applyBundle, buildBundle, collectRequirements, findParamCandidates, guessEffect, validateBundle } = await import("../src/agents/bundle.ts");
const { checkStaged, discardStaged, getStaged, installStaged, listStaged, setStagedValues, stageBundle, trialStaged, trialAgentId } = await import("../src/agents/staging.ts");
const { listAgents, loadAgent, agentDir } = await import("../src/agents/store.ts");

const AUTHOR = "/Users/alice/work/devops";
const author = {
	id: "oncall",
	name: "On-call access",
	description: "Resolves access tickets",
	cwd: AUTHOR,
	prompt: "",
	reflex: "off",
	enabled: true,
	createdAt: 1,
	updatedAt: 2,
	triggers: [{ type: "manual" }, { type: "webhook", secret: "s3cret" }],
	steps: [
		{ id: "prep", type: "shell", run: `git -C ${AUTHOR}/repo fetch && cat ${AUTHOR}/.plan.json`, effect: "local" },
		{ id: "fetch", type: "llm", prompt: "Read page 3048013829 (cloud b54bab21-7d56-45ce-9ad1-2da0e6716201) and write the plan", tools: ["read", "atlassian__getConfluencePage", "atlassian__getJiraIssue"] },
		{ id: "notify", type: "shell", run: `curl -X POST http://127.0.0.1:7331/api/agents -H "x-reflex-token: $REFLEX_WEB_TOKEN" -d @${AUTHOR}/monitor.json && echo $JIRA_API_TOKEN` },
		{ id: "done", type: "end", output: "{{prep.stdout}}" },
	],
} as never;

test("candidates group paths by folder and find ids; requirements name the connector, CLIs and secrets", () => {
	const c = findParamCandidates(author, "/Users/alice");
	assert.equal(c[0].value, AUTHOR);
	assert.equal(c[0].suggestedId, "WORKDIR");
	assert.ok(c[0].count >= 4, "one parameter covers every path under the folder");
	assert.ok(c.some((x) => x.value === "3048013829" && x.type === "id"));
	assert.ok(c.some((x) => x.value === "b54bab21-7d56-45ce-9ad1-2da0e6716201" && x.suggestedId === "UUID"), "UUIDs are candidates");
	assert.ok(!c.some((x) => x.value.includes("127.0.0.1")), "the local Reflex URL is handled separately");
	const r = collectRequirements(author);
	assert.deepEqual(r.connectors.map((x) => [x.id, x.tools]), [["atlassian", ["getConfluencePage", "getJiraIssue"]]]);
	assert.deepEqual(r.clis.map((x) => x.name).sort(), ["curl", "git"]);
	assert.deepEqual(r.secrets.map((x) => x.name), ["JIRA_API_TOKEN"], "the web token is Reflex's own, not a requirement");
	assert.ok(r.warnings.some((w) => /local API/.test(w)));
	assert.ok(r.warnings.some((w) => /gate off/.test(w)));
});

test("effects: pushes and write APIs are external, local edits local", () => {
	assert.equal(guessEffect({ type: "shell", run: "git push -u origin main" } as never), "external");
	assert.equal(guessEffect({ type: "shell", run: "git commit -am x" } as never), "local");
	assert.equal(guessEffect({ type: "shell", run: "cat plan.json | jq .key" } as never), "read");
	assert.equal(guessEffect({ type: "llm", prompt: "x", tools: ["atlassian__addCommentToJiraIssue"] } as never), "external");
	assert.equal(guessEffect({ type: "llm", prompt: "x", tools: ["read", "grep"] } as never), "read");
});

test("a bundle has no author paths or secrets, and applying it fills the importer's values", () => {
	const { bundle, warnings } = buildBundle(author, { params: [{ id: "WORKDIR", type: "dir", description: "Folder with the repo clone", value: AUTHOR }, { id: "PAGE_ID", type: "id", description: "Runbook page", value: "3048013829" }] }, "/Users/alice");
	const text = JSON.stringify(bundle.agent);
	assert.ok(!text.includes("/Users/alice"), text);
	assert.ok(!text.includes("s3cret"), "webhook secrets are dropped");
	assert.ok(text.includes("{{reflex.url}}/api/agents"));
	assert.ok(!("createdAt" in bundle.agent) && !("enabled" in bundle.agent));
	assert.deepEqual(validateBundle(bundle), []);
	assert.ok(!warnings.some((w) => /Still contains/.test(w)));
	assert.throws(() => applyBundle(bundle, { values: { WORKDIR: "/x" }, reflexUrl: "http://127.0.0.1:8000" }), /PAGE_ID/);
	const def = applyBundle(bundle, { values: { WORKDIR: "/home/bob/ops", PAGE_ID: "42" }, reflexUrl: "http://127.0.0.1:8000", connectorMap: { atlassian: "jira" } });
	assert.equal(def.cwd, "/home/bob/ops");
	assert.match(JSON.stringify(def), /http:\/\/127\.0\.0\.1:8000\/api\/agents/);
	assert.deepEqual((def.steps![1] as { tools: string[] }).tools, ["read", "jira__getConfluencePage", "jira__getJiraIssue"]);
	assert.equal(def.enabled, false);
	assert.equal(def.reflex, "balanced", "an import starts with the gate on");
	assert.deepEqual(validateBundle({ reflexAgent: 1, meta: { name: "x" }, params: [], agent: { name: "x", prompt: "{{param.NOPE}}" } }), ["{{param.NOPE}} is used but not declared"]);
});

test("staging → values → checks → trial → install, and nothing is listed until install", async () => {
	const work = mkdtempSync(join(tmpdir(), "reflex-importer-"));
	mkdirSync(join(work, "repo"));
	writeFileSync(join(work, ".plan.json"), '{"key":"DO-1"}');
	const { bundle } = buildBundle(
		{ ...(author as object), steps: [
			{ id: "prep", type: "shell", run: "cat {{param.WORKDIR}}/.plan.json", effect: "read" },
			{ id: "mark", type: "shell", run: "touch {{param.WORKDIR}}/trial-ran.txt", effect: "local" },
			{ id: "push", type: "shell", run: "touch {{param.WORKDIR}}/pushed.txt", effect: "external" },
			{ id: "done", type: "end", output: "{{prep.stdout}}" },
		] } as never,
		{ params: [] },
	);
	bundle.params = [{ id: "WORKDIR", type: "dir", description: "Working folder" }];
	const s = await stageBundle(JSON.stringify(bundle), { cwd: work, jev: null as never, source: "oncall.reflex-agent.json" });
	assert.equal(s.values.WORKDIR, work, "the session folder is proposed for WORKDIR");
	assert.equal(listStaged().length, 1);
	assert.ok(!listAgents().some((a) => a.name === "On-call access"), "staged agents aren't in the list");

	const check = await checkStaged(s.id);
	assert.deepEqual(check.values, []);
	assert.equal(check.connectors.length, 0);
	assert.equal(check.jev.needed, false);

	assert.throws(() => setStagedValues(s.id, { values: { NOPE: "x" } }), /unknown parameter/);
	const trial = await trialStaged(s.id);
	assert.equal(trial.status, "succeeded", trial.error);
	assert.ok(existsSync(join(work, "trial-ran.txt")), "local step ran in the trial");
	assert.ok(!existsSync(join(work, "pushed.txt")), "external step was only reported");
	assert.deepEqual(trial.steps.filter((x) => x.skipped).map((x) => x.id), ["push"]);
	assert.ok(existsSync(agentDir(trialAgentId(s.id))), "trial runs are kept under the staging id");
	assert.ok(!listAgents().some((a) => a.id === trialAgentId(s.id)));

	const agent = installStaged(s.id);
	assert.equal(agent.id, "oncall");
	assert.equal(agent.enabled, false);
	assert.equal(agent.reflex, "balanced");
	assert.match((agent.steps![0] as { run: string }).run, new RegExp(`cat ${work}/\\.plan\\.json`));
	assert.equal(getStaged(s.id), undefined, "staging is cleared");
	assert.ok(!existsSync(agentDir(trialAgentId(s.id))), "trial runs are cleared");
	assert.ok(loadAgent("oncall"));
	const again = await stageBundle(bundle, { cwd: work, jev: null as never });
	assert.equal(installStaged(again.id).id, "oncall-2", "an existing id isn't overwritten");
	discardStaged("nope");
	assert.ok(readFileSync(join(agentDir("oncall"), "agent.json"), "utf8").includes(work));
});

test("a folder outside home is still the WORKDIR, and ids inside it aren't offered separately", () => {
	const c = findParamCandidates({ id: "x", name: "x", prompt: "", cwd: "/private/tmp/c1c94182-953c-401f-a9a5-2da0e6716201/work", steps: [{ id: "a", type: "shell", run: "cat /private/tmp/c1c94182-953c-401f-a9a5-2da0e6716201/work/data.json" }] } as never, "/Users/alice");
	assert.deepEqual(c.map((x) => [x.suggestedId, x.value]), [["WORKDIR", "/private/tmp/c1c94182-953c-401f-a9a5-2da0e6716201/work"]]);
});

test("a connector with a dash is named as configured, though its tools carry an underscore prefix", async () => {
	const { saveMcpConfig } = await import("../src/extensions/mcp/client.ts");
	saveMcpConfig({ servers: { "cloudflare-docs": { url: "https://docs.mcp.cloudflare.com/mcp", enabled: true } } });
	const r = collectRequirements({ id: "x", name: "x", prompt: "", steps: [{ id: "a", type: "llm", prompt: "p", tools: ["cloudflare_docs__search_cloudflare_documentation"] }] } as never);
	assert.deepEqual(r.connectors, [{ id: "cloudflare-docs", service: "Cloudflare docs", tools: ["search_cloudflare_documentation"] }]);
	const { bundle } = buildBundle({ id: "x", name: "x", prompt: "", cwd: "/tmp", steps: [{ id: "a", type: "llm", prompt: "p", tools: ["cloudflare_docs__search_cloudflare_documentation"] }] } as never, { params: [] });
	const def = applyBundle(bundle, { values: {}, reflexUrl: "http://x", connectorMap: { "cloudflare-docs": "cf-docs" } });
	assert.deepEqual((def.steps![0] as { tools: string[] }).tools, ["cf_docs__search_cloudflare_documentation"], "renamed to the importer's tool prefix");
	saveMcpConfig({ servers: {} });
});
