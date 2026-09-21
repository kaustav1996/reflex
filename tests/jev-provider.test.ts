import assert from "node:assert/strict";
import { test } from "node:test";
import { TypesafeClient } from "../src/extensions/typesafe/client.ts";
import { chosenProvider, JEV_BASE_URL, jevModelFor, listJevModels, resolveJevRoute } from "../src/extensions/typesafe/provider.ts";

const cfg = (reflex: Record<string, unknown>) => ({ reflex: { model: "jev-latest", timeoutMs: 4000, ...reflex } }) as never;
const both = { typesafe: "ts", openrouter: "or" };

test("the user's provider choice is used as is, and never switches to the other service", () => {
	assert.deepEqual(chosenProvider(cfg({ provider: "openrouter" }), both), { provider: "openrouter", chosen: true });
	assert.equal(resolveJevRoute(cfg({ provider: "openrouter" }), both)?.baseUrl, "https://openrouter.ai/api/v1");
	// chosen TypeSafe but only an OpenRouter key exists → unreachable, not a silent switch
	assert.equal(resolveJevRoute(cfg({ provider: "typesafe" }), { openrouter: "or" }), undefined);
});

test("an install that has not chosen yet gets a stated default, flagged as not chosen", () => {
	assert.deepEqual(chosenProvider(cfg({}), both), { provider: "typesafe", chosen: false });
	assert.deepEqual(chosenProvider(cfg({}), { openrouter: "or" }), { provider: "openrouter", chosen: false });
	assert.deepEqual(chosenProvider(cfg({ provider: "auto" }), both), { provider: "typesafe", chosen: false }); // legacy value
});

test("the model is remembered per provider, because ids differ between providers", () => {
	const c = cfg({ provider: "openrouter", models: { typesafe: "jev-preview", openrouter: "typesafe/jev-1.13" } });
	assert.equal(jevModelFor(c, "typesafe"), "jev-preview");
	assert.equal(resolveJevRoute(c, both)?.model, "typesafe/jev-1.13");
	assert.equal(jevModelFor(cfg({}), "openrouter"), "~typesafe/jev-latest");
	assert.equal(jevModelFor(cfg({ model: "jev-1.13.0" }), "typesafe"), "jev-1.13.0"); // legacy shared field was a TypeSafe id
	assert.equal(jevModelFor(cfg({ model: "jev-1.13.0" }), "openrouter"), "~typesafe/jev-latest");
});

test("model lists come from each provider's own endpoint, with an offline fallback", async () => {
	const seen: string[] = [];
	const fetchImpl = (async (url: string) => {
		seen.push(url);
		if (url.includes("typesafe.ai")) return new Response(JSON.stringify({ models: [{ name: "jev-latest" }, { name: "jev-preview", description: "preview" }] }), { status: 200 });
		return new Response(JSON.stringify({ data: [{ id: "~typesafe/jev-latest", name: "Jev Latest" }, { id: "typesafe/jev-1.13", pricing: { prompt: "0.000000042" } }, { id: "other/model" }] }), { status: 200 });
	}) as unknown as typeof fetch;
	const ts = await listJevModels("typesafe", "k", fetchImpl);
	assert.deepEqual([ts.live, ts.models.map((m) => m.id)], [true, ["jev-latest", "jev-preview"]]);
	const or = await listJevModels("openrouter", undefined, fetchImpl);
	assert.deepEqual(or.models.map((m) => m.id), ["~typesafe/jev-latest", "typesafe/jev-1.13"]);
	assert.ok(Math.abs((or.models[1].inputPerMillion ?? 0) - 0.042) < 1e-9);
	assert.deepEqual(seen, ["https://api.typesafe.ai/v1/models", "https://openrouter.ai/api/v1/models?output_modalities=decisions"]);
	const down = await listJevModels("openrouter", undefined, (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
	assert.deepEqual([down.live, down.models.length > 0], [false, true]);
});

test("the client posts the route's model to <baseUrl>/systemone and records OpenRouter's cost", async () => {
	let seen: { url?: string; auth?: string; body?: { model?: string } } = {};
	const fetchImpl = (async (url: string, init: RequestInit) => {
		seen = { url, auth: (init.headers as Record<string, string>).Authorization, body: JSON.parse(String(init.body)) };
		return new Response(JSON.stringify({ model: "typesafe/jev-1.13-20260917", answers: { ok: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 100, output_tokens: 10, cost: 0.0000042 } }), { status: 200 });
	}) as unknown as typeof fetch;
	const client = new TypesafeClient("or-key", { baseUrl: JEV_BASE_URL.openrouter, provider: "openrouter", model: "typesafe/jev-1.13", fetchImpl });
	await client.systemOne({ state: "x", questions: { ok: { type: "noul", instructions: "?" } } });
	assert.deepEqual([seen.url, seen.auth, seen.body?.model], ["https://openrouter.ai/api/v1/systemone", "Bearer or-key", "typesafe/jev-1.13"]);
	assert.ok(Math.abs(client.stats.costUsd - 0.0000042) < 1e-12);
});
