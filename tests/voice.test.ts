import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWav, parseWav, splitWav, wavDurationSeconds } from "../src/extensions/voice/recorder.ts";
import { loadDotEnv } from "../src/config.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("wav round-trip and splitting at 30s", () => {
	const seconds = 65;
	const pcm = Buffer.alloc(16000 * 2 * seconds, 1);
	const wav = buildWav(pcm, 16000);
	const info = parseWav(wav);
	assert.equal(info.sampleRate, 16000);
	assert.equal(info.dataLength, pcm.length);
	assert.equal(Math.round(wavDurationSeconds(wav)), seconds);
	const chunks = splitWav(wav, 29);
	assert.equal(chunks.length, 3);
	assert.ok(chunks.every((c) => wavDurationSeconds(c) <= 29.01));
	assert.equal(chunks.reduce((n, c) => n + parseWav(c).dataLength, 0), pcm.length);
});

test(".env loader sets only unset variables and handles quotes/export", () => {
	const dir = mkdtempSync(join(tmpdir(), "reflex-env-"));
	writeFileSync(join(dir, ".env"), `# comment\nREFLEX_TEST_A="hello world"\nexport REFLEX_TEST_B='x=y'\nREFLEX_TEST_C=already\n`);
	process.env.REFLEX_TEST_C = "kept";
	const loaded = loadDotEnv(dir);
	assert.deepEqual(loaded.sort(), ["REFLEX_TEST_A", "REFLEX_TEST_B"]);
	assert.equal(process.env.REFLEX_TEST_A, "hello world");
	assert.equal(process.env.REFLEX_TEST_B, "x=y");
	assert.equal(process.env.REFLEX_TEST_C, "kept");
});
