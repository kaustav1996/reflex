/**
 * Agent-management tools for chat sessions.
 *
 * Lets the LLM create, list, run, and delete scheduled/webhook agents from any
 * Reflex session (terminal or web), so you can say "create an agent that runs
 * the tests every weekday at 9" and it just works — no need to open the Agents
 * tab and fill the form by hand.
 *
 *   list_agents      – list all agents (with live run counts)
 *   create_agent     – create (or update) an agent from a natural-language spec
 *   run_agent        – trigger a manual run of an existing agent
 *   delete_agent     – delete an agent
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseCron } from "../../agents/cron.js";
import { deleteAgent, listAgents, loadAgent, saveAgent } from "../../agents/store.js";
import { liveRunsForAgent, runAgent } from "../../agents/runner.js";

function resolveCwd(cwd: string | undefined): string {
	if (!cwd) return process.cwd();
	return resolve(cwd.replace(/^~(?=$|\/)/, homedir()));
}

export function createAgentsExtension(): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.registerTool({
			name: "list_agents",
			label: "List agents",
			description:
				"List all scheduled / webhook Reflex agents in this workspace, with their id, name, triggers, enabled state, and how many runs are currently live. Use before creating or running an agent so you don't duplicate one.",
			promptSnippet: "List all Reflex agents (scheduled/webhook jobs)",
			parameters: Type.Object({}),
			async execute() {
				const agents = listAgents().map((a) => {
					const trigs = a.triggers.filter((t) => t.type !== "manual");
					return `${a.id} — ${a.name} [${a.enabled ? "enabled" : "disabled"}]${trigs.length ? ` · ${trigs.map((t) => (t.type === "cron" ? `cron:${t.schedule}` : "webhook")).join(", ")}` : " · manual"} · ${liveRunsForAgent(a.id).length} running · cwd ${a.cwd}`;
				});
				const text = agents.length ? agents.join("\n") : "No agents yet.";
				return { content: [{ type: "text", text }], details: { count: agents.length } };
			},
			renderResult(_r, _o, theme) {
				return new Text(theme.fg("success", "✓ agents listed"), 0, 0);
			},
		});

		pi.registerTool({
			name: "create_agent",
			label: "Create agent",
			description:
				"Create (or update) a scheduled or webhook Reflex agent from a natural-language spec. The agent runs headless `reflex` processes: the prompt runs each time a trigger fires. Set a cron schedule for recurring jobs, or a webhook trigger for event-driven ones. Manual is always available. Returns the new agent's id and webhook URL if any.",
			promptSnippet: "Create or update a scheduled/webhook Reflex agent",
			promptGuidelines: [
				"Prefer create_agent over asking the user to fill the Agents form. Fill in a clear prompt that describes exactly what the agent should do each run.",
				"If the user asks for 'every weekday at 9' use cron with schedule '0 9 * * 1-5'. For a webhook trigger, set triggers to [{type:'webhook'}]; a secret URL is generated on save.",
				"Set cwd to the project the agent should work in (default: the current session's cwd). Don't set tools unless the user asked for a restricted/read-only agent.",
			],
			parameters: Type.Object({
				steps: Type.Optional(Type.String({ description: "Workflow steps as a JSON array (preferred over a bare prompt): shell → decide → llm priority. See skill reflex-agents for the schema." })),
				name: Type.String({ description: "Agent name (human-readable, e.g. 'Nightly test report')" }),
				prompt: Type.String({ description: "What to do each run. {{input}} = trigger payload, {{now}} = timestamp" }),
				cwd: Type.Optional(Type.String({ description: "Working directory for runs (default: current cwd)" })),
				description: Type.Optional(Type.String({ description: "Short description of the agent" })),
				cronSchedule: Type.Optional(Type.String({ description: "5-field cron or @daily/@hourly/@weekly/@weekdays, e.g. '0 9 * * 1-5'. Omit for manual/webhook only." })),
				webhook: Type.Optional(Type.Boolean({ description: "Add a webhook trigger (generates a secret URL on save)" })),
				model: Type.Optional(Type.String({ description: "Pi model ref like 'openrouter/anthropic/claude-sonnet-4.6' (default: user's default model)" })),
				reflex: Type.Optional(StringEnum(["cautious", "balanced", "bold", "off"] as const)),
				tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist, e.g. 'read,grep,find,ls' for read-only. Omit for all tools." })),
				timeoutMinutes: Type.Optional(Type.Number({ description: "Run timeout in minutes (default 30)" })),
			}),
			async execute(_id, p) {
				const triggers: Array<{ type: "manual" } | { type: "cron"; schedule: string; input?: string } | { type: "webhook"; secret: string }> = [{ type: "manual" }];
				if (p.cronSchedule) {
					try {
						parseCron(p.cronSchedule);
					} catch (err) {
						throw new Error(`Invalid cron schedule '${p.cronSchedule}': ${err instanceof Error ? err.message : String(err)}`);
					}
					triggers.push({ type: "cron", schedule: p.cronSchedule });
				}
				if (p.webhook) triggers.push({ type: "webhook", secret: "" });
				const tools = p.tools ? String(p.tools).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
				const agent = saveAgent({
					steps: p.steps ? (JSON.parse(p.steps) as never) : undefined,
					name: p.name.trim(),
					description: p.description?.trim(),
					cwd: resolveCwd(p.cwd),
					prompt: p.prompt,
					model: p.model?.trim() || undefined,
					reflex: p.reflex,
					tools,
					timeoutMinutes: p.timeoutMinutes ? Number(p.timeoutMinutes) : undefined,
					triggers,
					enabled: true,
				});
				const hook = agent.triggers.find((t) => t.type === "webhook");
				const lines = [
					`Created agent ${agent.id} — ${agent.name}`,
					`cwd: ${agent.cwd}`,
					`triggers: ${agent.triggers.map((t) => t.type).join(", ")}`,
					hook ? `webhook: POST http://127.0.0.1:${process.env.REFLEX_WEB_PORT ?? 7331}/hooks/${agent.id}/${(hook as { secret: string }).secret}` : "",
				].filter(Boolean);
				return { content: [{ type: "text", text: lines.join("\n") }], details: { id: agent.id, name: agent.name } };
			},
			renderCall(args, theme) {
				const a = args as { name?: string };
				return new Text(`${theme.fg("toolTitle", theme.bold("create_agent "))}${theme.fg("accent", a.name ?? "")}`, 0, 0);
			},
			renderResult(result, _o, theme) {
				const d = (result.details ?? {}) as { id?: string; name?: string };
				return new Text(theme.fg("success", `✓ agent ${d.id ?? ""} created`), 0, 0);
			},
		});

		pi.registerTool({
			name: "run_agent",
			label: "Run agent",
			description:
				"Trigger a manual run of an existing Reflex agent by id or name, with optional input text (passed as {{input}}). Returns the run id; the run executes headless and its output is logged. Use list_agents first to find the id.",
			promptSnippet: "Run a Reflex agent now (manual trigger)",
			parameters: Type.Object({
				agentId: Type.String({ description: "Agent id or name (from list_agents)" }),
				input: Type.Optional(Type.String({ description: "Text passed to the prompt as {{input}}" })),
			}),
			async execute(_id, p) {
				const byId = listAgents().find((a) => a.id === p.agentId || a.name === p.agentId);
				if (!byId) throw new Error(`No agent with id or name '${p.agentId}'. Call list_agents to see them.`);
				const run = await runAgent(byId, { type: "manual" }, p.input);
				return { content: [{ type: "text", text: `Started run ${run.id} for ${byId.name} (${run.status}).${run.output ? ` Output: ${run.output.slice(0, 200)}` : ""}` }], details: { runId: run.id, agentId: byId.id, status: run.status } };
			},
			renderCall(args, theme) {
				const a = args as { agentId?: string };
				return new Text(`${theme.fg("toolTitle", theme.bold("run_agent "))}${theme.fg("accent", a.agentId ?? "")}`, 0, 0);
			},
		});

		pi.registerTool({
			name: "delete_agent",
			label: "Delete agent",
			description: "Delete a Reflex agent by id (cancels any live runs). Irreversible — confirm with the user first.",
			promptSnippet: "Delete a Reflex agent",
			parameters: Type.Object({
				agentId: Type.String({ description: "Agent id to delete (from list_agents)" }),
			}),
			async execute(_id, p) {
				const a = loadAgent(p.agentId);
				if (!a) throw new Error(`No agent with id '${p.agentId}'.`);
				deleteAgent(a.id);
				return { content: [{ type: "text", text: `Deleted agent ${a.id} — ${a.name}.` }], details: { id: a.id } };
			},
			renderCall(args, theme) {
				const a = args as { agentId?: string };
				return new Text(`${theme.fg("toolTitle", theme.bold("delete_agent "))}${theme.fg("error", a.agentId ?? "")}`, 0, 0);
			},
		});
	};
}
