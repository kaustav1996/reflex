/**
 * Relevance selector: before each user prompt, Jev picks which skills and MCP connectors
 * are likely relevant (one Choice over the roster + a Choice over connectors, in one
 * request, ~100 ms) and injects a one-line hint as a message so the model loads the right
 * skill and uses the right connector without scanning everything. Cookbook: skill_suggestion.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { choice, isValidChoice, type ChoiceAnswer } from "./client.js";
import { clip } from "./context.js";
import type { ReflexState } from "./state.js";
import { loadMcpConfig } from "../mcp/client.js";

export const MIN_HINT_PROBABILITY = 0.5;
/** Options offered in one Jev Choice. Jev accepts up to 255; "none" takes one slot. */
export const MAX_CHOICE_OPTIONS = 250;

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "are", "can", "use", "when", "what", "how", "please", "need", "want", "make", "help"]);
const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)));

/**
 * The items to offer Jev when there are more than one Choice can hold: the ones sharing the
 * most words with the request (name counts double), original order breaking ties. With a large
 * package installed (ECC has ~285 skills) this replaces "the first 250", which hid every skill
 * after the cut no matter how well it matched.
 */
export function shortlist<T extends { name: string; text?: string }>(items: T[], request: string, max = MAX_CHOICE_OPTIONS): T[] {
	if (items.length <= max) return items;
	const req = words(request);
	const score = (it: T) => {
		let n = 0;
		for (const w of words(it.name.replace(/[-_]/g, " "))) if (req.has(w)) n += 2;
		for (const w of words(it.text ?? "")) if (req.has(w)) n += 1;
		return n;
	};
	return items
		.map((it, i) => ({ it, i, s: score(it) }))
		.sort((a, b) => b.s - a.s || a.i - b.i)
		.slice(0, max)
		.sort((a, b) => a.i - b.i)
		.map((x) => x.it);
}

export function hintsFrom(
	answers: { skill?: ChoiceAnswer; connector?: ChoiceAnswer },
	skillNames: string[],
	serverNames: string[],
	min = MIN_HINT_PROBABILITY,
): string[] {
	const hints: string[] = [];
	const skillIds = ["none", ...skillNames];
	const serverIds = ["none", ...serverNames];
	const skillAns = answers.skill;
	if (skillAns && isValidChoice(skillAns, skillIds) && skillAns.choice !== "none" && skillAns.probabilities[skillAns.choice] >= min) {
		hints.push(`skill "${skillAns.choice}" (${pct(skillAns.probabilities[skillAns.choice])}) — read its SKILL.md before starting`);
	}
	const connAns = answers.connector;
	if (connAns && isValidChoice(connAns, serverIds) && connAns.choice !== "none" && connAns.probabilities[connAns.choice] >= min) {
		hints.push(`connector "${connAns.choice}" (${pct(connAns.probabilities[connAns.choice])}) — its tools are named ${connAns.choice}__*`);
	}
	return hints;
}

export function registerSelector(pi: ExtensionAPI, state: ReflexState): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const policy = state.config.reflex;
		if (!policy.enabled || !state.client || policy.selectSkills === false) return undefined;
		const prompt = event.prompt?.trim();
		if (!prompt || prompt.startsWith("/") || prompt.length < 12) return undefined;
		const allSkills = (event.systemPromptOptions?.skills ?? []) as Array<{ name: string; description?: string }>;
		const skills = shortlist(allSkills.map((sk) => ({ ...sk, text: sk.description })), prompt);
		const servers = shortlist(Object.entries(loadMcpConfig().servers).filter(([, s]) => s.enabled !== false).map(([name, s]) => ({ name, hint: s.command ? [s.command, ...(s.args ?? [])].join(" ") : (s.url ?? ""), text: name })), prompt);
		if (skills.length + servers.length === 0) return undefined;

		const skillCriteria: Record<string, string> = { none: "No skill is needed; the request is ordinary coding or conversation." };
		for (const sk of skills) skillCriteria[sk.name] = clip(sk.description ?? sk.name, 300);
		const serverCriteria: Record<string, string> = { none: "No external connector is needed; local files and the shell suffice." };
		for (const sv of servers) serverCriteria[sv.name] = `Connector "${sv.name}" (${clip(sv.hint, 120)})`;

		const questions: Record<string, ReturnType<typeof choice>> = {};
		if (skills.length) questions.skill = choice({ question: "Which skill's instructions would most help carry out request? Pick none when ordinary knowledge suffices.", inspect: ["request", "recent_context"] }, skillCriteria);
		if (servers.length) questions.connector = choice({ question: "Which external connector (MCP server) does request need? Pick none when local files and the shell are enough.", inspect: "request" }, serverCriteria);
		try {
			const res = await state.client.systemOne({ purpose: "select", state: { request: clip(prompt, 1500), recent_context: clip(ctx.getSystemPrompt().slice(-400), 400) }, questions, timeoutMs: 2500 });
			const skillAns = res.answers.skill;
			const connAns = res.answers.connector;
			const hints = hintsFrom(
				{
					skill: skillAns as ChoiceAnswer | undefined,
					connector: connAns as ChoiceAnswer | undefined,
				},
				skills.map((sk) => sk.name),
				servers.map((server) => server.name),
			);
			state.record("select", hints.length ? hints.join(" · ") : `none relevant (skill ${skillAns ? `${skillAns.choice} ${pct(skillAns.confidence)}` : "-"}, connector ${connAns ? `${connAns.choice} ${pct(connAns.confidence)}` : "-"})`);
			if (!hints.length) return undefined;
			return { message: { customType: "reflex-relevance", content: `<relevance source="typesafe-jev">Likely relevant for this request: ${hints.join("; ")}.</relevance>`, display: true } };
		} catch (err) {
			state.degradedReason = err instanceof Error ? err.message : String(err);
			return undefined;
		}
	});

	pi.registerMessageRenderer("reflex-relevance", (message, _o, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		return new Text(`${theme.fg("accent", "⚡ relevance ")}${theme.fg("muted", content.replace(/<\/?relevance[^>]*>/g, ""))}`, 0, 0);
	});
}

const pct = (p: number) => `${Math.round(p * 100)}%`;
