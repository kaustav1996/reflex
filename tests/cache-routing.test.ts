import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.REFLEX_HOME = mkdtempSync(join(tmpdir(), "reflex-cache-routing-"));
process.env.REFLEX_NO_CALL_LOG = "1";
const { contextTokensFrom, turnCost, worthSwitching } = await import("../src/extensions/typesafe/cache.ts");
const { buildRoutingQuestion } = await import("../src/extensions/typesafe/policy.ts");

// Per-token rates, in the shape Pi reports them. Cheap reads its cache at a tenth of input.
const strong = { input: 15 / 1e6, output: 75 / 1e6, cacheRead: 1.5 / 1e6, cacheWrite: 18.75 / 1e6 };
const cheap = { input: 0.6 / 1e6, output: 2.2 / 1e6, cacheRead: 0.06 / 1e6, cacheWrite: 0.75 / 1e6 };

test("a warm cache is most of what a long session costs", () => {
	const warm = turnCost({ contextTokens: 80000, newTokens: 600, outputTokens: 1200, cached: true }, strong);
	const cold = turnCost({ contextTokens: 80000, newTokens: 600, outputTokens: 1200, cached: false }, strong);
	assert.ok(cold > warm * 10, `cold ${cold} should dwarf warm ${warm}`);
});

test("stepping down mid-session is only worth it once the saving beats re-reading the context", () => {
	// Early on there is little context, so the cheaper model wins easily.
	const small = worthSwitching({ contextTokens: 2000, stay: strong, target: cheap });
	assert.equal(small.switch, true);
	assert.match(small.reason, /saves \$/);

	// Deep into a session, re-reading 120k tokens on the cheap model costs more than it saves.
	const large = worthSwitching({ contextTokens: 120000, stay: cheap, target: cheap });
	assert.equal(large.switch, false, "even the same rates lose, because the cache read is a tenth of input");
	assert.match(large.reason, /would cost \$.* more than it saves/);
});

test("the two free moments, and the asymmetry between stepping down and up", () => {
	const deep = { contextTokens: 120000, stay: cheap, target: cheap };
	assert.equal(worthSwitching({ ...deep, free: true }).switch, true, "a fresh session or a just-compacted one has no cache to lose");
	assert.match(worthSwitching({ ...deep, free: true }).reason, /no cache to lose/);

	// Stepping up is about what the work needs, so the cache arithmetic doesn't veto it.
	const up = worthSwitching({ contextTokens: 120000, stay: cheap, target: strong });
	assert.equal(up.switch, true);
	assert.match(up.reason, /capability, not price/);
	assert.ok(up.switchCost > up.stayCost, "and it is indeed more expensive: that is the trade being made");
});

test("the context carried into the next turn is everything the last one touched", () => {
	assert.equal(contextTokensFrom({ input: 1200, cacheRead: 38000, cacheWrite: 0, output: 800 }), 40000);
	assert.equal(contextTokensFrom(undefined), undefined);
	assert.equal(contextTokensFrom({}), undefined, "no usage reported means no estimate, not zero");
});

test("the routing question names the models the user has, with their prices", () => {
	const plain = buildRoutingQuestion();
	assert.match(JSON.stringify(plain.criteria.fast), /small, well-specified change/);
	assert.doesNotMatch(JSON.stringify(plain.criteria.fast), /\$/, "no prices when no models are known");

	const described = buildRoutingQuestion({
		fast: { ref: "openrouter/deepseek/deepseek-v4-flash", effort: "low", inputPerMillion: 0.3 },
		strong: { ref: "anthropic/claude-opus-5", effort: "high", inputPerMillion: 15 },
	});
	assert.match(described.criteria.fast as string, /openrouter\/deepseek\/deepseek-v4-flash at low effort \(about \$0\.30 per million/);
	assert.match(described.criteria.strong as string, /anthropic\/claude-opus-5 at high effort \(about \$15\.00 per million/);
	assert.match(described.criteria.fast as string, /small, well-specified change/, "the description still says what the tier is for");
	assert.match(described.criteria.default as string, /typical multi-step coding task/, "a tier with no model configured keeps its words");
});

test("the real rates, and where the line actually falls", () => {
	// Dollars per million, as Pi's registry quotes them, converted to per token here.
	const per = (c: { input: number; output: number; cacheRead: number; cacheWrite: number }) => ({ input: c.input / 1e6, output: c.output / 1e6, cacheRead: c.cacheRead / 1e6, cacheWrite: c.cacheWrite / 1e6 });
	const glm = per({ input: 0.6496, output: 2.0416, cacheRead: 0.12064, cacheWrite: 0 });
	const flash = per({ input: 0.049, output: 0.098, cacheRead: 0.0098, cacheWrite: 0 });

	// Stepping down to a model ~13x cheaper is worth it even with a warm cache and a big context —
	// though the margin narrows as the context grows, because the new model re-reads all of it:
	// at 15k tokens staying costs 5.3x the switch, at 120k only 2.9x.
	const down = worthSwitching({ contextTokens: 120000, stay: glm, target: flash });
	assert.equal(down.switch, true, down.reason);
	assert.ok(down.stayCost > down.switchCost * 2, `only ${(down.stayCost / down.switchCost).toFixed(2)}x`);
	const early = worthSwitching({ contextTokens: 15000, stay: glm, target: flash });
	assert.ok(early.stayCost / early.switchCost > down.stayCost / down.switchCost, "the saving shrinks as the context grows");

	// Two models at the same price never justify losing the cache, however the tier answer reads.
	const sideways = worthSwitching({ contextTokens: 40000, stay: glm, target: { ...glm } });
	assert.equal(sideways.switch, false);

	// A small saving does not pay for re-reading a large context.
	const marginal = worthSwitching({ contextTokens: 200000, stay: glm, target: per({ input: 0.6, output: 2.0, cacheRead: 0.12, cacheWrite: 0 }) });
	assert.equal(marginal.switch, false, marginal.reason);

	// Dollars, not millions of dollars: the figures in the reason must be readable as money.
	assert.match(sideways.reason, /\$\d\.\d{4}/);
	assert.ok(sideways.stayCost < 1, `a single turn should not cost $${sideways.stayCost}`);
});
