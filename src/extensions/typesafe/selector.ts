/**
 * Relevance selector: before each user prompt, Jev picks which skills and MCP connectors
 * are likely relevant (one Choice over the roster + a Choice over connectors, in one
 * request, ~100 ms) and injects a one-line hint as a message so the model loads the right
 * skill and uses the right connector without scanning everything. Cookbook: skill_suggestion.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isValidChoice, type ChoiceAnswer } from "./client.js";
import { buildSelectionQuestions, confidenceBand, MAX_CHOICE_OPTIONS, MIN_HINT_PROBABILITY, SKILL_CONFIDENT_ENOUGH, SKILL_GATE_THRESHOLD, SKILL_SHORTLIST } from "./policy.js";
import { logDecision } from "../../logs/decisions.js";
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
/** The skills worth a second look: the Choice's best few, excluding "none". */
export function shortlistFrom(answer: ChoiceAnswer | undefined, roster: string[], max = SKILL_SHORTLIST): string[] {
	if (!answer) return [];
	return Object.entries(answer.probabilities ?? {})
		.filter(([name]) => name !== "none" && roster.includes(name))
		.sort((a, b) => b[1] - a[1])
		.slice(0, max)
		.map(([name]) => name);
}

/** What the first stage decided to do about skills, before any second call is made. */
export function skillStage(
	answers: { skill?: ChoiceAnswer; skill_needed?: { noul: number } },
	roster: string[],
): { verdict: "no-skill-needed" | "take-it" | "look-closer"; name?: string; shortlist: string[] } {
	const pick = answers.skill;
	// The Choice declining is the strongest "no" there is: it had every option in front of it.
	if (!pick || pick.choice === "none" || !roster.includes(pick.choice)) return { verdict: "no-skill-needed", shortlist: [] };
	const p = pick.probabilities?.[pick.choice] ?? pick.confidence;
	// A near-certain winner stands on its own. The gate exists to catch a winner picked from a weak
	// field, not to overrule a clear one: measured against seven requests, the gate alone vetoed a
	// correct 95% match ("create an agent that runs the tests weekday at 9") while every request
	// that needed no skill was already answered "none" by the Choice itself.
	if (p >= SKILL_CONFIDENT_ENOUGH) return { verdict: "take-it", name: pick.choice, shortlist: [] };
	const gate = answers.skill_needed?.noul ?? 1;
	if (gate < SKILL_GATE_THRESHOLD) return { verdict: "no-skill-needed", shortlist: [] };
	return { verdict: "look-closer", shortlist: shortlistFrom(pick, roster) };
}

/**
 * The relevance line, and the record of what was picked.
 *
 * Two stages, because a Choice always names a winner — even when every option fits badly. The gate
 * question asks whether any instructions are wanted at all, and a middling winner is put to a
 * second look where each candidate is judged on its own rather than against the others. The second
 * call only happens when the first stage is in doubt, so a clear answer still costs one request.
 */
export async function applySelection(
	state: ReflexState,
	answers: { skill?: ChoiceAnswer; skill_needed?: { noul: number }; connector?: ChoiceAnswer },
	rosters: { skills: string[]; servers: string[] },
	opts: { model?: string; qhash?: string; fit?: (names: string[]) => Promise<Record<string, number>> } = {},
): Promise<string | undefined> {
	const stage = skillStage(answers, rosters.skills);
	let skillName = stage.name;
	let skillProbability = stage.name ? (answers.skill?.probabilities?.[stage.name] ?? 0) : 0;
	let secondLook: Record<string, number> | undefined;

	if (stage.verdict === "look-closer" && stage.shortlist.length && opts.fit) {
		try {
			secondLook = await opts.fit(stage.shortlist);
			const [best, p] = Object.entries(secondLook).sort((a, b) => b[1] - a[1])[0] ?? [];
			if (best && p >= MIN_HINT_PROBABILITY) {
				skillName = best;
				skillProbability = p;
			}
		} catch {
			// A failed second look means no skill hint, not a guess from the first stage.
		}
	}

	const hints: string[] = [];
	if (skillName && skillProbability >= MIN_HINT_PROBABILITY) hints.push(`skill "${skillName}" (${pct(skillProbability)}) — read its SKILL.md before starting`);
	hints.push(...hintsFrom({ connector: answers.connector }, [], rosters.servers));

	const signal = (a: ChoiceAnswer | undefined) => (a ? { primitive: "choice" as const, value: a.probabilities[a.choice] ?? a.confidence, pick: a.choice, confidence: a.confidence, probabilities: a.probabilities, threshold: MIN_HINT_PROBABILITY } : undefined);
	const signals: Record<string, NonNullable<ReturnType<typeof signal>> | { primitive: "noul"; value: number; threshold: number }> = {};
	if (answers.skill_needed) signals.skill_needed = { primitive: "noul", value: answers.skill_needed.noul, threshold: SKILL_GATE_THRESHOLD };
	const sk = signal(answers.skill);
	if (sk) signals.skill = sk;
	const conn = signal(answers.connector);
	if (conn) signals.connector = conn;
	if (secondLook) for (const [name, p] of Object.entries(secondLook)) signals[`fit:${name}`] = { primitive: "noul", value: p, threshold: MIN_HINT_PROBABILITY };

	const decisionId = logDecision({
		source: "select",
		model: opts.model,
		qhash: opts.qhash,
		action: hints.length ? "hint" : stage.verdict === "no-skill-needed" ? "no-skill-needed" : "no-hint",
		rule: stage.verdict,
		band: confidenceBand(Math.max(answers.skill?.confidence ?? 0, answers.connector?.confidence ?? 0)),
		summary: hints.length ? hints.join(" · ") : `nothing relevant (${rosters.skills.length} skills, ${rosters.servers.length} connectors offered)`,
		signals,
		detail: { offered: { skills: rosters.skills.length, connectors: rosters.servers.length }, stage: stage.verdict, shortlist: stage.shortlist },
	});
	state.record("select", hints.length ? hints.join(" · ") : stage.verdict === "no-skill-needed" ? `no skill needed (gate ${pct(answers.skill_needed?.noul ?? 1)})` : "none relevant");
	// Did the model read the skill that was suggested? agent_end answers when nothing did.
	state.pending.skill = skillName && hints.length ? { id: decisionId, name: skillName } : undefined;
	return hints.length ? `<relevance source="typesafe-jev">Likely relevant for this request: ${hints.join("; ")}.</relevance>` : undefined;
}

export function registerSelectorRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("reflex-relevance", (message, _o, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		return new Text(`${theme.fg("accent", "⚡ relevance ")}${theme.fg("muted", content.replace(/<\/?relevance[^>]*>/g, ""))}`, 0, 0);
	});
}

const pct = (p: number) => `${Math.round(p * 100)}%`;
