/**
 * Workflow diagram model for an agent: every component as a node with its kind (trigger,
 * deterministic shell step, TypeSafe decide step, LLM step, agent call, end, chained agent) and
 * every transition as an edge (implicit order, `next`, or a `route` rule with its condition).
 * The web UI draws it as an SVG and lights nodes up as a run executes; `toMermaid` gives the
 * same graph as text for the CLI and docs.
 */
import type { AgentDefinition } from "./store.js";
import type { Step } from "./workflow.js";

export type NodeKind = "trigger" | "shell" | "decide" | "llm" | "call" | "end" | "chain";

export interface DiagramNode {
	id: string;
	kind: NodeKind;
	label: string;
	detail?: string;
	/** Extra badges, e.g. "⚡ TypeSafe gate" on LLM steps. */
	badges?: string[];
}

export interface DiagramEdge {
	from: string;
	to: string;
	label?: string;
	kind: "flow" | "route" | "default" | "chain";
}

export interface Diagram {
	nodes: DiagramNode[];
	edges: DiagramEdge[];
	/** Which component kinds appear, for the legend. */
	kinds: NodeKind[];
}

export const KIND_LABEL: Record<NodeKind, string> = {
	trigger: "trigger",
	shell: "deterministic code",
	decide: "TypeSafe decision",
	llm: "LLM",
	call: "agent call",
	end: "end",
	chain: "chained agent",
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

type NamedStep = Step & { id: string };

function stepNode(s: NamedStep, agent: AgentDefinition): DiagramNode {
	switch (s.type) {
		case "shell":
			return { id: s.id, kind: "shell", label: s.id, detail: clip(s.run.replace(/\s+/g, " "), 70) };
		case "decide": {
			const qs = Object.entries(s.questions ?? {}).map(([k, q]) => `${k}:${(q as { type: string }).type}`);
			const badges: string[] = [];
			for (const q of Object.values(s.questions ?? {})) if ((q as { optionsFrom?: string }).optionsFrom) badges.push(`options rebuilt from ${(q as { optionsFrom?: string }).optionsFrom}`);
			if (s.forEach) badges.push(`scores each of ${s.forEach.from}${s.forEach.top ? ` → top ${s.forEach.top}` : ""}`);
			return { id: s.id, kind: "decide", label: s.id, detail: clip([...qs, ...(s.forEach ? [`each:${s.forEach.question.type}`] : [])].join(" · "), 70), badges: badges.length ? badges : undefined };
		}
		case "llm":
			return { id: s.id, kind: "llm", label: s.id, detail: clip((s.prompt ?? "").replace(/\s+/g, " "), 70), badges: [`⚡ TypeSafe gate (${agent.reflex ?? "balanced"})`, ...(s.tools?.length ? [`tools: ${s.tools.join(",")}`] : [])] };
		case "call":
			return { id: s.id, kind: "call", label: s.id, detail: `→ agent ${s.agentId}` };
		case "end":
			return { id: s.id, kind: "end", label: s.id, detail: s.output ? clip(String(s.output).replace(/\s+/g, " "), 60) : undefined };
	}
}

export function agentDiagram(agent: AgentDefinition): Diagram {
	const nodes: DiagramNode[] = [];
	const edges: DiagramEdge[] = [];
	const triggers = agent.triggers?.length ? agent.triggers : [{ type: "manual" as const }];
	triggers.forEach((t, i) => {
		const id = `trigger:${i}`;
		if (t.type === "cron") nodes.push({ id, kind: "trigger", label: "⏰ cron", detail: `${t.schedule}${t.input ? ` · input: ${clip(t.input, 30)}` : ""}` });
		else if (t.type === "webhook") nodes.push({ id, kind: "trigger", label: "🔗 webhook", detail: `POST /hooks/${agent.id}/…` });
		else nodes.push({ id, kind: "trigger", label: "▶ manual", detail: "run now / reflex agent run" });
	});
	const triggerIds = nodes.map((n) => n.id);

	const steps = (agent.steps ?? []).map((s, i) => ({ ...s, id: s.id || `step${i + 1}` })) as NamedStep[];
	let firstId: string;
	let terminals: string[] = [];
	if (steps.length) {
		const ids = new Set(steps.map((s) => s.id));
		for (const s of steps) nodes.push(stepNode(s, agent));
		firstId = steps[0].id;
		let implicitEnd = false;
		steps.forEach((s, i) => {
			if (s.type === "end") {
				terminals.push(s.id);
				return;
			}
			const targets: DiagramEdge[] = [];
			if (s.route?.length) {
				for (const r of s.route) targets.push({ from: s.id, to: r.next, label: r.when === "default" ? "otherwise" : r.when, kind: r.when === "default" ? "default" : "route" });
			} else if (s.next) targets.push({ from: s.id, to: s.next, kind: "flow" });
			else targets.push({ from: s.id, to: steps[i + 1]?.id ?? "__end", kind: "flow" });
			for (const e of targets) {
				if (e.to === "end" && !ids.has("end")) e.to = "__end";
				if (e.to === "__end") implicitEnd = true;
				else if (!ids.has(e.to)) {
					nodes.push({ id: e.to, kind: "end", label: e.to, detail: "unknown step" });
					ids.add(e.to);
				}
				edges.push(e);
			}
		});
		if (implicitEnd) {
			nodes.push({ id: "__end", kind: "end", label: "end" });
			terminals.push("__end");
		}
	} else {
		firstId = "prompt";
		nodes.push({ id: "prompt", kind: "llm", label: "Reflex session", detail: clip((agent.prompt ?? "").replace(/\s+/g, " "), 70), badges: [`⚡ TypeSafe gate (${agent.reflex ?? "balanced"})`, "⚡ monitor + completion check", ...(agent.tools?.length ? [`tools: ${agent.tools.join(",")}`] : [])] });
		nodes.push({ id: "__end", kind: "end", label: "end", detail: "output → chain" });
		edges.push({ from: "prompt", to: "__end", kind: "flow" });
		terminals = ["__end"];
	}
	for (const t of triggerIds) edges.push({ from: t, to: firstId, kind: "flow" });

	(agent.chain ?? []).forEach((c, i) => {
		const id = `chain:${i}`;
		nodes.push({ id, kind: "chain", label: `→ ${c.agentId}`, detail: c.input ? `input: ${clip(c.input.replace(/\s+/g, " "), 50)}` : "input: {{output}}" });
		for (const t of terminals) edges.push({ from: t, to: id, label: "on success", kind: "chain" });
	});

	const kinds = [...new Set(nodes.map((n) => n.kind))];
	return { nodes, edges, kinds };
}

const MERMAID_CLASS: Record<NodeKind, string> = { trigger: "trigger", shell: "shell", decide: "decide", llm: "llm", call: "call", end: "endn", chain: "chain" };

/** Mermaid flowchart with one class per component kind (same palette as the web UI). */
export function toMermaid(d: Diagram): string {
	const q = (s: string) => s.replace(/"/g, "'");
	const nid = (id: string) => `n_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;
	const lines = ["flowchart TD"];
	for (const n of d.nodes) {
		const text = q(n.detail ? `${n.label}\\n${n.detail}` : n.label);
		const shape = n.kind === "decide" ? `{"${text}"}` : n.kind === "trigger" ? `(["${text}"])` : n.kind === "end" ? `(("${text}"))` : `["${text}"]`;
		lines.push(`  ${nid(n.id)}${shape}:::${MERMAID_CLASS[n.kind]}`);
	}
	for (const e of d.edges) lines.push(`  ${nid(e.from)} ${e.kind === "chain" ? "-.->" : "-->"}${e.label ? `|"${q(e.label)}"|` : ""} ${nid(e.to)}`);
	lines.push(
		"  classDef trigger fill:#fefefe,stroke:#1e1e1e,color:#1e1e1e",
		"  classDef shell fill:#03aa5c,stroke:#1e1e1e,color:#fefefe",
		"  classDef decide fill:#f386a1,stroke:#1e1e1e,color:#1e1e1e",
		"  classDef llm fill:#d45bb6,stroke:#1e1e1e,color:#fefefe",
		"  classDef call fill:#09aea1,stroke:#1e1e1e,color:#fefefe",
		"  classDef endn fill:#1e1e1e,stroke:#1e1e1e,color:#fefefe",
		"  classDef chain fill:#fefefe,stroke:#09aea1,stroke-dasharray:4 3,color:#1e1e1e",
	);
	return lines.join("\n");
}
