/**
 * One Jev call per user request.
 *
 * Routing (which model tier) and relevance (which skill, which connector) are separate
 * decisions, but they judge the same thing: the request that just arrived. Jev evaluates every
 * question in a request in parallel against one state, and the state is charged once per call,
 * not once per question — so asking them together costs one state instead of two and adds
 * almost nothing to latency. TypeSafe's own cookbook measures the batched shape at 12.2x
 * cheaper and 10x faster than a call per question.
 *
 * Questions cannot read each other's answers, which is fine here: the tier doesn't depend on
 * the skill. A question that needs an earlier answer belongs in a later call, not this one.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import type { ChoiceAnswer, Question } from "./client.js";
import { clip, snapshotSession } from "./context.js";
import { applyRouting, routingQuestion } from "./router.js";
import { applySelection, selectionQuestions } from "./selector.js";
import type { ReflexState } from "./state.js";

export function registerRequestBrief(pi: ExtensionAPI, state: ReflexState): void {
	pi.on("before_agent_start", async (event, ctx) => {
		if (!state.config.reflex.enabled || !state.client) return undefined;
		const prompt = event.prompt?.trim();
		if (!prompt || prompt.startsWith("/")) return undefined;

		const questions: Record<string, Question> = {};
		const tier = routingQuestion(state, prompt);
		if (tier) questions.tier = tier;
		const selection = selectionQuestions(state, prompt, (event.systemPromptOptions?.skills ?? []) as Array<{ name: string; description?: string }>);
		if (selection) Object.assign(questions, selection.questions);
		if (!Object.keys(questions).length) return undefined;

		// What the request continues: a short "go ahead" belongs to the task before it.
		let recent = "";
		try {
			recent = clip(snapshotSession(ctx, { maxToolCalls: 0 }).assistantText ?? "", 800);
		} catch {}

		try {
			const res = await state.client.systemOne({
				purpose: "brief",
				state: { request: clip(prompt, 2000), recent_context: recent || "(start of the session)", project_hint: { dir: basename(ctx.cwd) } },
				questions,
				timeoutMs: state.config.reflex.timeoutMs,
			});
			const answers = res.answers as Record<string, ChoiceAnswer | undefined>;
			if (tier && answers.tier) await applyRouting(pi, ctx, state, answers.tier);
			if (!selection) return undefined;
			const relevance = applySelection(state, { skill: answers.skill, connector: answers.connector }, selection);
			return relevance ? { message: { customType: "reflex-relevance", content: relevance, display: true } } : undefined;
		} catch (err) {
			state.degradedReason = err instanceof Error ? err.message : String(err);
			return undefined;
		}
	});
}
