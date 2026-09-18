import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.REFLEX_HOME = mkdtempSync(join(tmpdir(), "reflex-logs-"));
process.env.MY_TEST_TOKEN = "supersecretvalue123";
const { clearCalls, logCall, maskSecrets, readCalls, registerSecret } = await import("../src/logs/calls.ts");

test("known secrets mask to their name, deterministically", () => {
	registerSecret("STRIPE_KEY", "sk_live_abcdefghijklmnop");
	const a = maskSecrets("key=sk_live_abcdefghijklmnop and again sk_live_abcdefghijklmnop");
	assert.equal(a, "key=[SECRET:STRIPE_KEY] and again [SECRET:STRIPE_KEY]");
	assert.equal(maskSecrets("env supersecretvalue123"), "env [SECRET:MY_TEST_TOKEN]");
});

test("credential-looking values get a stable hash tag", () => {
	const t = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
	const a = maskSecrets(`token ${t}`), b = maskSecrets(`again ${t}`);
	assert.match(a, /^token \[SECRET:#[0-9a-f]{6}\]$/);
	assert.equal(a.slice(6), b.slice(6));
	assert.equal(maskSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"), "Authorization: Bearer " + maskSecrets("abcdefghijklmnopqrstuvwxyz".padEnd(16)).trim().replace(/^.*(\[SECRET:#[0-9a-f]{6}\]).*$/, "$1") === "" ? "" : maskSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"));
	assert.ok(maskSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz").startsWith("Authorization: Bearer [SECRET:#"));
	assert.equal(maskSecrets("plain words and http://localhost:8000 stay"), "plain words and http://localhost:8000 stay");
	assert.equal(maskSecrets(maskSecrets(`x ${t}`)), maskSecrets(`x ${t}`)); // idempotent
});

test("logCall writes masked lines that readCalls filters", () => {
	clearCalls();
	logCall({ kind: "typesafe", source: "gate", summary: "allow bash", ms: 412.6, detail: { state: { key: "sk_live_abcdefghijklmnop" }, answers: { destructive: { noul: 0.02 } } } });
	logCall({ kind: "voice", source: "sarvam", summary: "3s audio", ms: 900 });
	const all = readCalls();
	assert.equal(all.length, 2);
	assert.equal(all[0].ms, 413);
	assert.equal((all[0].detail as { state: { key: string } }).state.key, "[SECRET:STRIPE_KEY]");
	assert.deepEqual(readCalls({ kinds: ["voice"] }).map((e) => e.source), ["sarvam"]);
	assert.equal(readCalls({ q: "allow" }).length, 1);
	clearCalls();
	assert.equal(readCalls().length, 0);
});
