import assert from "node:assert/strict";
import { test } from "node:test";
import { PRESETS, ENDPOINTS, findPreset } from "../src/extensions/mcp/presets.ts";

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
