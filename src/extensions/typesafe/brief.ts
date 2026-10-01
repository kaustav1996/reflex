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
import { buildSkillFitQuestions } from "./policy.js";
import { questionHash } from "./client.js";
import { clip, snapshotSession } from "./context.js";
import { applyRouting, routingQuestion } from "./router.js";
import { applySelection, selectionQuestions } from "./selector.js";
import type { ReflexState } from "./state.js";
import { heldBackNote, planTools } from "./tools.js";
import { logDecision } from "../../logs/decisions.js";

/**
 * Leave out the tool definitions of connectors this request was not judged to need. Returns the
 * note to append to the system prompt, so the model knows what exists but isn't loaded.
 */
function applyToolPlan(pi: ExtensionAPI, state: ReflexState, wanted: string | undefined): string {
	if (state.config.reflex.selectTools === false) return "";
	// Not every host exposes the tool registry; without it there is nothing to select from.
	if (typeof pi.getAllTools !== "function" || typeof pi.setActiveTools !== "function") return "";
	const all = pi.getAllTools().map((t) => t.name);
	if (!all.some((n) => n.includes("__"))) return "";
	const plan = planTools(all, { wanted: wanted === "none" ? undefined : wanted, used: state.usedServers });
	if (!plan.dropped.length) return "";
	try {
		pi.setActiveTools(plan.keep);
	} catch {
		return "";
	}
	state.record("tools", `${plan.dropped.length} connector tools left out (${plan.heldBack.join(", ")})`);
	logDecision({
		source: "select",
		action: `tools:${plan.keep.length}/${all.length}`,
		summary: `left out ${plan.dropped.length} tools from ${plan.heldBack.join(", ")}`,
		signals: {},
		detail: { wanted, heldBack: plan.heldBack, kept: plan.keep.length },
	});
	return heldBackNote(plan.heldBack);
}

export function registerRequestBrief(pi: ExtensionAPI, state: ReflexState): void {
	pi.on("before_agent_start", async (event, ctx) => {
		if (!state.config.reflex.enabled || !state.client) return undefined;
		const prompt = event.prompt?.trim();
		if (!prompt || prompt.startsWith("/")) return undefined;

		const questions: Record<string, Question> = {};
		const tier = routingQuestion(state, prompt);
		if (tier) questions.tier = tier;
		const skills = (event.systemPromptOptions?.skills ?? []) as Array<{ name: string; description?: string }>;
		const selection = selectionQuestions(state, prompt, skills);
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
			const answers = res.answers as Record<string, ChoiceAnswer | undefined> & { skill_needed?: { noul: number } };
			const log = { model: res.model, qhash: questionHash(questions as never) };
			if (tier && answers.tier) await applyRouting(pi, ctx, state, answers.tier, log);
			if (!selection) return undefined;
			// A middling first-stage winner gets a second look: each candidate judged on its own,
			// in one more call. A clear answer, or a gate that says no skill is wanted, costs nothing.
			const fit = async (names: string[]) => {
				const describe = (name: string) => clip(skills.find((sk) => sk.name === name)?.description ?? name, 200);
				const second = await state.client!.systemOne({
					purpose: "select:fit",
					state: { request: clip(prompt, 2000), recent_context: recent || "(start of the session)" },
					questions: buildSkillFitQuestions(names, describe),
					timeoutMs: state.config.reflex.timeoutMs,
				});
				return Object.fromEntries(names.map((n) => [n, (second.answers[n] as { noul: number } | undefined)?.noul ?? 0]));
			};
			const relevance = await applySelection(state, { skill: answers.skill, skill_needed: answers.skill_needed as unknown as { noul: number } | undefined, connector: answers.connector }, selection, { ...log, fit });
			// The connector answer also decides which tool definitions this request carries.
			const note = applyToolPlan(pi, state, answers.connector?.choice);
			const message = relevance ? { customType: "reflex-relevance", content: relevance, display: true } : undefined;
			return { ...(message ? { message } : {}), ...(note ? { systemPrompt: `${event.systemPrompt}${note}` } : {}) };
		} catch (err) {
			state.degradedReason = err instanceof Error ? err.message : String(err);
			return undefined;
		}
	});
}
