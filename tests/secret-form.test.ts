import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SecretForm } from "../src/extensions/secrets/index.ts";

const theme = { fg: (_c: string, s: string) => `\x1b[35m${s}\x1b[39m`, bold: (s: string) => `\x1b[1m${s}\x1b[22m` } as never;
const tui = { requestRender() {} } as never;
const spec = {
	reason: "Configure the demo service integration ".repeat(6),
	destination: ".env",
	warnings: ["⚡ TypeSafe: only 33% likely that OPTIONAL_TOKEN is needed for your current task " + "x".repeat(200)],
	fields: [
		{ name: "GITHUB_ORG_TOKEN", description: "GitHub org token (Settings → Developer settings → Tokens) ".repeat(4), required: true, placeholder: "ghp_…" },
		{ name: "OPTIONAL_TOKEN", description: "Optional webhook token", required: false },
	],
};

test("secret form never renders past the terminal width", () => {
	for (const width of [40, 80, 153]) {
		const form = new SecretForm(tui, theme, spec, () => {});
		form.handleInput("a".repeat(300));
		for (const line of form.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)}`);
	}
});

test("secret form masks input, tabs between fields and submits on last Enter", () => {
	let result: unknown;
	const form = new SecretForm(tui, theme, spec, (r) => { result = r; });
	form.handleInput("secret-one");
	const masked = form.render(120).join("\n");
	assert.ok(!masked.includes("secret-one"));
	assert.ok(masked.includes("••••••••••"));
	form.handleInput("\r"); // Enter → next field
	form.handleInput("two");
	form.handleInput("\r"); // Enter on last field → submit
	assert.deepEqual(result, { values: { GITHUB_ORG_TOKEN: "secret-one", OPTIONAL_TOKEN: "two" } });
});

test("escape cancels", () => {
	let result: unknown;
	const form = new SecretForm(tui, theme, spec, (r) => { result = r; });
	form.handleInput("\x1b");
	assert.deepEqual(result, { cancelled: true });
});
