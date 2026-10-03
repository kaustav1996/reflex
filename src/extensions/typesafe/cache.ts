/**
 * Whether a model switch is worth what it costs.
 *
 * Prompt caches are per model. A session that has built up 40k tokens of context is reading that
 * context at the cache rate — often a tenth of the input price — and switching models throws it
 * away: the new model re-reads everything at full price, and pays to write its own cache. Routing a
 * turn to a cheaper model can therefore cost more than it saves, which is the opposite of the point.
 *
 * So the arithmetic is done before switching, with two exceptions where it is free:
 *   - the first turn of a session, where there is no cache to lose;
 *   - the turn after a compaction, where the cache was invalidated anyway.
 *
 * And one asymmetry worth stating plainly: this gate applies to stepping *down*. Stepping up to a
 * stronger model is a decision about capability, not price — if the work needs the better model,
 * paying to re-read the context is the point, not a regrettable side effect.
 */

export interface Rates {
	/** USD per token. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** What a turn costs on a model, given how much context it carries. */
export function turnCost(args: { contextTokens: number; newTokens: number; outputTokens: number; cached: boolean }, rates: Rates): number {
	const context = args.cached ? args.contextTokens * rates.cacheRead : args.contextTokens * rates.input + args.contextTokens * rates.cacheWrite;
	return context + args.newTokens * rates.input + args.outputTokens * rates.output;
}

export interface SwitchVerdict {
	switch: boolean;
	reason: string;
	stayCost: number;
	switchCost: number;
}

/** A conservative guess at the turn ahead, used only to compare two models against each other. */
export const ASSUMED_NEW_TOKENS = 600;
export const ASSUMED_OUTPUT_TOKENS = 1200;

/**
 * Compare staying (warm cache) against switching (cold cache on the other model).
 *
 * `free` covers the session's first turn and the turn after a compaction: nothing is lost, so the
 * routing answer stands on its own.
 */
export function worthSwitching(args: {
	contextTokens: number;
	stay: Rates;
	target: Rates;
	free?: boolean;
	newTokens?: number;
	outputTokens?: number;
}): SwitchVerdict {
	const newTokens = args.newTokens ?? ASSUMED_NEW_TOKENS;
	const outputTokens = args.outputTokens ?? ASSUMED_OUTPUT_TOKENS;
	const stayCost = turnCost({ contextTokens: args.contextTokens, newTokens, outputTokens, cached: true }, args.stay);
	const switchCost = turnCost({ contextTokens: args.contextTokens, newTokens, outputTokens, cached: false }, args.target);

	if (args.free) return { switch: true, reason: "no cache to lose", stayCost, switchCost };
	// Stepping up is about what the turn needs, not what it costs.
	if (args.target.input > args.stay.input) return { switch: true, reason: "stepping up: capability, not price", stayCost, switchCost };
	if (switchCost < stayCost) return { switch: true, reason: `saves $${(stayCost - switchCost).toFixed(4)} even after re-reading ${args.contextTokens} tokens`, stayCost, switchCost };
	return { switch: false, reason: `re-reading ${args.contextTokens} tokens would cost $${(switchCost - stayCost).toFixed(4)} more than it saves`, stayCost, switchCost };
}

/** Pi reports usage per turn; the context is what the next turn will carry in. */
export function contextTokensFrom(usage: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number } | undefined): number | undefined {
	if (!usage) return undefined;
	const carried = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0);
	return carried > 0 ? carried : undefined;
}
