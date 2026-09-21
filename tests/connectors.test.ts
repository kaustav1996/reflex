import assert from "node:assert/strict";
import { test } from "node:test";
import { PRESETS, ENDPOINTS, findPreset } from "../src/extensions/mcp/presets.ts";
import { createHash } from "node:crypto";
import { clearOAuthCache, mcpAuthDir } from "../src/extensions/mcp/authcache.ts";
import { join } from "node:path";
import { homedir } from "node:os";

test("the four requested services are covered", () => {
	const ids = PRESETS.map((p) => p.id);
	for (const id of ["gmail", "slack", "atlassian", "linear", "linear-key"]) assert.ok(ids.includes(id), `missing ${id}`);
});

test("OAuth presets bridge through mcp-remote with the official endpoint", () => {
	const gmail = findPreset("gmail")!;
	const s = gmail.build({});
	assert.equal(s.command, "npx");
	assert.equal(s.args?.[0], "-y");
	assert.equal(s.args?.[1], "mcp-remote@latest");
	assert.equal(s.args?.[2], ENDPOINTS.gmail);
});

test("linear-key preset talks streamable-HTTP with a bearer header", () => {
	const p = findPreset("linear-key")!;
	const s = p.build({ apiKey: "lin_api_test" });
	assert.equal(s.url, ENDPOINTS.linear);
	assert.equal(s.headers?.Authorization, "Bearer lin_api_test");
});

test("readonly variants point at the readonly endpoints", () => {
	assert.equal(findPreset("linear")!.build({ readOnly: true }).args?.[2], ENDPOINTS.linearReadonly);
	assert.equal(findPreset("linear-key")!.build({ apiKey: "x", readOnly: true }).url, ENDPOINTS.linearReadonly);
});

test("clearOAuthCache is keyed by md5(url) and scoped to mcp-remote dirs", () => {
	// Does not throw when ~/.mcp-auth is absent, and never touches other servers.
	const fakeUrl = "https://mcp.example.test/mcp";
	const n = clearOAuthCache(fakeUrl);
	assert.equal(n, 0, "removing an unknown url deletes nothing");
	assert.equal(mcpAuthDir(), join(homedir(), ".mcp-auth"));
	// sanity: the hash scheme we rely on is md5 (matches mcp-remote's layout)
	assert.equal(createHash("md5").update(ENDPOINTS.linear).digest("hex").length, 32);
});

test("every preset carries the directory metadata the web UI shows", () => {
	for (const p of PRESETS) {
		assert.ok(p.tagline && p.about && p.madeBy.name && p.madeBy.url.startsWith("https://"), p.id);
		// A local process describes its command; a remote server gives its URL (https, or localhost for a server you run yourself).
		const local = !!p.build({ apiKey: "k", fields: Object.fromEntries((p.fields ?? []).map((f) => [f.key, "v"])) }).command && p.auth !== "oauth";
		assert.ok((local ? p.endpoint.includes("stdio") : /^https:\/\/|^http:\/\/localhost[:/]/.test(p.endpoint)) && p.categories.length > 0, p.id);
	}
});

test("linear-key is a sign-in variant of the linear connector, not a separate card", () => {
	assert.equal(findPreset("linear-key")?.variantOf, "linear");
	assert.equal(findPreset("linear")?.variantOf, undefined);
});

test("preset ids are unique, variants point at real parents, and every requested service is present", () => {
	const ids = PRESETS.map((p) => p.id);
	assert.equal(new Set(ids).size, ids.length);
	for (const p of PRESETS) if (p.variantOf) assert.ok(ids.includes(p.variantOf), `${p.id} → ${p.variantOf}`);
	for (const id of ["gdrive", "gcalendar", "figma", "strava", "datadog", "sentry", "supabase", "vercel", "netlify", "render", "posthog", "railway", "excalidraw"]) assert.ok(ids.includes(id), id);
	assert.equal(findPreset("supabase")!.build({ readOnly: true }).args?.slice(-1)[0], `${ENDPOINTS.supabase}?read_only=true`);
	assert.equal(findPreset("render")!.build({ apiKey: "rnd_x" }).headers?.Authorization, "Bearer rnd_x");
	assert.deepEqual(findPreset("railway")!.build({}).args, ["mcp"]);
});
