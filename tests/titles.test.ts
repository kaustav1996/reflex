import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanTitle, projectName } from "../src/web/titles.ts";

test("a title is the first real line of what was asked", () => {
	assert.equal(cleanTitle("fix the login bug\n\nit fails on safari"), "Fix the login bug");
	assert.equal(cleanTitle("## **Deploy** the `api`"), "Deploy the api");
	assert.equal(cleanTitle("```\nstack trace\n```\nwhy does this crash?"), "Why does this crash?");
});

test("slash commands and empty prompts do not title a session", () => {
	assert.equal(cleanTitle("/reflex status"), undefined);
	assert.equal(cleanTitle("/model\nthen build the sidebar"), "Then build the sidebar");
	assert.equal(cleanTitle("   \n"), undefined);
	assert.equal(cleanTitle(undefined), undefined);
});

test("long titles are cut at a word and marked", () => {
	const t = cleanTitle("build a typesafe coding agent with multi provider support and a web interface that deploys artifacts")!;
	assert.ok(t.length <= 73, t);
	assert.ok(t.endsWith("…"));
	assert.ok(!t.includes("  "));
	assert.ok(!/\s…$/.test(t));
});

test("the project header is the folder name", () => {
	assert.equal(projectName("/Users/me/code/reflex"), "reflex");
	assert.equal(projectName("/Users/me/code/reflex/"), "reflex");
});
