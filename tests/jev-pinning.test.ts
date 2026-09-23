import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.REFLEX_HOME = mkdtempSync(join(tmpdir(), "reflex-jev-pin-"));
process.env.REFLEX_NO_CALL_LOG = "1";
const { DEFAULT_JEV_MODEL, LATEST_JEV_MODEL, jevModelFor, listJevModels, unpinnedJevModel } = await import("../src/extensions/typesafe/provider.ts");
const { questionHash, noul, choice } = await import("../src/extensions/typesafe/client.ts");

const config = (reflex: Record<string, unknown>) => ({ reflex } as never);

test("the default Jev model is a version, not a moving alias", () => {
	for (const provider of ["typesafe", "openrouter"] as const) {
		assert.equal(unpinnedJevModel(DEFAULT_JEV_MODEL[provider]), false, `${provider} default should be pinned`);
		assert.equal(unpinnedJevModel(LATEST_JEV_MODEL[provider]), true);
		assert.equal(jevModelFor(config({}), provider), DEFAULT_JEV_MODEL[provider]);
	}
	assert.equal(unpinnedJevModel("jev-preview"), true, "a preview also moves");
	// An explicit choice is kept, including opting back into the alias.
	assert.equal(jevModelFor(config({ models: { typesafe: "jev-latest" } }), "typesafe"), "jev-latest");
	assert.equal(jevModelFor(config({ model: "jev-1.12.0" }), "typesafe"), "jev-1.12.0", "the older single-model config still wins");
});

test("the picker offers the pinned default even when the provider only advertises aliases", async () => {
	// TypeSafe's live list really does contain only jev-latest and jev-preview.
	const fake = (async () => new Response(JSON.stringify({ models: [{ name: "jev-latest" }, { name: "jev-preview" }] }), { status: 200 })) as unknown as typeof fetch;
	const r = await listJevModels("typesafe", "key", fake);
	assert.equal(r.live, true);
	assert.equal(r.models[0].id, DEFAULT_JEV_MODEL.typesafe, "the pinned default is offered first");
	assert.ok(r.models.some((m) => m.id === "jev-latest"), "the alias stays available as an opt-in");
	const offline = await listJevModels("openrouter", undefined, (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch);
	assert.equal(offline.live, false);
	assert.ok(offline.models.some((m) => m.id === DEFAULT_JEV_MODEL.openrouter));
});

test("a question hash tracks the wording, not the situation", () => {
	const q = { safe: noul("Is this read-only?"), kind: choice("Which kind?", { a: "one", b: "two" }) };
	const same = { kind: choice("Which kind?", { a: "one", b: "two" }), safe: noul("Is this read-only?") };
	assert.equal(questionHash(q), questionHash(same), "question order doesn't change the hash");
	assert.notEqual(questionHash(q), questionHash({ safe: noul("Is this read only?"), kind: q.kind }), "rewording is a new question");
	assert.notEqual(questionHash(q), questionHash({ safe: noul("Is this read-only?"), kind: choice("Which kind?", { a: "one", b: "three" }) }), "changed criteria is a new question");
	assert.match(questionHash(q), /^[0-9a-f]{12}$/);
});
