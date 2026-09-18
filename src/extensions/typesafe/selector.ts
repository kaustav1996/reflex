/**
 * Relevance selector: before each user prompt, Jev picks which skills and MCP connectors
 * are likely relevant (one Choice over the roster + a Choice over connectors, in one
 * request, ~100 ms) and injects a one-line hint as a message so the model loads the right
 * skill and uses the right connector without scanning everything. Cookbook: skill_suggestion.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { choice, isValidChoice } from "./client.js";
import { clip } from "./context.js";
import type { ReflexState } from "./state.js";
import { loadMcpConfig } from "../mcp/client.js";

export function registerSelector(pi: ExtensionAPI, state: ReflexState): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const policy = state.config.reflex;
		if (!policy.enabled || !state.client || policy.selectSkills === false) return undefined;
		const prompt = event.prompt?.trim();
		if (!prompt || prompt.startsWith("/") || prompt.length < 12) return undefined;
		const skills = (event.systemPromptOptions?.skills ?? []) as Array<{ name: string; description?: string }>;
		const servers = Object.entries(loadMcpConfig().servers).filter(([, s]) => s.enabled !== false).map(([name, s]) => ({ name, hint: s.command ? [s.command, ...(s.args ?? [])].join(" ") : (s.url ?? "") }));
		if (skills.length + servers.length === 0) return undefined;

		const skillCriteria: Record<string, string> = { none: "No skill is needed; the request is ordinary coding or conversation." };
		for (const sk of skills.slice(0, 250)) skillCriteria[sk.name] = clip(sk.description ?? sk.name, 300);
		const serverCriteria: Record<string, string> = { none: "No external connector is needed; local files and the shell suffice." };
		for (const sv of servers.slice(0, 250)) serverCriteria[sv.name] = `Connector "${sv.name}" (${clip(sv.hint, 120)})`;

		const questions: Record<string, ReturnType<typeof choice>> = {};
		if (skills.length) questions.skill = choice({ question: "Which skill's instructions would most help carry out request? Pick none when ordinary knowledge suffices.", inspect: ["request", "recent_context"] }, skillCriteria);
		if (servers.length) questions.connector = choice({ question: "Which external connector (MCP server) does request need? Pick none when local files and the shell are enough.", inspect: "request" }, serverCriteria);
		try {
			const res = await state.client.systemOne({ purpose: "select", state: { request: clip(prompt, 1500), recent_context: clip(ctx.getSystemPrompt().slice(-400), 400) }, questions, timeoutMs: 2500 });
			const hints: string[] = [];
			const skillAns = res.answers.skill;
			if (skillAns && isValidChoice(skillAns, Object.keys(skillCriteria)) && skillAns.choice !== "none" && skillAns.probabilities[skillAns.choice] >= 0.3) hints.push(`skill "${skillAns.choice}" (${pct(skillAns.probabilities[skillAns.choice])}) — read its SKILL.md before starting`);
			const connAns = res.answers.connector;
			if (connAns && isValidChoice(connAns, Object.keys(serverCriteria)) && connAns.choice !== "none" && connAns.probabilities[connAns.choice] >= 0.3) hints.push(`connector "${connAns.choice}" (${pct(connAns.probabilities[connAns.choice])}) — its tools are named ${connAns.choice}__*`);
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
