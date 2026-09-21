import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createFormatExtension, FORMAT_NOTE } from "../src/extensions/ui/format.ts";

test("the system prompt says replies are markdown, once", async () => {
	let handler: ((e: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
	createFormatExtension()({ on: (_: string, h: typeof handler) => (handler = h) } as never);
	const first = await handler!({ systemPrompt: "base" });
	assert.equal(first?.systemPrompt, `base${FORMAT_NOTE}`);
	assert.equal(await handler!({ systemPrompt: `base${FORMAT_NOTE}` }), undefined, "not added twice");
});

test("the web renderer turns a model's <details> into a collapsible and escapes every other tag", () => {
	const html = readFileSync(new URL("../web/app.html", import.meta.url), "utf8");
	const src = `${html.match(/const esc = [^\n]+/)![0]}\n${html.match(/function md\(text\) \{[\s\S]*?\n\}/)![0]}; return md;`;
	const md = new Function(src)() as (t: string) => string;
	const out = md('Stdout was empty.\n\n<details class="w-full"><summary class="x">Root cause</summary>\n<div class="y">Uses `curl` here.</div></details>\n\n<img src=x onerror=alert(1)>');
	assert.match(out, /<details class="md-details"><summary>Root cause<\/summary><p>Uses <code>curl<\/code> here\.<\/p><\/details>/);
	assert.ok(!out.includes("<img"), "other tags stay escaped");
	assert.ok(!out.includes('class="w-full"'), "the model's own attributes are dropped");
});
