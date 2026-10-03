/**
 * Model router: before each new user prompt, Jev classifies the request into a
 * tier (fast / default / strong) and Reflex switches the LLM accordingly.
 * Only runs when the user configured tier models and enabled routing.
 *
 * The user stays in charge for their session: picking a model (/model, /models, the web model
 * picker, cycling) pins it and pauses routing until `/reflex route auto`; `/reflex session …`
 * replaces the tier models for this session only. Neither is saved.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { type ChoiceAnswer, isValidChoice } from "./client.js";
import { clip, snapshotSession } from "./context.js";
import { buildRoutingQuestion, confidenceBand, ROUTE_MIN_CONFIDENCE, ROUTE_TIERS } from "./policy.js";
import { logDecision, logOutcome } from "../../logs/decisions.js";
import { contextTokensFrom, type Rates, worthSwitching } from "./cache.js";
import type { ReflexState, RouteTier } from "./state.js";

export function parseModelRef(ref: string): { provider: string; id: string } | undefined {
	const i = ref.indexOf("/");
	if (i <= 0) return undefined;
	return { provider: ref.slice(0, i), id: ref.slice(i + 1) };
}

/** The tier models and efforts in force this session: session overrides first, then the saved ones. */
export function effectiveRouting(state: Pick<ReflexState, "config" | "sessionRoute">): { tiers: Partial<Record<RouteTier, string>>; effort: Partial<Record<RouteTier, string>> } {
	const saved = state.config.reflex;
	return {
		tiers: { ...saved.routing, ...state.sessionRoute.routing },
		effort: { ...(saved.routingEffort ?? {}), ...state.sessionRoute.effort },
	};
}

/** One status line saying how models are chosen in this session. */
export function routeStatus(state: Pick<ReflexState, "config" | "sessionRoute">): string | undefined {
	if (!state.config.reflex.routeModels) return undefined;
	if (state.sessionRoute.pinned) return `📌 ${state.sessionRoute.pinned} · routing paused (/reflex route auto)`;
	const own = Object.keys(state.sessionRoute.routing).length + Object.keys(state.sessionRoute.effort).length;
	return own ? "⇄ routing · session tiers" : undefined;
}

export function registerRouter(pi: ExtensionAPI, state: ReflexState): void {
	// How much context the next turn carries, and whether anything is cached for the current model.
	pi.on("turn_end", (event) => {
		const tokens = contextTokensFrom((event.message as { usage?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number } }).usage);
		if (tokens) {
			state.contextTokens = tokens;
			state.cacheIsCold = false;
		}
	});
	// A compaction throws the cache away by itself, so the next switch is free.
	pi.on("session_compact", () => {
		state.cacheIsCold = true;
		state.contextTokens = 0;
	});


	// A model the user picks is theirs for the session: pin it and stop routing over it.
	pi.on("model_select", async (event, ctx) => {
		if (state.routerSwitching || event.source === "restore") return;
		// Switching back by hand is the clearest signal the tier was wrong.
		if (state.pending.route) {
			logOutcome(state.pending.route, "user-overrode-model", `${event.model.provider}/${event.model.id}`);
			state.pending.route = undefined;
		}
		state.sessionRoute.pinned = `${event.model.provider}/${event.model.id}`;
		if (ctx.hasUI) {
			ctx.ui.setStatus("reflex-route", routeStatus(state));
			if (state.config.reflex.routeModels) ctx.ui.notify(`Model ${state.sessionRoute.pinned} pinned for this session; Reflex routing is paused. /reflex route auto resumes it.`, "info");
		}
	});

}

/** The routing question for this request, or undefined when routing doesn't apply to it. */
export function routingQuestion(state: ReflexState, prompt: string): ReturnType<typeof buildRoutingQuestion> | undefined {
	const policy = state.config.reflex;
	if (!policy.enabled || !policy.routeModels) return undefined;
	if (state.sessionRoute.pinned) return undefined;
	const { tiers } = effectiveRouting(state);
	if (Object.entries(tiers).filter(([, v]) => !!v).length < 2) return undefined;
	if (prompt.length < 8) return undefined;
	// Name the models the user actually has, with their prices: a concrete choice beats three words.
	const { effort } = effectiveRouting(state);
	const described: Partial<Record<RouteTier, { ref: string; effort?: string }>> = {};
	for (const [name, ref] of Object.entries(tiers)) if (ref) described[name as RouteTier] = { ref, effort: effort[name as RouteTier] };
	return buildRoutingQuestion(described);
}

/** Switch the model (and the effort) for the tier Jev picked. */
export async function applyRouting(pi: ExtensionAPI, ctx: ExtensionContext, state: ReflexState, answer: ChoiceAnswer, log: { model?: string; qhash?: string } = {}): Promise<void> {
	if (!isValidChoice(answer, Object.keys(ROUTE_TIERS))) return;
	const { tiers, effort: efforts } = effectiveRouting(state);
	state.router.decisions++;
	state.router.byTier[answer.choice] = (state.router.byTier[answer.choice] ?? 0) + 1;
	// Unsure means the default tier, never the tier the previous request happened to get.
	const unsure = answer.confidence < ROUTE_MIN_CONFIDENCE;
	const tier: RouteTier = unsure ? "default" : (answer.choice as RouteTier);
	const target = tiers[tier] ?? tiers.default;
	state.record("route", `${answer.choice} @ ${Math.round(answer.confidence * 100)}%${unsure ? " (unsure → default)" : ""} → ${target ?? "(unchanged)"}`);
	// Switching may cost more than it saves: switchModel prices it and returns why it declined.
	const kept = target ? await switchModel(pi, ctx, state, target, tier, answer.confidence) : undefined;
	state.pending.route = logDecision({
		source: "route",
		model: log.model,
		qhash: log.qhash,
		action: !target ? "no-tier-model" : kept ? `kept-for-cache:${tier}` : `switch:${tier}`,
		rule: kept ? "cache-not-worth-losing" : unsure ? "unsure-to-default" : "tier",
		band: confidenceBand(answer.confidence),
		summary: `${answer.choice} → ${kept ? "(kept the current model)" : (target ?? "(unchanged)")}`,
		signals: { tier: { primitive: "choice", value: answer.probabilities[answer.choice] ?? answer.confidence, pick: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities, threshold: ROUTE_MIN_CONFIDENCE } },
		detail: { target, effort: efforts[tier], contextTokens: state.contextTokens, keptForCache: kept },
	});
	if (!target || kept) return;
	const effort = efforts[tier] ?? (tiers[tier] ? undefined : efforts.default);
	if (effort && effort !== ctx.thinkingLevel) {
		try {
			pi.setThinkingLevel(effort as never);
			state.record("route", `effort → ${effort} (${tier} tier)`);
		} catch {}
	}
}

async function switchModel(pi: ExtensionAPI, ctx: ExtensionContext, state: ReflexState, ref: string, tier: string, confidence: number): Promise<string | undefined> {
	const parsed = parseModelRef(ref);
	if (!parsed) return undefined;
	const current = ctx.model;
	if (current && current.provider === parsed.provider && current.id === parsed.id) return undefined;
	const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
	if (!model) {
		if (ctx.hasUI) ctx.ui.notify(`⚡ Reflex router: model ${ref} not found`, "warning");
		return undefined;
	}
	// A switch throws away the prompt cache this session has built up. Check that it is worth it.
	const stay = ratesOf(current && ctx.modelRegistry.find(current.provider, current.id));
	const target = ratesOf(model);
	// Without prices the switch cannot be judged, so it goes ahead — but the log says why, rather
	// than leaving a gate that looks active and never fires.
	if (!stay || !target) state.record("route", `switching to ${model.id} without pricing it: the model registry has no cost for ${!stay ? current?.id ?? "the current model" : model.id}`);
	if (stay && target) {
		const verdict = worthSwitching({ contextTokens: state.contextTokens, stay, target, free: state.cacheIsCold });
		if (!verdict.switch) {
			state.router.cacheKeeps++;
			state.record("route", `kept ${current?.id ?? "the current model"}: ${verdict.reason}`);
			return verdict.reason;
		}
	}
	state.routerSwitching = true;
	let ok = false;
	try {
		ok = await pi.setModel(model);
	} finally {
		state.routerSwitching = false;
	}
	if (ok) {
		state.router.switches++;
		// The new model starts with nothing cached; the next turn's arithmetic must know that.
		state.cacheIsCold = false;
		if (ctx.hasUI) ctx.ui.notify(`⚡ Reflex routed to ${tier} tier: ${model.id} (${Math.round(confidence * 100)}%)`, "info");
	}
	return undefined;
}

/**
 * Per-token rates for a model. Pi's registry quotes dollars per *million* tokens, so the numbers are
 * scaled here — otherwise every figure in a reason is a million times too large.
 */
function ratesOf(model: { cost?: Partial<Rates> } | undefined): Rates | undefined {
	const c = model?.cost;
	if (!c || typeof c.input !== "number" || typeof c.output !== "number") return undefined;
	const per = (n: number) => n / 1e6;
	return { input: per(c.input), output: per(c.output), cacheRead: per(c.cacheRead ?? c.input), cacheWrite: per(c.cacheWrite ?? 0) };
}
