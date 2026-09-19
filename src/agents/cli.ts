/**
 * `reflex agent …` subcommands for humans and for the coding agent building agents.
 */
import { describeCron } from "./cron.js";
import { runAgent } from "./runner.js";
import { deleteAgent, listAgents, listRuns, loadAgent, saveAgent } from "./store.js";

export async function runAgentCli(args: string[]): Promise<void> {
	const [sub, ...rest] = args;
	const flag = (name: string) => {
		const i = rest.indexOf(name);
		return i >= 0 ? rest[i + 1] : undefined;
	};
	switch (sub) {
		case "list": {
			const agents = listAgents();
			if (!agents.length) return console.log("no agents yet — create one in `reflex web` → Agents, or ask the coding agent (skill: reflex-agents)");
			for (const a of agents) {
				const runs = listRuns(a.id, 1);
				const trig = a.triggers.map((t) => (t.type === "cron" ? `cron ${t.schedule} (${describeCron(t.schedule)})` : t.type === "webhook" ? "webhook" : "manual")).join(", ");
				console.log(`${a.enabled ? "●" : "○"} ${a.id.padEnd(24)} ${a.name}  [${trig}]${runs[0] ? `  last: ${runs[0].status} ${new Date(runs[0].startedAt).toLocaleString()}` : ""}`);
			}
			return;
		}
		case "run": {
			const id = rest[0];
			const agent = id && loadAgent(id);
			if (!agent) throw new Error(`unknown agent "${id}". reflex agent list`);
			const input = flag("--input");
			console.log(`▶ running ${agent.name} …`);
			const run = await runAgent(agent, { type: "manual" }, input, (_r, ev) => {
				const e = ev as { type?: string; toolName?: string; args?: Record<string, unknown> };
				if (e.type === "tool_execution_start") console.log(`  ↳ ${e.toolName} ${JSON.stringify(e.args ?? {}).slice(0, 100)}`);
			});
			console.log(`\n${run.status === "succeeded" ? "✓" : "✗"} ${run.status} · run ${run.id} · ${run.toolCalls} tool calls · ${run.reflexBlocks} reflex blocks · ${((run.endedAt ?? Date.now()) - run.startedAt) / 1000}s`);
			if (run.output) console.log(`\n${run.output}`);
			if (run.error) console.log(`\nerror: ${run.error}`);
			process.exitCode = run.status === "succeeded" ? 0 : 1;
			return;
		}
		case "runs": {
			const id = rest[0];
			if (!id) throw new Error("usage: reflex agent runs <id>");
			for (const r of listRuns(id, 20)) console.log(`${r.status.padEnd(9)} ${r.id}  ${new Date(r.startedAt).toLocaleString()}  ${r.trigger.type}${r.trigger.from ? ` ← ${r.trigger.from}` : ""}  ${r.toolCalls} tools${r.output ? `  · ${r.output.split("\n")[0].slice(0, 60)}` : ""}`);
			return;
		}
		case "create": {
			const name = flag("--name");
			const prompt = flag("--prompt");
			if (!name || !prompt) throw new Error('usage: reflex agent create --name "…" --prompt "…" [--cwd dir] [--cron "0 9 * * 1-5"] [--webhook] [--model provider/id] [--reflex balanced] [--instructions "…"]');
			const triggers: Parameters<typeof saveAgent>[0]["triggers"] = [{ type: "manual" }];
			const cron = flag("--cron");
			if (cron) triggers.push({ type: "cron", schedule: cron });
			if (rest.includes("--webhook")) triggers.push({ type: "webhook", secret: "" });
			const a = saveAgent({ name, prompt, cwd: flag("--cwd") ?? process.cwd(), model: flag("--model"), reflex: flag("--reflex") as never, instructions: flag("--instructions"), triggers });
			console.log(`created ${a.id} → ~/.reflex/agents/${a.id}/agent.json`);
			for (const t of a.triggers) if (t.type === "webhook") console.log(`webhook: POST http://127.0.0.1:7331/hooks/${a.id}/${t.secret}`);
			return;
		}
		case "diagram": {
			if (!rest[0]) throw new Error("usage: reflex agent diagram <id>   (prints a Mermaid flowchart: trigger → shell / TypeSafe decide / LLM / call → end → chain)");
			const { loadAgent: load } = await import("./store.js");
			const a = load(rest[0]);
			if (!a) throw new Error(`unknown agent ${rest[0]}`);
			const { agentDiagram, toMermaid } = await import("./diagram.js");
			console.log(toMermaid(agentDiagram(a)));
			return;
		}
		case "delete": {
			if (!rest[0]) throw new Error("usage: reflex agent delete <id>");
			deleteAgent(rest[0]);
			console.log(`deleted ${rest[0]}`);
			return;
		}
		default:
			console.log(`reflex agent list | run <id> [--input text] | runs <id> | create --name … --prompt … [--cron … | --webhook] | delete <id>`);
	}
}
