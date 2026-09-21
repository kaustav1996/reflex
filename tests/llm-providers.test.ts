import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "reflex-llm-"));
process.env.REFLEX_HOME = home;
process.env.REFLEX_CODING_AGENT_DIR = join(home, "agent");
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
const { COMPAT_PRESETS, listCompatProviders, listEndpointModels, normalizeBaseUrl, removeCompatProvider, saveCompatProvider, SUBSCRIPTION_LOGINS, startLogin } = await import("../src/llm/providers.ts");
const { getPiAgentDir } = await import("../src/config.ts");

test("subscription sign-ins map to Pi's OAuth provider ids", () => {
	assert.deepEqual(SUBSCRIPTION_LOGINS.map((p) => p.id), ["anthropic", "openai-codex", "github-copilot"]);
	assert.throws(() => startLogin("openrouter"), /no subscription sign-in/);
});

test("an OpenAI-compatible endpoint is written as a Pi custom provider, 0600, with safe compat flags", () => {
	const saved = saveCompatProvider({ name: "Ollama", baseUrl: "http://localhost:11434/v1/", models: ["llama3.1:8b", "llama3.1:8b", " qwen2.5-coder:7b "] });
	assert.deepEqual(saved, { name: "ollama", baseUrl: "http://localhost:11434/v1", hasKey: false, models: ["llama3.1:8b", "qwen2.5-coder:7b"] });
	const file = join(getPiAgentDir(), "models.json");
	const p = JSON.parse(readFileSync(file, "utf8")).providers.ollama;
	assert.deepEqual([p.api, p.apiKey, p.compat.supportsDeveloperRole, p.compat.supportsReasoningEffort], ["openai-completions", "none", false, false]);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	saveCompatProvider({ name: "litellm", baseUrl: "https://llm.example.com/v1", apiKey: "sk-proxy", models: ["gpt-x"] });
	assert.deepEqual(listCompatProviders().map((e) => [e.name, e.hasKey]), [["ollama", false], ["litellm", true]]);
	removeCompatProvider("ollama");
	assert.deepEqual(listCompatProviders().map((e) => e.name), ["litellm"]);
});

test("input is validated", () => {
	assert.throws(() => saveCompatProvider({ name: "Bad Name!", baseUrl: "http://x/v1", models: ["m"] }), /provider name/);
	assert.throws(() => saveCompatProvider({ name: "ok", baseUrl: "localhost:11434", models: ["m"] }), /http/);
	assert.throws(() => saveCompatProvider({ name: "ok", baseUrl: "http://x/v1", models: [] }), /at least one model/);
	assert.equal(normalizeBaseUrl(" https://x/v1// "), "https://x/v1");
	assert.ok(COMPAT_PRESETS.some((p) => p.id === "ollama" && p.baseUrl.endsWith(":11434/v1")));
});

test("models are read from <baseUrl>/models in either the OpenAI or the Ollama shape, with the key as a bearer token", async () => {
	let auth: string | undefined;
	const openai = (async (url: string, init: RequestInit) => {
		auth = (init.headers as Record<string, string>).Authorization;
		assert.equal(url, "http://h/v1/models");
		return new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }, { id: "a" }] }), { status: 200 });
	}) as unknown as typeof fetch;
	assert.deepEqual(await listEndpointModels("http://h/v1/", "k", openai), ["a", "b"]);
	assert.equal(auth, "Bearer k");
	const ollama = (async () => new Response(JSON.stringify({ models: [{ name: "llama3" }] }), { status: 200 })) as unknown as typeof fetch;
	assert.deepEqual(await listEndpointModels("http://h/v1", undefined, ollama), ["llama3"]);
	await assert.rejects(listEndpointModels("http://h/v1", undefined, (async () => new Response("no", { status: 401 })) as unknown as typeof fetch), /HTTP 401/);
});
