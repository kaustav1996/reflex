import assert from "node:assert/strict";
import { test } from "node:test";
import { TypesafeClient } from "../src/extensions/typesafe/client.ts";
import { JEV_BASE_URL, missingJevHint, normalizeSetting, resolveJevRoute } from "../src/extensions/typesafe/provider.ts";

test("auto prefers a TypeSafe key and falls back to the OpenRouter key", () => {
	assert.equal(resolveJevRoute("auto", { typesafe: "ts", openrouter: "or" })?.provider, "typesafe");
	const r = resolveJevRoute("auto", { openrouter: "or" });
	assert.deepEqual([r?.provider, r?.baseUrl, r?.key], ["openrouter", "https://openrouter.ai/api/v1", "or"]);
	assert.equal(resolveJevRoute("auto", {}), undefined);
});

test("an explicit provider never silently switches to the other one", () => {
	assert.equal(resolveJevRoute("openrouter", { typesafe: "ts", openrouter: "or" })?.provider, "openrouter");
	assert.equal(resolveJevRoute("typesafe", { openrouter: "or" }), undefined);
	assert.match(missingJevHint("typesafe"), /TYPESAFE_API_KEY/);
	assert.equal(normalizeSetting("nonsense"), "auto");
});

test("the client posts to <baseUrl>/systemone with the route's key and records OpenRouter's cost", async () => {
	let seen: { url?: string; auth?: string; body?: { model?: string } } = {};
	const fetchImpl = (async (url: string, init: RequestInit) => {
		seen = { url, auth: (init.headers as Record<string, string>).Authorization, body: JSON.parse(String(init.body)) };
		return new Response(JSON.stringify({ model: "typesafe/jev-1.13-20260917", provider: "TypeSafe", id: "gen-dec-1", answers: { ok: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 100, output_tokens: 10, cost: 0.0000042 } }), { status: 200 });
	}) as unknown as typeof fetch;
	const client = new TypesafeClient("or-key", { baseUrl: JEV_BASE_URL.openrouter, provider: "openrouter", fetchImpl });
	const res = await client.systemOne({ state: "x", questions: { ok: { type: "noul", instructions: "?" } } });
	assert.equal(seen.url, "https://openrouter.ai/api/v1/systemone");
	assert.equal(seen.auth, "Bearer or-key");
	assert.equal(seen.body?.model, "jev-latest");
	assert.equal(res.answers.ok.noul, 0.9);
	assert.equal(client.provider, "openrouter");
	assert.ok(Math.abs(client.stats.costUsd - 0.0000042) < 1e-12);
});
