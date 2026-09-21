import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.REFLEX_HOME = mkdtempSync(join(tmpdir(), "reflex-ecc-"));
const { ECC_SERVERS } = await import("../src/extensions/mcp/ecc.ts");
const { PRESETS, PRESET_META, findPreset } = await import("../src/extensions/mcp/presets.ts");
const { buildPresetConfig } = await import("../src/extensions/mcp/connect.ts");

test("every ECC server becomes one connector card, and Reflex's own cards win on a clash", () => {
	const ids = PRESETS.map((p) => p.id);
	assert.equal(new Set(ids).size, ids.length, "no duplicate connector ids");
	for (const e of ECC_SERVERS) assert.equal(findPreset(e.id)?.source, "ECC", `${e.id} is listed as from ECC`);
	for (const own of ["supabase", "vercel", "railway", "atlassian"]) assert.equal(findPreset(own)?.source, undefined, `${own} stays Reflex's own card`);
	assert.equal(ECC_SERVERS.length, 31);
});

test("no ECC card carries a placeholder value from ECC's template", () => {
	for (const p of PRESETS.filter((x) => x.source === "ECC")) {
		const cfg = JSON.stringify(p.build({ apiKey: "k", fields: Object.fromEntries((p.fields ?? []).map((f) => [f.key, "v"])) }));
		assert.ok(!/YOUR_|\/absolute\/path|\/path\/to/.test(cfg), `${p.id} has a placeholder: ${cfg}`);
	}
});

test("a keyed local server gets its key in the environment", () => {
	const { server, result } = buildPresetConfig("github", { apiKey: "ghp_test" });
	assert.equal(result.auth, "api-key");
	assert.equal(server.command, "npx");
	assert.equal(server.env?.GITHUB_PERSONAL_ACCESS_TOKEN, "ghp_test");
	assert.equal(PRESET_META.find((m) => m.id === "github")?.transport, "local stdio");
});

test("a keyed remote server gets its key in the header it names", () => {
	assert.equal(buildPresetConfig("browser-use", { apiKey: "bu_1" }).server.headers?.["x-browser-use-api-key"], "bu_1");
	assert.equal(buildPresetConfig("memxus", { apiKey: "mx_1" }).server.headers?.Authorization, "Bearer mx_1");
});

test("extra fields go to the environment, or into the arguments when marked arg", () => {
	const jira = buildPresetConfig("jira", { apiKey: "tok", fields: { JIRA_URL: "https://x.atlassian.net", JIRA_EMAIL: "me@x.com" } }).server;
	assert.deepEqual([jira.env?.JIRA_URL, jira.env?.JIRA_EMAIL, jira.env?.JIRA_API_TOKEN], ["https://x.atlassian.net", "me@x.com", "tok"]);
	const fs = buildPresetConfig("filesystem", { fields: { FOLDER: "/tmp/projects" } }).server;
	assert.equal(fs.args?.at(-1), "/tmp/projects");
	assert.equal(fs.env?.FOLDER, undefined, "an arg field is not also set in the environment");
});

test("a missing field is refused with its label", () => {
	assert.throws(() => buildPresetConfig("jira", { apiKey: "tok", fields: { JIRA_URL: "https://x.atlassian.net" } }), /Account email/);
});

test("open and OAuth remotes, and fixed env values, are built as ECC describes them", () => {
	assert.deepEqual(buildPresetConfig("cloudflare-docs").server, { url: "https://docs.mcp.cloudflare.com/mcp", enabled: true });
	assert.equal(buildPresetConfig("cloudflare-docs").result.auth, "none");
	assert.equal(buildPresetConfig("clickhouse").server.args?.at(-1), "https://mcp.clickhouse.cloud/mcp");
	assert.equal(buildPresetConfig("ecc-memory-vault").server.env?.ECC_MEMORY_HARNESS, "reflex");
});
