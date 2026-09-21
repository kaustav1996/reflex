/**
 * Model router: before each new user prompt, Jev classifies the request into a
 * tier (fast / default / strong) and Reflex switches the LLM accordingly.
 * Only runs when the user configured tier models and enabled routing.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { isValidChoice } from "./client.js";
import { clip } from "./context.js";
import { buildRoutingQuestion, ROUTE_TIERS } from "./policy.js";
import type { ReflexState } from "./state.js";

export function parseModelRef(ref: string): { provider: string; id: string } | undefined {
	const i = ref.indexOf("/");
	if (i <= 0) return undefined;
	return { provider: ref.slice(0, i), id: ref.slice(i + 1) };
}

export function registerRouter(pi: ExtensionAPI, state: ReflexState): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const policy = state.config.reflex;
		if (!policy.enabled || !policy.routeModels || !state.client) return undefined;
		const tiers = policy.routing;
		const configured = Object.entries(tiers).filter(([, v]) => !!v);
		if (configured.length < 2) return undefined;
		const prompt = event.prompt?.trim();
		if (!prompt || prompt.startsWith("/") || prompt.length < 8) return undefined;

		try {
			const res = await state.client.systemOne({
				purpose: "route",
				state: { request: clip(prompt, 2000), project_hint: { dir: basename(ctx.cwd) } },
				questions: { tier: buildRoutingQuestion() },
				timeoutMs: policy.timeoutMs,
			});
			const answer = res.answers.tier;
			if (!isValidChoice(answer, Object.keys(ROUTE_TIERS))) return undefined;
			state.router.decisions++;
			state.router.byTier[answer.choice] = (state.router.byTier[answer.choice] ?? 0) + 1;
			const target = tiers[answer.choice as keyof typeof tiers] ?? tiers.default;
			state.record("route", `${answer.choice} @ ${Math.round(answer.confidence * 100)}% → ${target ?? "(unchanged)"}`);
			if (!target || answer.confidence < 0.6) return undefined;
			await switchModel(pi, ctx, state, target, answer.choice, answer.confidence);
			const effort = policy.routingEffort?.[answer.choice as keyof typeof tiers] ?? (tiers[answer.choice as keyof typeof tiers] ? undefined : policy.routingEffort?.default);
			if (effort && effort !== ctx.thinkingLevel) {
				try {
					pi.setThinkingLevel(effort as never);
					state.record("route", `effort → ${effort} (${answer.choice} tier)`);
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
	const ok = await pi.setModel(model);
	if (ok) {
		state.router.switches++;
		if (ctx.hasUI) ctx.ui.notify(`⚡ Reflex routed to ${tier} tier: ${model.id} (${Math.round(confidence * 100)}%)`, "info");
	}
}
