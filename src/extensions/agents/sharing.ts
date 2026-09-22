/**
 * Tools for sharing agents: export one as a bundle, and review an imported bundle in a session.
 *
 *   export_agent            write an agent as a .reflex-agent.json (Jev-picked parameters, requirements, effects)
 *   stage_shared_agent      put a bundle file into staging for review
 *   review_shared_agent     what a staged agent does, its parameters, requirements, risk read and effects
 *   set_shared_agent_values fill parameters, map connectors
 *   edit_shared_agent       change the staged definition
 *   check_shared_agent      connectors (connected, tools present), CLIs, secrets, Jev
 *   trial_run_shared_agent  run it with external steps only reported
 *   add_shared_agent        move it into the agent list: needs the user's confirmation in the UI
 *   discard_shared_agent    drop the staged copy (also confirmed)
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Type } from "typebox";
import { buildBundle, findParamCandidates, judgeCandidates, suggestEffects } from "../../agents/bundle.js";
import { agentDiagram, toMermaid } from "../../agents/diagram.js";
import { checkStaged, checkValues, discardStaged, editStaged, getStaged, installStaged, proposeValues, setStagedValues, stageBundle, type StagedAgent, trialStaged } from "../../agents/staging.js";
import { listAgents } from "../../agents/store.js";
import { effectOf } from "../../agents/workflow.js";

const text = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: t }], details });
const pct = (n: number | undefined) => (n === undefined ? "–" : `${Math.round(n * 100)}%`);
const staged = (id: string): StagedAgent => {
	const s = getStaged(id);
	if (!s) throw new Error(`No staged agent "${id}". It may have been added or discarded already.`);
	return s;
};
const expand = (p: string, cwd: string) => resolve(cwd, p.replace(/^~(?=$|\/)/, homedir()));

/** Everything a reviewer needs about a staged agent, as plain text for the model to explain. */
export function reviewText(s: StagedAgent): string {
	const b = s.bundle;
	const lines: string[] = [];
	lines.push(`# ${b.meta.name}${b.meta.version ? ` v${b.meta.version}` : ""}${b.meta.author ? ` by ${b.meta.author}` : ""}  (staged as ${s.id})`);
	if (b.meta.description) lines.push(b.meta.description);
	if (s.draft.instructions) lines.push(`\nInstructions to its runs:\n${s.draft.instructions}`);
	lines.push(`\n## Steps (effect: read / local = changes this machine / external = others can see it)`);
	for (const [i, st] of (s.draft.steps ?? []).entries()) {
		const id = st.id ?? `step${i + 1}`;
		const r = s.risk?.find((x) => x.step === id);
		const eff = effectOf(st);
		const src = s.effects[id]?.source;
		const what = st.type === "shell" ? st.run : st.type === "llm" ? `${st.prompt.slice(0, 400)}${st.tools?.length ? `\n     tools: ${st.tools.join(", ")}` : "\n     tools: all"}` : st.type === "decide" ? Object.entries(st.questions ?? {}).map(([k, q]) => `${k}: ${typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions)}`).join(" | ") : st.type === "spawn" ? `${st.action ?? "create"} helper ${st.agent ?? st.template ?? ""}` : st.type === "call" ? `runs agent ${st.agentId}` : st.type === "end" ? "end" : "";
		lines.push(`${i + 1}. ${id} [${st.type}, ${eff}${src && src !== "tag" ? ` (suggested by ${src === "jev" ? "Jev" : "rules"})` : ""}]${r?.destructive !== undefined ? ` risk: destructive ${pct(r.destructive)}, secrets ${pct(r.secrets)}, external ${pct(r.external)}` : ""}\n     ${what.replace(/\n/g, "\n     ")}${st.route?.length ? `\n     routes: ${st.route.map((x) => `${x.when} → ${x.next}`).join("; ")}` : ""}`);
	}
	if (!s.draft.steps?.length) lines.push(`(single-prompt agent)\n${s.draft.prompt}`);
	lines.push(`\n## Parameters`);
	for (const p of b.params) lines.push(`- ${p.id} (${p.type}): ${p.description}${p.example ? ` · author's value: ${p.example}` : ""} · here: ${s.values[p.id] ?? "(not set)"}`);
	if (!b.params.length) lines.push("(none)");
	const r = b.requires;
	lines.push(`\n## Requirements`);
	lines.push(`- connectors: ${r.connectors.map((c) => `${c.id} (${c.service}; tools ${c.tools.join(", ")})${s.connectorMap[c.id] && s.connectorMap[c.id] !== c.id ? ` → uses "${s.connectorMap[c.id]}" here` : ""}`).join("; ") || "none"}`);
	lines.push(`- CLIs: ${r.clis.map((c) => c.name).join(", ") || "none"} · secrets (names only): ${r.secrets.map((x) => x.name).join(", ") || "none"} · Jev: ${r.jev ? "needed" : "not needed"} · author's model: ${r.models.join(", ") || "default"}`);
	if (r.agents.templates.length) lines.push(`- helper agent templates: ${r.agents.templates.join(", ")}`);
	if (r.warnings.length) lines.push(`\n## Warnings\n${r.warnings.map((w) => `- ${w}`).join("\n")}`);
	lines.push(`\nAuthor's reflex setting: ${b.agent.reflex ?? "balanced"} · on import: ${!b.agent.reflex || b.agent.reflex === "off" ? "balanced" : b.agent.reflex}; added agents start disabled.`);
	if (s.trial) lines.push(`\nLast trial: ${s.trial.status}${s.trial.error ? ` (${s.trial.error})` : ""}; skipped as external: ${s.trial.steps.filter((x) => x.skipped).map((x) => x.id).join(", ") || "none"}`);
	lines.push(`\nDiagram (Mermaid):\n${toMermaid(agentDiagram(s.draft as never))}`);
	return lines.join("\n");
}

async function confirmUser(ctx: ExtensionContext, title: string, body: string): Promise<boolean> {
	if (!ctx.hasUI) return false;
	return !!(await ctx.ui.confirm(title, body));
}

export function registerSharingTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "export_agent",
		label: "Export agent",
		description:
			"Write an agent as a shareable .reflex-agent.json bundle. Values that tie it to this machine (home-folder paths, repo URLs, emails, long ids) become parameters when Jev judges someone else would have to replace them; secrets are never included (only their names). Returns the file path, the parameters and any warnings. In reflex web the agent page's Share button does the same with a review form.",
		promptSnippet: "Export a Reflex agent as a shareable bundle file",
		parameters: Type.Object({
			agentId: Type.String({ description: "Agent id (from list_agents)" }),
			out: Type.Optional(Type.String({ description: "Output file (default: ./<id>.reflex-agent.json)" })),
			author: Type.Optional(Type.String({ description: "Author name for the bundle" })),
		}),
		async execute(_id, p, _signal, _update, ctx) {
			const agent = listAgents().find((a) => a.id === p.agentId || a.name === p.agentId);
			if (!agent) throw new Error(`No agent '${p.agentId}'. Call list_agents.`);
			const candidates = (await judgeCandidates(agent, findParamCandidates(agent))).filter((c) => (c.score ?? 0) >= 0.5);
			const effects = await suggestEffects(agent.steps ?? []);
			const { bundle, warnings } = buildBundle(agent, {
				params: candidates.map((c) => ({ id: c.suggestedId, type: c.type, description: `Replace with your own ${c.type === "dir" ? "folder" : c.type} (the author's was ${c.value})`, value: c.value })),
				effects: Object.fromEntries(Object.entries(effects).map(([k, v]) => [k, v.effect])),
				meta: { author: p.author },
			});
			const out = expand(p.out ?? `${agent.id}.reflex-agent.json`, ctx.cwd);
			writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`);
			return text(`Wrote ${out}\nParameters: ${bundle.params.map((x) => `${x.id} (${x.type}, was ${x.example})`).join("; ") || "none"}\nConnectors: ${bundle.requires.connectors.map((c) => c.id).join(", ") || "none"} · CLIs: ${bundle.requires.clis.map((c) => c.name).join(", ") || "none"} · secrets: ${bundle.requires.secrets.map((x) => x.name).join(", ") || "none"}${warnings.length ? `\nWarnings:\n- ${warnings.join("\n- ")}` : ""}`, { out, params: bundle.params.length });
		},
	});

	pi.registerTool({
		name: "stage_shared_agent",
		label: "Stage shared agent",
		description: "Put a shared agent bundle (.reflex-agent.json) into staging so it can be reviewed, configured and trial-run before anything is added. Nothing runs and nothing is added. Returns the staging id; then call review_shared_agent.",
		promptSnippet: "Stage a shared agent bundle file for review",
		parameters: Type.Object({ path: Type.String({ description: "Path to the .reflex-agent.json file" }) }),
		async execute(_id, p, _signal, _update, ctx) {
			const file = expand(p.path, ctx.cwd);
			if (!existsSync(file)) throw new Error(`No file at ${file}`);
			const s = await stageBundle(readFileSync(file, "utf8"), { source: file, cwd: ctx.cwd });
			return text(`Staged "${s.bundle.meta.name}" as ${s.id} for review (folder ${ctx.cwd}). Next: review_shared_agent.`, { stagingId: s.id });
		},
	});

	pi.registerTool({
		name: "review_shared_agent",
		label: "Review shared agent",
		description: "Everything about a staged (imported, not yet added) agent: what it does, each step with its effect and Jev's risk read, parameters and their values here, requirements, warnings, the last trial, and a Mermaid diagram. Explain it to the user in plain words before configuring.",
		promptSnippet: "Review a staged shared agent",
		parameters: Type.Object({ stagingId: Type.String() }),
		async execute(_id, p) {
			return text(reviewText(staged(p.stagingId)), { stagingId: p.stagingId });
		},
	});

	pi.registerTool({
		name: "set_shared_agent_values",
		label: "Set shared agent values",
		description: "Fill a staged agent's parameters with values for this machine (folders must exist), and/or map a bundle connector id to this user's connector for the same service. Pass JSON objects as strings.",
		promptSnippet: "Fill parameters / map connectors of a staged agent",
		parameters: Type.Object({
			stagingId: Type.String(),
			values: Type.Optional(Type.String({ description: 'JSON object, e.g. {"WORKDIR":"~/work/devops"}' })),
			connectorMap: Type.Optional(Type.String({ description: 'JSON object, bundle connector id → this user\'s connector id, e.g. {"atlassian":"jira"}' })),
			propose: Type.Optional(Type.Boolean({ description: "Fill what this folder suggests (its path for the working folder, its git remote for a repo URL) before applying values" })),
		}),
		async execute(_id, p, _signal, _update, ctx) {
			let s = staged(p.stagingId);
			if (p.propose) s = setStagedValues(s.id, { values: await proposeValues(s, s.cwd ?? ctx.cwd) });
			s = setStagedValues(s.id, { values: p.values ? JSON.parse(p.values) : undefined, connectorMap: p.connectorMap ? JSON.parse(p.connectorMap) : undefined });
			const problems = checkValues(s);
			return text(`Values: ${Object.entries(s.values).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}${Object.keys(s.connectorMap).length ? `\nConnectors: ${Object.entries(s.connectorMap).map(([k, v]) => `${k}→${v}`).join(", ")}` : ""}\n${problems.length ? `Still needed:\n- ${problems.join("\n- ")}` : "All parameters are set."}`, { problems });
		},
	});

	pi.registerTool({
		name: "edit_shared_agent",
		label: "Edit shared agent",
		description: "Change the staged agent's definition before it is added (e.g. drop a step, change a prompt, set a cron trigger, retag a step's effect). Pass the changed top-level fields as a JSON string; steps replace the whole list. Keep {{param.X}} placeholders for values that differ per machine.",
		promptSnippet: "Change a staged shared agent",
		parameters: Type.Object({ stagingId: Type.String(), changes: Type.String({ description: 'JSON object of fields to replace, e.g. {"triggers":[{"type":"cron","schedule":"0 9 * * 1-5"}]}' }) }),
		async execute(_id, p) {
			const s = editStaged(p.stagingId, JSON.parse(p.changes));
			return text(`Updated the staged agent (${Object.keys(JSON.parse(p.changes)).join(", ")}). Its trial result was cleared; run a new trial.`, { stagingId: s.id });
		},
	});

	pi.registerTool({
		name: "check_shared_agent",
		label: "Check shared agent",
		description: "Check a staged agent's requirements on this machine: parameters, each connector (configured, connected, required tools present), CLIs on PATH, secrets present (names only), Jev available. Tell the user what's missing and how to fix it (Settings → Connectors to connect; the credential form for secrets).",
		promptSnippet: "Check a staged shared agent's requirements",
		parameters: Type.Object({ stagingId: Type.String() }),
		async execute(_id, p) {
			const c = await checkStaged(p.stagingId);
			const lines = [
				c.ready ? "Ready: everything the agent needs is here." : "Not ready yet:",
				...c.values.map((v) => `- parameter ${v}`),
				...c.connectors.map((x) => `- connector ${x.id} (${x.service})${x.usesHere !== x.id ? ` as "${x.usesHere}"` : ""}: ${!x.configured ? `not configured${x.suggestion ? ` (this user has "${x.suggestion}" for it: map it)` : " (connect it in Settings → Connectors)"}` : !x.enabled ? "disabled" : x.error ? `can't connect: ${x.error}` : x.missingTools.length ? `missing tools ${x.missingTools.join(", ")}` : "ok"}`),
				...c.clis.map((x) => `- CLI ${x.name}: ${x.found ? "ok" : "not found on PATH"}`),
				...c.secrets.map((x) => `- secret ${x.name}: ${x.present ? "present" : "missing (ask with request_secrets)"}`),
				...(c.jev.needed ? [`- Jev: ${c.jev.available ? "ok" : "no TypeSafe or OpenRouter key"}`] : []),
			];
			return text(lines.join("\n"), c as unknown as Record<string, unknown>);
		},
	});

	pi.registerTool({
		name: "trial_run_shared_agent",
		label: "Trial run shared agent",
		description: "Trial-run a staged agent: read and local steps run on this machine, external steps (pushes, comments, messages, deploys) and helper-agent creation are only reported with what they would have done. Ask the user before starting it. Report each step's result.",
		promptSnippet: "Trial-run a staged shared agent",
		parameters: Type.Object({ stagingId: Type.String(), input: Type.Optional(Type.String({ description: "Input for {{input}}" })) }),
		async execute(_id, p) {
			const t = await trialStaged(p.stagingId, p.input);
			const lines = [`Trial ${t.status}${t.error ? `: ${t.error}` : ""} (run ${t.runId})`, ...t.steps.map((x) => `- ${x.id}: ${x.skipped ? `not run (${x.skipped})${x.wouldRun ? ` — would run: ${x.wouldRun.slice(0, 300)}` : ""}` : x.ok ? "ok" : "failed"}`)];
			if (t.output) lines.push(`Output: ${t.output.slice(0, 800)}`);
			return text(lines.join("\n"), { status: t.status });
		},
	});

	pi.registerTool({
		name: "add_shared_agent",
		label: "Add shared agent",
		description: "Add the staged agent to the user's agent list. The user must confirm in a dialog; only call it when they asked to add it. It is added disabled unless enable is true and the user agrees.",
		promptSnippet: "Add a reviewed shared agent (user confirms)",
		parameters: Type.Object({ stagingId: Type.String(), enable: Type.Optional(Type.Boolean({ description: "Enable its triggers right away" })) }),
		async execute(_id, p, _signal, _update, ctx) {
			const s = staged(p.stagingId);
			const problems = checkValues(s);
			if (problems.length) return text(`Can't add it yet:\n- ${problems.join("\n- ")}`, { added: false });
			const ok = await confirmUser(ctx, `Add agent "${s.bundle.meta.name}"?`, `${p.enable ? "It will be enabled: its triggers start firing." : "It will be added disabled; enable it from the Agents tab."}${s.trial ? `\nLast trial: ${s.trial.status}.` : "\nIt hasn't had a trial run."}`);
			if (!ok) return text(ctx.hasUI ? "The user didn't confirm; nothing was added." : "Adding needs the user's confirmation in an interactive session; nothing was added.", { added: false });
			const agent = installStaged(s.id, { enable: p.enable });
			return text(`Added agent ${agent.id} (${agent.enabled ? "enabled" : "disabled"}).`, { added: true, agentId: agent.id });
		},
	});

	pi.registerTool({
		name: "discard_shared_agent",
		label: "Discard shared agent",
		description: "Drop a staged agent and its trial runs. The user confirms.",
		promptSnippet: "Discard a staged shared agent",
		parameters: Type.Object({ stagingId: Type.String() }),
		async execute(_id, p, _signal, _update, ctx) {
			const s = staged(p.stagingId);
			if (!(await confirmUser(ctx, `Discard "${s.bundle.meta.name}"?`, "The staged copy and its trial runs are deleted; the bundle file itself is kept."))) return text("Not discarded.", { discarded: false });
			discardStaged(s.id);
			return text(`Discarded ${s.id}.`, { discarded: true });
		},
	});

}

export const SHARING_TOOLS = ["export_agent", "stage_shared_agent", "review_shared_agent", "set_shared_agent_values", "edit_shared_agent", "check_shared_agent", "trial_run_shared_agent", "add_shared_agent", "discard_shared_agent"];
