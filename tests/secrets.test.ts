import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getReflexHome } from "../src/config.ts";
import { dotenvNames, dotenvSecretValues, isValidEnvName, maskSecret, protectFromGit, redactSecrets, resolveDestination, upsertDotenv, writeSecret } from "../src/extensions/secrets/store.ts";

test("env names must be UPPER_SNAKE_CASE", () => {
	assert.ok(isValidEnvName("STRIPE_SECRET_KEY"));
	assert.ok(!isValidEnvName("stripe"));
	assert.ok(!isValidEnvName("1KEY"));
	assert.ok(!isValidEnvName("KEY; rm -rf"));
});

test("upsertDotenv appends, replaces and quotes", () => {
	let r = upsertDotenv("", "A", "plain");
	assert.equal(r.text, "A=plain\n");
	assert.equal(r.replaced, false);
	r = upsertDotenv("# c\nexport A=old\nB=2\n", "A", "with space #x");
	assert.equal(r.text, "# c\nA='with space #x'\nB=2\n");
	assert.equal(r.replaced, true);
	r = upsertDotenv("B=2", "A", `it's "q"`);
	assert.equal(r.text, `B=2\nA="it's \\"q\\""\n`);
	// prefix names don't collide
	r = upsertDotenv("AB=1\n", "A", "x");
	assert.equal(r.text, "AB=1\nA=x\n");
});

test("writeSecret creates 0600 file and dotenvNames/dotenvSecretValues read it", () => {
	const dir = mkdtempSync(join(tmpdir(), "reflex-sec-"));
	const file = join(dir, ".env");
	assert.deepEqual(writeSecret(file, "MY_TOKEN", "abcdefghijkl"), { replaced: false, created: true });
	writeSecret(file, "PORT", "3000");
	assert.deepEqual(dotenvNames(file), ["MY_TOKEN", "PORT"]);
	const vals = dotenvSecretValues(file);
	assert.equal(vals.get("MY_TOKEN"), "abcdefghijkl");
	assert.ok(!vals.has("PORT"));
	assert.equal(readFileSync(file, "utf8"), "MY_TOKEN=abcdefghijkl\nPORT=3000\n");
});

test("maskSecret never reveals more than 5 chars", () => {
	assert.equal(maskSecret("sk-live-1234567890ab"), "sk-…ab");
	assert.equal(maskSecret("short"), "•••••");
});

test("redactSecrets replaces every occurrence, longest first", () => {
	const m = new Map([["A_KEY", "abcdef123456"], ["B_KEY", "abcdef"]]);
	assert.equal(redactSecrets("x abcdef123456 y abcdef z", m), "x [REDACTED:A_KEY] y [REDACTED:B_KEY] z");
	assert.equal(redactSecrets("nothing", m), "nothing");
});

test("resolveDestination stays inside the project and only accepts dotenv files", () => {
	const cwd = "/tmp/proj";
	assert.equal(resolveDestination(undefined, cwd).file, "/tmp/proj/.env");
	assert.equal(resolveDestination(".env.local", cwd).label, ".env.local");
	assert.equal(resolveDestination("apps/api/.env", cwd).file, "/tmp/proj/apps/api/.env");
	assert.equal(resolveDestination("global", cwd).file, join(getReflexHome(), ".env"));
	assert.throws(() => resolveDestination("../.env", cwd), /inside the project/);
	assert.throws(() => resolveDestination("config.json", cwd), /dotenv-style/);
});

test("protectFromGit adds .env to .gitignore and reports tracked files", () => {
	const cwd = mkdtempSync(join(tmpdir(), "reflex-git-"));
	execFileSync("git", ["init", "-q"], { cwd });
	const file = join(cwd, ".env");
	writeFileSync(file, "A=1\n");
	const r = protectFromGit(file, cwd);
	assert.deepEqual(r, { tracked: false, ignored: true, added: true });
	assert.equal(readFileSync(join(cwd, ".gitignore"), "utf8"), ".env\n");
	assert.deepEqual(protectFromGit(file, cwd), { tracked: false, ignored: true });
	const other = join(cwd, ".env.tracked");
	writeFileSync(other, "B=2\n");
	execFileSync("git", ["add", "-f", ".env.tracked"], { cwd });
	assert.equal(protectFromGit(other, cwd).tracked, true);
});
