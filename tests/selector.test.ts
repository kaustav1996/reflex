import assert from "node:assert/strict";
import { test } from "node:test";
import { hintsFrom, MIN_HINT_PROBABILITY } from "../src/extensions/typesafe/selector.ts";
import type { ChoiceAnswer } from "../src/extensions/typesafe/client.ts";

function answer(choice: string, probabilities: Record<string, number>): ChoiceAnswer {
	return { type: "choice", choice, probabilities, confidence: Math.max(...Object.values(probabilities)) };
}

const skills = ["testing"];
const servers = ["github"];

test("a skill or connector hint requires at least the minimum probability", () => {
	assert.equal(MIN_HINT_PROBABILITY, 0.5);
	assert.deepEqual(
		hintsFrom(
			{
				skill: answer("testing", { none: 0.1, testing: 0.9 }),
				connector: answer("github", { none: 0.1, github: 0.9 }),
			},
			skills,
			servers,
		),
		[
			'skill "testing" (90%) — read its SKILL.md before starting',
			'connector "github" (90%) — its tools are named github__*',
		],
	);
	assert.deepEqual(
		hintsFrom(
			{
				skill: answer("testing", { none: 0.6, testing: 0.4 }),
				connector: answer("github", { none: 0.6, github: 0.4 }),
			},
			skills,
			servers,
		),
		[],
	);
	assert.deepEqual(
		hintsFrom({ skill: answer("testing", { none: 0.5, testing: 0.5 }) }, skills, servers),
		['skill "testing" (50%) — read its SKILL.md before starting'],
	);
});

test("none and choices outside the available lists never produce hints", () => {
	assert.deepEqual(
		hintsFrom(
			{
				skill: answer("unknown", { none: 0.1, testing: 0.1, unknown: 0.8 }),
				connector: answer("unknown", { none: 0.1, github: 0.1, unknown: 0.8 }),
			},
			skills,
			servers,
		),
		[],
	);
	assert.deepEqual(
		hintsFrom(
			{
				skill: answer("none", { none: 0.9, testing: 0.1 }),
				connector: answer("none", { none: 0.9, github: 0.1 }),
			},
			skills,
			servers,
		),
		[],
	);
});
