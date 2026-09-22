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
import { isValidChoice } from "./client.js";
import { clip, snapshotSession } from "./context.js";
import { buildRoutingQuestion, ROUTE_TIERS } from "./policy.js";
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
	// A model the user picks is theirs for the session: pin it and stop routing over it.
	pi.on("model_select", async (event, ctx) => {
		if (state.routerSwitching || event.source === "restore") return;
		state.sessionRoute.pinned = `${event.model.provider}/${event.model.id}`;
		if (ctx.hasUI) {
			ctx.ui.setStatus("reflex-route", routeStatus(state));
			if (state.config.reflex.routeModels) ctx.ui.notify(`Model ${state.sessionRoute.pinned} pinned for this session; Reflex routing is paused. /reflex route auto resumes it.`, "info");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const policy = state.config.reflex;
		if (!policy.enabled || !policy.routeModels || !state.client) return undefined;
		if (state.sessionRoute.pinned) return undefined;
		const { tiers, effort: efforts } = effectiveRouting(state);
		const configured = Object.entries(tiers).filter(([, v]) => !!v);
		if (configured.length < 2) return undefined;
		const prompt = event.prompt?.trim();
		if (!prompt || prompt.startsWith("/") || prompt.length < 8) return undefined;

		// What the request continues: a short "go ahead" belongs to the task before it.
		let recent = "";
		try {
			recent = clip(snapshotSession(ctx, { maxToolCalls: 0 }).assistantText ?? "", 800);
		} catch {}
		try {
			const res = await state.client.systemOne({
				purpose: "route",
				state: { request: clip(prompt, 2000), recent_context: recent || "(start of the session)", project_hint: { dir: basename(ctx.cwd) } },
				questions: { tier: buildRoutingQuestion() },
				timeoutMs: policy.timeoutMs,
			});
			const answer = res.answers.tier;
			if (!isValidChoice(answer, Object.keys(ROUTE_TIERS))) return undefined;
			state.router.decisions++;
			state.router.byTier[answer.choice] = (state.router.byTier[answer.choice] ?? 0) + 1;
			// Unsure means the default tier, never the tier the previous request happened to get.
			const unsure = answer.confidence < 0.6;
			const tier: RouteTier = unsure ? "default" : (answer.choice as RouteTier);
			const target = tiers[tier] ?? tiers.default;
			state.record("route", `${answer.choice} @ ${Math.round(answer.confidence * 100)}%${unsure ? " (unsure → default)" : ""} → ${target ?? "(unchanged)"}`);
			if (!target) return undefined;
			await switchModel(pi, ctx, state, target, tier, answer.confidence);
			const effort = efforts[tier] ?? (tiers[tier] ? undefined : efforts.default);
			if (effort && effort !== ctx.thinkingLevel) {
				try {
					pi.setThinkingLevel(effort as never);
					state.record("route", `effort → ${effort} (${tier} tier)`);
				} catch {}
			}
		} catch (err) {
			state.degradedReason = err instanceof Error ? err.message : String(err);
		}
		return undefined;
	});
}

async function switchModel(pi: ExtensionAPI, ctx: ExtensionContext, state: ReflexState, ref: string, tier: string, confidence: number): Promise<void> {
	const parsed = parseModelRef(ref);
	if (!parsed) return;
	const current = ctx.model;
	if (current && current.provider === parsed.provider && current.id === parsed.id) return;
	const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
	if (!model) {
		if (ctx.hasUI) ctx.ui.notify(`⚡ Reflex router: model ${ref} not found`, "warning");
		return;
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
		if (ctx.hasUI) ctx.ui.notify(`⚡ Reflex routed to ${tier} tier: ${model.id} (${Math.round(confidence * 100)}%)`, "info");
	}
}
