import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { netlifyCliAuth, renderCliAuth, resolveNetlify, resolveRender } from "../src/artifacts/providers.ts";

const dir = mkdtempSync(join(tmpdir(), "reflex-prov-"));

test("netlify CLI config: users[userId].auth.token wins over env unless ARTIFACTS_NETLIFY_AUTH=env", () => {
	const f = join(dir, "netlify.json");
	writeFileSync(f, JSON.stringify({ userId: "u1", users: { u0: { email: "old@x", auth: { token: "nfp_old" } }, u1: { email: "me@x", auth: { token: "nfp_current_token_123" } } } }));
	process.env.REFLEX_NETLIFY_CONFIG = f;
	assert.deepEqual(netlifyCliAuth(), { token: "nfp_current_token_123", source: "cli", account: "me@x" });
	process.env.NETLIFY_API_KEY = "nfp_env";
	assert.equal(resolveNetlify()?.source, "cli");
	process.env.ARTIFACTS_NETLIFY_AUTH = "env";
	assert.equal(resolveNetlify()?.token, "nfp_env");
	delete process.env.ARTIFACTS_NETLIFY_AUTH;
	delete process.env.NETLIFY_API_KEY;
});

test("render cli.yaml: api.key + workspace, expired tokens ignored", () => {
	const f = join(dir, "cli.yaml");
	writeFileSync(f, `version: 1\nworkspace: tea-abc123\nworkspace_name: Team\napi:\n  key: rnd_cli_token_xyz\n  expires_at: ${Math.floor(Date.now() / 1000) + 3600}\n  host: https://api.render.com\n`);
	process.env.RENDER_CLI_CONFIG_PATH = f;
	const a = renderCliAuth();
	assert.equal(a?.token, "rnd_cli_token_xyz");
	assert.equal(a?.account, "tea-abc123");
	assert.equal(resolveRender()?.source, "cli");
	writeFileSync(f, `workspace: tea-abc123\napi:\n  key: rnd_expired\n  expires_at: 1000\n`);
	assert.equal(renderCliAuth(), undefined);
	process.env.RENDER_API_KEY = "rnd_env";
	assert.equal(resolveRender()?.source, "env");
	delete process.env.RENDER_API_KEY;
	delete process.env.RENDER_CLI_CONFIG_PATH;
});
