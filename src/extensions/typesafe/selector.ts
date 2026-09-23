/**
 * Relevance selector: before each user prompt, Jev picks which skills and MCP connectors
 * are likely relevant (one Choice over the roster + a Choice over connectors, in one
 * request, ~100 ms) and injects a one-line hint as a message so the model loads the right
 * skill and uses the right connector without scanning everything. Cookbook: skill_suggestion.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isValidChoice, type ChoiceAnswer } from "./client.js";
import { buildSelectionQuestions, MAX_CHOICE_OPTIONS, MIN_HINT_PROBABILITY } from "./policy.js";
import { clip } from "./context.js";
import type { ReflexState } from "./state.js";
import { loadMcpConfig } from "../mcp/client.js";

// The numbers and the question wording live with the gate's, in policy.ts; re-exported so the
// selector's callers and tests keep one import.
export { MAX_CHOICE_OPTIONS, MIN_HINT_PROBABILITY } from "./policy.js";

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

/** The questions to ask about this request, and the rosters the answers are checked against. */
export function selectionQuestions(
	state: ReflexState,
	prompt: string,
	allSkills: Array<{ name: string; description?: string }>,
): { questions: ReturnType<typeof buildSelectionQuestions>; skills: string[]; servers: string[] } | undefined {
	const policy = state.config.reflex;
	if (!policy.enabled || policy.selectSkills === false) return undefined;
	if (prompt.length < 12) return undefined;
	const skills = shortlist(allSkills.map((sk) => ({ ...sk, text: sk.description })), prompt);
	const servers = shortlist(
		Object.entries(loadMcpConfig().servers)
			.filter(([, sv]) => sv.enabled !== false)
			.map(([name, sv]) => ({ name, hint: sv.command ? [sv.command, ...(sv.args ?? [])].join(" ") : (sv.url ?? ""), text: name })),
		prompt,
	);
	if (skills.length + servers.length === 0) return undefined;

	const skillCriteria: Record<string, string> = { none: "No skill is needed; the request is ordinary coding or conversation." };
	for (const sk of skills) skillCriteria[sk.name] = clip(sk.description ?? sk.name, 300);
	const serverCriteria: Record<string, string> = { none: "No external connector is needed; local files and the shell suffice." };
	for (const sv of servers) serverCriteria[sv.name] = `Connector "${sv.name}" (${clip(sv.hint, 120)})`;

	const questions = buildSelectionQuestions(skills.length ? skillCriteria : {}, servers.length ? serverCriteria : {});
	return { questions, skills: skills.map((sk) => sk.name), servers: servers.map((sv) => sv.name) };
}

/** The relevance line for the answers to those questions, and the record of what was picked. */
export function applySelection(
	state: ReflexState,
	answers: { skill?: ChoiceAnswer; connector?: ChoiceAnswer },
	rosters: { skills: string[]; servers: string[] },
): string | undefined {
	const hints = hintsFrom(answers, rosters.skills, rosters.servers);
	state.record("select", hints.length ? hints.join(" · ") : `none relevant (skill ${answers.skill ? `${answers.skill.choice} ${pct(answers.skill.confidence)}` : "-"}, connector ${answers.connector ? `${answers.connector.choice} ${pct(answers.connector.confidence)}` : "-"})`);
	return hints.length ? `<relevance source="typesafe-jev">Likely relevant for this request: ${hints.join("; ")}.</relevance>` : undefined;
}

export function registerSelectorRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("reflex-relevance", (message, _o, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		return new Text(`${theme.fg("accent", "⚡ relevance ")}${theme.fg("muted", content.replace(/<\/?relevance[^>]*>/g, ""))}`, 0, 0);
	});
}

const pct = (p: number) => `${Math.round(p * 100)}%`;
